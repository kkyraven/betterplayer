use std::sync::{Arc, Mutex, MutexGuard};

use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL, HANDLE, S_OK};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_FENCE_FLAG_SHARED, D3D11_RESOURCE_MISC_SHARED, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Device5, ID3D11DeviceContext4, ID3D11Fence, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R10G10B10A2_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource};
use windows::core::{Interface, PCWSTR};

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
    fences: Option<[usize; 2]>,
    slots: [Slot; 2],
    sizes: [(u32, u32); 2],
    drawn: [u64; 2],
    read: [u64; 2],
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

    fn newest(&self, after: u64, done: impl Fn(usize) -> bool) -> Option<usize> {
        (0..2).filter_map(|i| match self.slots[i] {
            Slot::Ready(n) if n > after && done(i) => Some((i, n)),
            _ => None,
        }).max_by_key(|&(_, n)| n).map(|(i, _)| i)
    }
}

fn ring(r: &Mutex<Ring>) -> MutexGuard<'_, Ring> {
    r.lock().unwrap_or_else(|e| e.into_inner())
}

struct Fences {
    drawn: ID3D11Fence,
    read: ID3D11Fence,
    context: ID3D11DeviceContext4,
    signalled: u64,
}

impl Fences {
    fn create(device: &ID3D11Device) -> Option<(Fences, [usize; 2])> {
        let made = (|| -> windows::core::Result<_> {
            let device5: ID3D11Device5 = device.cast()?;
            let context: ID3D11DeviceContext4 = unsafe { device.GetImmediateContext()? }.cast()?;
            let fence = || -> windows::core::Result<ID3D11Fence> {
                let mut fence = None;
                unsafe { device5.CreateFence(0, D3D11_FENCE_FLAG_SHARED, &mut fence)? };
                fence.ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))
            };
            let (drawn, read) = (fence()?, fence()?);
            let share = |f: &ID3D11Fence| unsafe { f.CreateSharedHandle(None, GENERIC_ALL.0, PCWSTR::null()) };
            let a = share(&drawn)?;
            let b = share(&read).inspect_err(|_| unsafe {
                let _ = CloseHandle(a);
            })?;
            Ok((Fences { drawn, read, context, signalled: 0 }, [a.0 as usize, b.0 as usize]))
        })();
        made.inspect_err(|e| eprintln!("bp-player: the headset's video has no shared fences, so keyed mutexes ({e})")).ok()
    }

    fn open(device: &ID3D11Device, [drawn, read]: [usize; 2]) -> Result<Fences, String> {
        let opened = (|| -> windows::core::Result<_> {
            let device5: ID3D11Device5 = device.cast()?;
            let context: ID3D11DeviceContext4 = unsafe { device.GetImmediateContext()? }.cast()?;
            let open = |h: usize| -> windows::core::Result<ID3D11Fence> {
                let mut fence = None;
                unsafe { device5.OpenSharedFence(HANDLE(h as *mut _), &mut fence)? };
                fence.ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))
            };
            Ok(Fences { drawn: open(drawn)?, read: open(read)?, context, signalled: 0 })
        })();
        opened.map_err(|e| format!("headset video fences: {e}"))
    }

    fn signal(&mut self, read: bool) -> Result<u64, String> {
        self.signalled += 1;
        let fence = if read { &self.read } else { &self.drawn };
        unsafe {
            self.context.Signal(fence, self.signalled).map_err(|e| format!("headset video fence: {e}"))?;
            self.context.Flush();
        }
        Ok(self.signalled)
    }
}

struct Shared {
    image: D3dImage,
    mutex: Option<IDXGIKeyedMutex>,
    _tex: ID3D11Texture2D,
}

impl Shared {
    fn new(angle: &Context, tex: ID3D11Texture2D, keyed: bool) -> Result<Shared, String> {
        let mutex = keyed.then(|| tex.cast::<IDXGIKeyedMutex>()).transpose().map_err(|e| format!("headset video keyed mutex: {e}"))?;
        Ok(Shared { image: angle.wrap_d3d11(&tex)?, mutex, _tex: tex })
    }

    fn with<T>(&self, ms: u32, gl: impl FnOnce(&D3dImage) -> T) -> Result<Option<T>, String> {
        let Some(mutex) = &self.mutex else {
            let out = gl(&self.image);
            unsafe { gl::Flush() };
            return Ok(Some(out));
        };
        let hr = unsafe { (Interface::vtable(mutex).AcquireSync)(Interface::as_raw(mutex), 0, ms) };
        if hr.0 == WAIT_TIMEOUT && ms < SYNC_MS {
            return Ok(None);
        }
        if hr != S_OK {
            return Err(format!("headset video keyed mutex: 0x{:x}", hr.0));
        }
        let out = gl(&self.image);
        unsafe {
            gl::Flush();
            let _ = (Interface::vtable(mutex).ReleaseSync)(Interface::as_raw(mutex), 0);
        }
        Ok(Some(out))
    }
}

pub(crate) struct Outbox {
    ring: Arc<Mutex<Ring>>,
    textures: Vec<Shared>,
    capacity: (u32, u32),
    fences: Option<Fences>,
    keyed: Option<bool>,
}

impl Outbox {
    pub fn new() -> Outbox {
        let ring = Ring { generation: 0, handles: Vec::new(), fences: None, slots: [Slot::Free; 2], sizes: [(0, 0); 2], drawn: [0; 2], read: [0; 2], serial: 0 };
        Outbox { ring: Arc::new(Mutex::new(ring)), textures: Vec::new(), capacity: (0, 0), fences: None, keyed: None }
    }

    pub fn handoff(&self) -> Handoff {
        Handoff(self.ring.clone())
    }

    pub fn send(&mut self, angle: &Context, (w, h): (u32, u32), draw: impl FnOnce(u32) -> bool) -> Result<bool, String> {
        if w > self.capacity.0 || h > self.capacity.1 {
            self.remake(angle, (w.max(self.capacity.0), h.max(self.capacity.1)))?;
        }
        let (i, read) = {
            let mut r = ring(&self.ring);
            let Some(i) = r.writable() else { return Err("no headset video texture free".into()) };
            r.slots[i] = Slot::Writing;
            (i, r.read[i])
        };
        let (textures, fences) = (&self.textures, &mut self.fences);
        let drew = (|| {
            if let Some(f) = fences.as_ref().filter(|_| read > 0) {
                unsafe { f.context.Wait(&f.read, read) }.map_err(|e| format!("headset video fence: {e}"))?;
            }
            let drew = textures[i].with(SYNC_MS, |image| draw(image.fbo))?.ok_or("headset video keyed mutex: timed out")?;
            let drawn = match fences {
                Some(f) if drew => f.signal(false)?,
                _ => 0,
            };
            Ok((drew, drawn))
        })();
        let mut r = ring(&self.ring);
        r.slots[i] = match drew {
            Ok((true, drawn)) => {
                r.serial += 1;
                r.sizes[i] = (w, h);
                r.drawn[i] = drawn;
                Slot::Ready(r.serial)
            }
            _ => Slot::Free,
        };
        drew.map(|(drew, _)| drew)
    }

    fn remake(&mut self, angle: &Context, (w, h): (u32, u32)) -> Result<(), String> {
        self.textures.clear();
        self.capacity = (0, 0);
        if self.keyed.is_none() {
            let made = Fences::create(angle.d3d11());
            self.keyed = Some(made.is_none());
            if let Some((fences, handles)) = made {
                self.fences = Some(fences);
                ring(&self.ring).fences = Some(handles);
            }
        }
        let keyed = self.keyed == Some(true);
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
            MiscFlags: if keyed { D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0 } else { D3D11_RESOURCE_MISC_SHARED.0 } as u32,
        };
        let mut handles = Vec::new();
        for _ in 0..2 {
            let mut tex = None;
            unsafe { angle.d3d11().CreateTexture2D(&desc, None, Some(&mut tex)) }.map_err(|e| format!("headset video texture {w}x{h}: {e}"))?;
            let tex = tex.ok_or("headset video texture: none returned")?;
            let handle = unsafe { tex.cast::<IDXGIResource>().and_then(|r| r.GetSharedHandle()) }.map_err(|e| format!("headset video share: {e}"))?;
            handles.push(handle.0 as usize);
            self.textures.push(Shared::new(angle, tex, keyed)?);
        }
        self.capacity = (w, h);
        let mut r = ring(&self.ring);
        r.generation += 1;
        r.handles = handles;
        r.slots = [Slot::Free; 2];
        (r.drawn, r.read) = ([0; 2], [0; 2]);
        Ok(())
    }
}

impl Drop for Outbox {
    fn drop(&mut self) {
        for h in ring(&self.ring).fences.take().into_iter().flatten() {
            unsafe {
                let _ = CloseHandle(HANDLE(h as *mut _));
            }
        }
    }
}

pub(crate) struct Handoff(Arc<Mutex<Ring>>);

pub(crate) struct Inbox {
    ring: Arc<Mutex<Ring>>,
    generation: u64,
    textures: Vec<Shared>,
    fences: Option<Fences>,
    copied: u64,
}

impl Inbox {
    pub fn new(handoff: Handoff) -> Inbox {
        Inbox { ring: handoff.0, generation: 0, textures: Vec::new(), fences: None, copied: 0 }
    }

    pub fn take(&mut self, angle: &Context, copy: impl FnOnce((u32, u32), u32)) -> Result<bool, String> {
        let (i, generation, size, n) = {
            let mut r = ring(&self.ring);
            if r.newest(if r.generation == self.generation { self.copied } else { 0 }, |_| true).is_none() {
                return Ok(false);
            }
            if r.generation != self.generation {
                let (generation, handles, fences) = (r.generation, r.handles.clone(), r.fences);
                drop(r);
                self.open(angle, generation, &handles, fences)?;
                r = ring(&self.ring);
                if r.generation != generation {
                    return Ok(false);
                }
            }
            let drawn = self.fences.as_ref().map(|f| unsafe { f.drawn.GetCompletedValue() });
            let Some(i) = r.newest(self.copied, |i| drawn.is_none_or(|d| d >= r.drawn[i])) else { return Ok(false) };
            let Slot::Ready(n) = r.slots[i] else { return Ok(false) };
            r.slots[i] = Slot::Reading;
            (i, r.generation, r.sizes[i], n)
        };
        let done = self.textures[i].with(0, |image| copy(size, image.fbo));
        let read = match (&mut self.fences, &done) {
            (Some(f), Ok(Some(()))) => Some(f.signal(true)),
            _ => None,
        };
        let mut r = ring(&self.ring);
        if r.generation == generation && r.slots[i] == Slot::Reading {
            r.slots[i] = if matches!(done, Ok(None)) { Slot::Ready(n) } else { Slot::Free };
            if let Some(Ok(v)) = read {
                r.read[i] = v;
            }
        }
        if matches!(done, Ok(Some(()))) {
            self.copied = n;
        }
        if let Some(Err(e)) = read {
            return Err(e);
        }
        done.map(|d| d.is_some())
    }

    fn open(&mut self, angle: &Context, generation: u64, handles: &[usize], fences: Option<[usize; 2]>) -> Result<(), String> {
        self.textures.clear();
        self.generation = 0;
        if let (None, Some(f)) = (&self.fences, fences) {
            self.fences = Some(Fences::open(angle.d3d11(), f)?);
        }
        for &h in handles {
            let mut tex: Option<ID3D11Texture2D> = None;
            unsafe { angle.d3d11().OpenSharedResource(HANDLE(h as *mut _), &mut tex) }.map_err(|e| format!("headset video open: {e}"))?;
            self.textures.push(Shared::new(angle, tex.ok_or("headset video open: none returned")?, fences.is_none())?);
        }
        (self.generation, self.copied) = (generation, 0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(slots: [Slot; 2]) -> Ring {
        Ring { generation: 1, handles: Vec::new(), fences: None, slots, sizes: [(8, 8); 2], drawn: [0; 2], read: [0; 2], serial: 9 }
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
        for keyed in [false, true] {
            hand_over(keyed);
        }
    }

    fn hand_over(keyed: bool) {
        use crate::gl_context::GlContext;
        use std::ffi::CString;
        let render = GlContext::new().unwrap();
        gl::load_with(|name| render.get_proc_address(&CString::new(name).unwrap()) as *const _);
        let mut out = Outbox::new();
        if keyed {
            out.keyed = Some(true);
        }
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
                let mut tries = 0;
                let (taken, got) = loop {
                    let gpu = gl.gpu().section();
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
                    tries += 1;
                    if taken.as_ref().is_ok_and(|&t| !t) && tries < 50 {
                        drop(gpu);
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        continue;
                    }
                    break (taken.unwrap(), got);
                };
                answers.send((taken, got)).unwrap();
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
        assert_eq!(out.fences.is_none(), keyed);
        asks.send(()).unwrap();
        assert_eq!(answer.recv().unwrap(), (true, Some(((32, 16), [0, 0, 255, 255]))));
        drop(asks);
        headset.join().unwrap();
    }

    #[test]
    fn the_headset_takes_the_newest_drawn_picture_newer_than_it_has() {
        let all = |_| true;
        assert_eq!(ring([Slot::Ready(4), Slot::Ready(6)]).newest(0, all), Some(1));
        assert_eq!(ring([Slot::Ready(4), Slot::Ready(6)]).newest(6, all), None);
        assert_eq!(ring([Slot::Writing, Slot::Free]).newest(0, all), None);
        assert_eq!(ring([Slot::Ready(4), Slot::Ready(6)]).newest(3, |i| i == 0), Some(0));
        assert_eq!(ring([Slot::Ready(4), Slot::Ready(6)]).newest(4, |i| i == 0), None);
    }
}
