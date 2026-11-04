use std::sync::{Arc, Mutex, MutexGuard};

use windows::Win32::Foundation::{HANDLE, S_OK};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R10G10B10A2_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource};
use windows::core::Interface;

use super::egl::{Context, D3dImage};

const SYNC_MS: u32 = 500;
const WAIT_TIMEOUT: i32 = 0x102;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Slot {
    Free,
    Writing,
    Ready(u64),
    Reading,
}

#[derive(Debug)]
struct Ring {
    generation: u64,
    handles: Vec<usize>,
    slots: [Slot; 2],
    sizes: [(u32, u32); 2],
    serial: u64,
}

impl Ring {
    fn writable(&self) -> Option<usize> {
        let ready = |i: usize| match self.slots[i] {
            Slot::Ready(n) => Some(n),
            _ => None,
        };
        (0..2)
            .find(|&i| self.slots[i] == Slot::Free)
            .or_else(|| (0..2).filter(|&i| ready(i).is_some()).min_by_key(|&i| ready(i)))
    }

    fn newest(&self, after: u64) -> Option<usize> {
        (0..2).filter_map(|i| match self.slots[i] {
            Slot::Ready(n) if n > after => Some((i, n)),
            _ => None,
        }).max_by_key(|&(_, n)| n).map(|(i, _)| i)
    }
}

fn ring(r: &Mutex<Ring>) -> MutexGuard<'_, Ring> {
    r.lock().unwrap_or_else(|e| e.into_inner())
}

struct Shared {
    image: D3dImage,
    mutex: IDXGIKeyedMutex,
    _tex: ID3D11Texture2D,
}

impl Shared {
    fn new(angle: &Context, tex: ID3D11Texture2D) -> Result<Shared, String> {
        let mutex = tex.cast::<IDXGIKeyedMutex>().map_err(|e| format!("headset video keyed mutex: {e}"))?;
        Ok(Shared { image: angle.wrap_d3d11(&tex)?, mutex, _tex: tex })
    }

    fn with<T>(&self, ms: u32, gl: impl FnOnce(&D3dImage) -> T) -> Result<Option<T>, String> {
        let hr = unsafe { (Interface::vtable(&self.mutex).AcquireSync)(Interface::as_raw(&self.mutex), 0, ms) };
        if hr.0 == WAIT_TIMEOUT && ms < SYNC_MS {
            return Ok(None);
        }
        if hr != S_OK {
            return Err(format!("headset video keyed mutex: 0x{:x}", hr.0));
        }
        let out = gl(&self.image);
        unsafe {
            gl::Flush();
            let _ = (Interface::vtable(&self.mutex).ReleaseSync)(Interface::as_raw(&self.mutex), 0);
        }
        Ok(Some(out))
    }
}

pub(crate) struct Outbox {
    ring: Arc<Mutex<Ring>>,
    textures: Vec<Shared>,
    capacity: (u32, u32),
}

impl Outbox {
    pub fn new() -> Outbox {
        let ring = Ring { generation: 0, handles: Vec::new(), slots: [Slot::Free; 2], sizes: [(0, 0); 2], serial: 0 };
        Outbox { ring: Arc::new(Mutex::new(ring)), textures: Vec::new(), capacity: (0, 0) }
    }

    pub fn handoff(&self) -> Handoff {
        Handoff(self.ring.clone())
    }

    pub fn send(&mut self, angle: &Context, (w, h): (u32, u32), draw: impl FnOnce(u32) -> bool) -> Result<bool, String> {
        if w > self.capacity.0 || h > self.capacity.1 {
            self.remake(angle, (w.max(self.capacity.0), h.max(self.capacity.1)))?;
        }
        let i = {
            let mut r = ring(&self.ring);
            let Some(i) = r.writable() else { return Err("no headset video texture free".into()) };
            r.slots[i] = Slot::Writing;
            i
        };
        let drew = self.textures[i].with(SYNC_MS, |image| draw(image.fbo)).and_then(|d| d.ok_or_else(|| "headset video keyed mutex: timed out".into()));
        let mut r = ring(&self.ring);
        r.slots[i] = match drew {
            Ok(true) => {
                r.serial += 1;
                r.sizes[i] = (w, h);
                Slot::Ready(r.serial)
            }
            _ => Slot::Free,
        };
        drew
    }

    fn remake(&mut self, angle: &Context, (w, h): (u32, u32)) -> Result<(), String> {
        self.textures.clear();
        self.capacity = (0, 0);
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R10G10B10A2_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0 as u32,
        };
        let mut handles = Vec::new();
        for _ in 0..2 {
            let mut tex = None;
            unsafe { angle.d3d11().CreateTexture2D(&desc, None, Some(&mut tex)) }.map_err(|e| format!("headset video texture {w}x{h}: {e}"))?;
            let tex = tex.ok_or("headset video texture: none returned")?;
            let handle = unsafe { tex.cast::<IDXGIResource>().and_then(|r| r.GetSharedHandle()) }.map_err(|e| format!("headset video share: {e}"))?;
            handles.push(handle.0 as usize);
            self.textures.push(Shared::new(angle, tex)?);
        }
        self.capacity = (w, h);
        let mut r = ring(&self.ring);
        r.generation += 1;
        r.handles = handles;
        r.slots = [Slot::Free; 2];
        Ok(())
    }
}

pub(crate) struct Handoff(Arc<Mutex<Ring>>);

pub(crate) struct Inbox {
    ring: Arc<Mutex<Ring>>,
    generation: u64,
    textures: Vec<Shared>,
    copied: u64,
}

impl Inbox {
    pub fn new(handoff: Handoff) -> Inbox {
        Inbox { ring: handoff.0, generation: 0, textures: Vec::new(), copied: 0 }
    }

    pub fn take(&mut self, angle: &Context, copy: impl FnOnce((u32, u32), u32)) -> Result<bool, String> {
        let (i, generation, size, n) = {
            let mut r = ring(&self.ring);
            let Some(i) = r.newest(if r.generation == self.generation { self.copied } else { 0 }) else { return Ok(false) };
            if r.generation != self.generation {
                let (generation, handles) = (r.generation, r.handles.clone());
                drop(r);
                self.open(angle, generation, &handles)?;
                r = ring(&self.ring);
                if r.generation != generation {
                    return Ok(false);
                }
            }
            let Slot::Ready(n) = r.slots[i] else { return Ok(false) };
            r.slots[i] = Slot::Reading;
            (i, r.generation, r.sizes[i], n)
        };
        let done = self.textures[i].with(0, |image| copy(size, image.fbo));
        let mut r = ring(&self.ring);
        if r.generation == generation && r.slots[i] == Slot::Reading {
            r.slots[i] = if matches!(done, Ok(None)) { Slot::Ready(n) } else { Slot::Free };
        }
        if matches!(done, Ok(Some(()))) {
            self.copied = n;
        }
        done.map(|d| d.is_some())
    }

    fn open(&mut self, angle: &Context, generation: u64, handles: &[usize]) -> Result<(), String> {
        self.textures.clear();
        self.generation = 0;
        for &h in handles {
            let mut tex: Option<ID3D11Texture2D> = None;
            unsafe { angle.d3d11().OpenSharedResource(HANDLE(h as *mut _), &mut tex) }.map_err(|e| format!("headset video open: {e}"))?;
            self.textures.push(Shared::new(angle, tex.ok_or("headset video open: none returned")?)?);
        }
        (self.generation, self.copied) = (generation, 0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(slots: [Slot; 2]) -> Ring {
        Ring { generation: 1, handles: Vec::new(), slots, sizes: [(8, 8); 2], serial: 9 }
    }

    #[test]
    fn the_render_thread_never_writes_the_picture_being_read_and_keeps_the_newest() {
        assert_eq!(ring([Slot::Free, Slot::Free]).writable(), Some(0));
        assert_eq!(ring([Slot::Reading, Slot::Free]).writable(), Some(1));
        assert_eq!(ring([Slot::Ready(4), Slot::Ready(3)]).writable(), Some(1));
        assert_eq!(ring([Slot::Ready(4), Slot::Free]).writable(), Some(1));
        assert_eq!(ring([Slot::Reading, Slot::Ready(5)]).writable(), Some(1));
    }

    unsafe fn read_back(w: u32, h: u32, fill: impl FnOnce(u32)) -> [u8; 4] {
        let (mut tex, mut fbo, mut px) = (0, 0, [0u8; 4]);
        unsafe {
            gl::GenTextures(1, &mut tex);
            gl::BindTexture(gl::TEXTURE_2D, tex);
            gl::TexStorage2D(gl::TEXTURE_2D, 1, gl::RGBA8, w as i32, h as i32);
            gl::GenFramebuffers(1, &mut fbo);
            gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
            gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, tex, 0);
            fill(fbo);
            gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
            gl::ReadPixels(1, 1, 1, 1, gl::RGBA, gl::UNSIGNED_BYTE, px.as_mut_ptr().cast());
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            gl::DeleteFramebuffers(1, &fbo);
            gl::DeleteTextures(1, &tex);
        }
        px
    }

    #[test]
    #[ignore = "requires ANGLE: libEGL.dll and libGLESv2.dll on the path"]
    fn a_picture_reaches_the_headsets_device_and_a_smaller_one_keeps_the_textures() {
        use crate::gl_context::GlContext;
        use std::ffi::CString;
        let render = GlContext::new().unwrap();
        gl::load_with(|name| render.get_proc_address(&CString::new(name).unwrap()) as *const _);
        let mut out = Outbox::new();
        let handoff = out.handoff();
        let fill = |(w, h): (u32, u32), [r, g, b]: [f32; 3]| {
            move |fbo: u32| unsafe {
                gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
                gl::Viewport(0, 0, w as i32, h as i32);
                gl::ClearColor(r, g, b, 1.0);
                gl::Clear(gl::COLOR_BUFFER_BIT);
                gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
                true
            }
        };
        let send = |out: &mut Outbox, size: (u32, u32), rgb: [f32; 3]| {
            let _gpu = render.gpu().section();
            assert!(out.send(render.angle(), size, fill(size, rgb)).unwrap());
        };
        send(&mut out, (64, 32), [1.0, 0.0, 0.0]);
        let generation = super::ring(&out.ring).generation;
        let (asks, asked) = std::sync::mpsc::channel::<()>();
        let (answers, answer) = std::sync::mpsc::channel();
        let headset = std::thread::spawn(move || {
            let gl = GlContext::new().unwrap();
            let mut inbox = Inbox::new(handoff);
            while asked.recv().is_ok() {
                let _gpu = gl.gpu().section();
                let mut got = None;
                let taken = inbox.take(gl.angle(), |(w, h), from| {
                    let px = unsafe {
                        read_back(w, h, |to| {
                            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, from);
                            gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, to);
                            gl::BlitFramebuffer(0, 0, w as i32, h as i32, 0, 0, w as i32, h as i32, gl::COLOR_BUFFER_BIT, gl::NEAREST);
                        })
                    };
                    got = Some(((w, h), px));
                });
                answers.send((taken.unwrap(), got)).unwrap();
            }
        });
        asks.send(()).unwrap();
        let (taken, got) = answer.recv().unwrap();
        assert!(taken);
        assert_eq!(got, Some(((64, 32), [255, 0, 0, 255])));
        asks.send(()).unwrap();
        assert_eq!(answer.recv().unwrap(), (false, None));
        send(&mut out, (32, 16), [0.0, 0.0, 1.0]);
        assert_eq!(super::ring(&out.ring).generation, generation, "a smaller picture made new textures");
        asks.send(()).unwrap();
        assert_eq!(answer.recv().unwrap(), (true, Some(((32, 16), [0, 0, 255, 255]))));
        drop(asks);
        headset.join().unwrap();
    }

    #[test]
    fn the_headset_takes_only_a_newer_picture_than_it_has() {
        assert_eq!(ring([Slot::Ready(4), Slot::Ready(6)]).newest(0), Some(1));
        assert_eq!(ring([Slot::Ready(4), Slot::Ready(6)]).newest(6), None);
        assert_eq!(ring([Slot::Writing, Slot::Free]).newest(0), None);
    }
}
