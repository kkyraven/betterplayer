use std::ffi::c_void;
use std::sync::OnceLock;

use libloading::{Library, Symbol};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_FENCE_FLAG_SHARED, D3D11_RESOURCE_MISC_SHARED, D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11CreateDevice, ID3D11Device, ID3D11Device5, ID3D11DeviceContext4, ID3D11Fence, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::core::Interface;

pub const DLL: &str = "NvOFFRUC.dll";
pub const CUDA_DLL: &str = "cudart64_110.dll";

const MAX_RESOURCE: usize = 10;

type Handle = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Status(i32);

impl Status {
    const SUCCESS: Status = Status(0);
    const NOT_SUPPORTED: Status = Status(1);
}

const RESOURCE_DIRECTX11: i32 = 1;
const SURFACE_ARGB: i32 = 1;
const CUDA_RESOURCE_UNDEFINED: i32 = -1;

#[repr(C)]
struct CreateParam {
    width: u32,
    height: u32,
    device: *mut c_void,
    resource_type: i32,
    surface_format: i32,
    cuda_resource_type: i32,
    reserved: [u32; 32],
}

#[repr(C)]
struct FrameData {
    frame: *mut c_void,
    timestamp: f64,
    cuda_pitch: usize,
    repetition: *mut bool,
    reserved: [u32; 32],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Sync {
    fence_value: u64,
    unused: u64,
}

#[repr(C)]
struct ProcessIn {
    input: FrameData,
    flags: u32,
    sync: Sync,
    reserved: [u32; 32],
}

#[repr(C)]
struct ProcessOut {
    output: FrameData,
    sync: Sync,
    reserved: [u32; 32],
}

#[repr(C)]
struct RegisterParam {
    resources: [*mut c_void; MAX_RESOURCE],
    fence: *mut c_void,
    count: u32,
}

type CreateFn = unsafe extern "system" fn(*const CreateParam, *mut Handle) -> Status;
type RegisterFn = unsafe extern "system" fn(Handle, *const RegisterParam) -> Status;
type ProcessFn = unsafe extern "system" fn(Handle, *const ProcessIn, *const ProcessOut) -> Status;
type DestroyFn = unsafe extern "system" fn(Handle) -> Status;

struct Api {
    create: CreateFn,
    register: RegisterFn,
    process: ProcessFn,
    destroy: DestroyFn,
    _lib: Library,
}

impl Api {
    fn resolve(lib: Library) -> Result<Api, String> {
        unsafe fn sym<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
            let s: Symbol<T> = unsafe { lib.get(name) }.map_err(|e| format!("{}: {e}", String::from_utf8_lossy(name)))?;
            Ok(*s)
        }
        unsafe {
            Ok(Api {
                create: sym(&lib, b"NvOFFRUCCreate\0")?,
                register: sym(&lib, b"NvOFFRUCRegisterResource\0")?,
                process: sym(&lib, b"NvOFFRUCProcess\0")?,
                destroy: sym(&lib, b"NvOFFRUCDestroy\0")?,
                _lib: lib,
            })
        }
    }
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| Api::resolve(super::load_dll(DLL)?)).as_ref().map_err(Clone::clone)
}

struct Cuda {
    current: unsafe extern "system" fn(*mut *mut c_void) -> i32,
    destroy: unsafe extern "system" fn(*mut c_void) -> i32,
    _lib: Library,
}

fn cuda() -> Option<&'static Cuda> {
    static CUDA: OnceLock<Option<Cuda>> = OnceLock::new();
    CUDA.get_or_init(|| unsafe {
        let lib = Library::new("nvcuda.dll").ok()?;
        Some(Cuda {
            current: *lib.get(b"cuCtxGetCurrent\0").ok()?,
            destroy: *lib.get(b"cuCtxDestroy_v2\0").ok()?,
            _lib: lib,
        })
    })
    .as_ref()
}

impl Cuda {
    fn current(&self) -> *mut c_void {
        let mut context = std::ptr::null_mut();
        unsafe { (self.current)(&mut context) };
        context
    }
}

pub fn available() -> Result<(), String> {
    api().map(|_| ())
}

pub fn texture(device: &ID3D11Device, (width, height): (u32, u32)) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8G8B8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: (D3D11_RESOURCE_MISC_SHARED.0 | D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0) as u32,
    };
    let mut tex = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex)) }.map_err(|e| format!("frame generation texture {width}x{height}: {e}"))?;
    tex.ok_or_else(|| "frame generation texture: none returned".into())
}

pub fn probe() -> Result<(), String> {
    const SIZE: (u32, u32) = (640, 360);
    let mut device = None;
    unsafe { D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, Default::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, None) }
        .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
    let device = device.ok_or("D3D11CreateDevice returned no device")?;
    let textures = [texture(&device, SIZE)?, texture(&device, SIZE)?, texture(&device, SIZE)?];
    Fruc::new(&device, SIZE.0, SIZE.1, &[&textures[0], &textures[1], &textures[2]]).map(|_| ())
}

pub struct Fruc {
    api: &'static Api,
    handle: Handle,
    cuda_context: *mut c_void,
    fence: ID3D11Fence,
    context: ID3D11DeviceContext4,
    value: u64,
}

impl Fruc {
    pub fn new(device: &ID3D11Device, width: u32, height: u32, textures: &[&ID3D11Texture2D]) -> Result<Fruc, String> {
        let api = api()?;
        if textures.len() > MAX_RESOURCE {
            return Err(format!("NvOFFRUC takes at most {MAX_RESOURCE} textures"));
        }
        let (device5, fence, context) = (|| -> windows::core::Result<_> {
            let device5: ID3D11Device5 = device.cast()?;
            let context: ID3D11DeviceContext4 = unsafe { device.GetImmediateContext()? }.cast()?;
            let mut fence: Option<ID3D11Fence> = None;
            unsafe { device5.CreateFence(0, D3D11_FENCE_FLAG_SHARED, &mut fence)? };
            let fence = fence.ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))?;
            Ok((device5, fence, context))
        })()
        .map_err(|e| format!("frame generation needs shared D3D11 fences: {e}"))?;
        let param = CreateParam {
            width,
            height,
            device: device5.as_raw(),
            resource_type: RESOURCE_DIRECTX11,
            surface_format: SURFACE_ARGB,
            cuda_resource_type: CUDA_RESOURCE_UNDEFINED,
            reserved: [0; 32],
        };
        let mut handle: Handle = std::ptr::null_mut();
        let status = unsafe { (api.create)(&param, &mut handle) };
        if status != Status::SUCCESS || handle.is_null() {
            return Err(match status {
                Status::NOT_SUPPORTED => "this GPU or its driver has no optical flow for frame generation".into(),
                Status(code) => format!("NvOFFRUCCreate failed with code {code}"),
            });
        }
        let cuda_context = cuda().map_or(std::ptr::null_mut(), Cuda::current);
        let fruc = Fruc { api, handle, cuda_context, fence, context, value: 0 };
        let mut param = RegisterParam { resources: [std::ptr::null_mut(); MAX_RESOURCE], fence: fruc.fence.as_raw(), count: textures.len() as u32 };
        for (slot, texture) in param.resources.iter_mut().zip(textures) {
            *slot = texture.as_raw();
        }
        let status = unsafe { (api.register)(handle, &param) };
        if status != Status::SUCCESS {
            return Err(format!("NvOFFRUCRegisterResource failed with code {}", status.0));
        }
        Ok(fruc)
    }

    pub fn process(&mut self, input: &ID3D11Texture2D, input_ts: f64, output: Option<(&ID3D11Texture2D, f64)>) -> Result<bool, String> {
        let drawn = self.value + 1;
        let written = self.value + 2;
        unsafe {
            self.context.Signal(&self.fence, drawn).map_err(|e| format!("frame generation fence: {e}"))?;
            self.context.Flush();
        }
        let mut repeated = false;
        let frame = |texture: *mut c_void, timestamp: f64, repetition: *mut bool| FrameData { frame: texture, timestamp, cuda_pitch: 0, repetition, reserved: [0; 32] };
        let in_params = ProcessIn {
            input: frame(input.as_raw(), input_ts, std::ptr::null_mut()),
            flags: output.is_none() as u32,
            sync: Sync { fence_value: drawn, unused: 0 },
            reserved: [0; 32],
        };
        let (out_texture, out_ts) = output.map_or((input.as_raw(), input_ts), |(t, ts)| (t.as_raw(), ts));
        let out_params = ProcessOut { output: frame(out_texture, out_ts, &mut repeated), sync: Sync { fence_value: written, unused: 0 }, reserved: [0; 32] };
        let status = unsafe { (self.api.process)(self.handle, &in_params, &out_params) };
        if status != Status::SUCCESS {
            return Err(format!("NvOFFRUCProcess failed with code {}", status.0));
        }
        self.value = written;
        unsafe { self.context.Wait(&self.fence, written) }.map_err(|e| format!("frame generation fence: {e}"))?;
        Ok(repeated)
    }
}

impl Drop for Fruc {
    fn drop(&mut self) {
        unsafe {
            (self.api.destroy)(self.handle);
            if let Some(cuda) = cuda().filter(|c| !self.cuda_context.is_null() && c.current() == self.cuda_context) {
                (cuda.destroy)(self.cuda_context);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use windows::Win32::Graphics::Direct3D11::{D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_USAGE_STAGING, ID3D11DeviceContext};

    #[test]
    fn struct_sizes_match_the_header() {
        assert_eq!(std::mem::size_of::<CreateParam>(), 8 + 8 + 12 + 4 + 128);
        assert_eq!(std::mem::size_of::<FrameData>(), 8 + 8 + 8 + 8 + 128);
        assert_eq!(std::mem::size_of::<Sync>(), 16);
        assert_eq!(std::mem::size_of::<ProcessIn>(), 160 + 8 + 16 + 128);
        assert_eq!(std::mem::size_of::<ProcessOut>(), 160 + 16 + 128);
        assert_eq!(std::mem::size_of::<RegisterParam>(), 80 + 8 + 8);
    }

    struct Rig {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        staging: ID3D11Texture2D,
        size: (u32, u32),
    }

    impl Rig {
        fn new(size: (u32, u32)) -> Rig {
            let (mut device, mut context) = (None, None);
            unsafe { D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, Default::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context)) }.unwrap();
            let (device, context) = (device.unwrap(), context.unwrap());
            let desc = D3D11_TEXTURE2D_DESC {
                Width: size.0,
                Height: size.1,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..Default::default()
            };
            let mut staging = None;
            unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }.unwrap();
            Rig { device, context, staging: staging.unwrap(), size }
        }

        fn fill(&self, tex: &ID3D11Texture2D, x: u32) {
            let (w, h) = self.size;
            let mut px = vec![0u8; (w * h * 4) as usize];
            for row in 0..h {
                for col in 0..w {
                    let i = ((row * w + col) * 4) as usize;
                    let c = col as f32 - x as f32;
                    let square = (0.0..160.0).contains(&c) && (h / 2 - 80..h / 2 + 80).contains(&row);
                    let wave = ((c * 0.045).sin() * (row as f32 * 0.06).cos() + (c * 0.011 + row as f32 * 0.017).sin()) * 35.0 + 90.0;
                    let v = if square { 255 } else { wave as u8 };
                    px[i..i + 4].copy_from_slice(&[v, (v / 2).saturating_add(30), 200u8.saturating_sub(v), 255]);
                }
            }
            unsafe { self.context.UpdateSubresource(tex, 0, None, px.as_ptr().cast(), w * 4, 0) };
        }

        fn square(&self, tex: &ID3D11Texture2D) -> Option<f64> {
            let (w, h) = self.size;
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                self.context.CopyResource(&self.staging, tex);
                self.context.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).unwrap();
                let row = std::slice::from_raw_parts((mapped.pData as *const u8).add(mapped.RowPitch as usize * (h / 2) as usize), (w * 4) as usize);
                let cols: Vec<f64> = (0..w as usize).filter(|&c| row[c * 4] > 200).map(|c| c as f64).collect();
                self.context.Unmap(&self.staging, 0);
                (!cols.is_empty()).then(|| cols.iter().sum::<f64>() / cols.len() as f64 - 79.5)
            }
        }
    }

    #[test]
    #[ignore = "requires an RTX card, NvOFFRUC.dll and cudart64_110.dll"]
    fn pictures_between_two_frames_are_where_their_times_say() {
        let t0 = Instant::now();
        probe().unwrap();
        println!("probe: {:?}", t0.elapsed());
        for size in [(1280, 720), (2554, 1436), (3840, 2160)] {
            let rig = Rig::new(size);
            let frames = [texture(&rig.device, size).unwrap(), texture(&rig.device, size).unwrap()];
            let between = texture(&rig.device, size).unwrap();
            let t0 = Instant::now();
            let mut fruc = Fruc::new(&rig.device, size.0, size.1, &[&frames[0], &frames[1], &between]).unwrap();
            println!("{size:?}: session in {:?}", t0.elapsed());
            rig.fill(&frames[1], 440);
            fruc.process(&frames[1], 1.0, None).unwrap();
            let mut spent = Vec::new();
            for n in 2..6u32 {
                let frame = &frames[n as usize % 2];
                rig.fill(frame, 400 + n * 40);
                for phase in [0.5, 0.2, 0.8] {
                    let t0 = Instant::now();
                    let repeated = fruc.process(frame, n as f64, Some((&between, (n - 1) as f64 + phase))).unwrap();
                    let at = rig.square(&between).expect("the square is in the picture");
                    spent.push(t0.elapsed().as_secs_f64() * 1000.0);
                    let want = 400.0 + (n as f64 - 1.0 + phase) * 40.0;
                    assert!(!repeated && (at - want).abs() < 3.0, "{size:?} frame {n} phase {phase}: square at {at}, not {want} (repeated {repeated})");
                }
            }
            spent.sort_by(f64::total_cmp);
            println!("{size:?}: a picture with its copy to the CPU in {:.1} ms median, {:.1} ms worst", spent[spent.len() / 2], spent[spent.len() - 1]);
            let frame = &frames[0];
            let noise: Vec<u8> = (0..size.0 * size.1 * 4).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
            unsafe { rig.context.UpdateSubresource(frame, 0, None, noise.as_ptr().cast(), size.0 * 4, 0) };
            let repeated = fruc.process(frame, 6.0, Some((&between, 5.5))).unwrap();
            println!("{size:?}: a cut repeats the earlier frame: {repeated}, square at {:?}", rig.square(&between));
        }
    }

    #[test]
    #[ignore = "requires an RTX card, NvOFFRUC.dll and cudart64_110.dll"]
    fn sessions_can_be_made_one_after_the_other() {
        let size = (1280, 720);
        let rig = Rig::new(size);
        let used = || {
            let out = std::process::Command::new("nvidia-smi").args(["--query-gpu=memory.used", "--format=csv,noheader,nounits"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().parse::<i64>().unwrap()
        };
        let mut before = 0;
        for n in 0..24 {
            let textures = [texture(&rig.device, size).unwrap(), texture(&rig.device, size).unwrap(), texture(&rig.device, size).unwrap()];
            let mut fruc = Fruc::new(&rig.device, size.0, size.1, &[&textures[0], &textures[1], &textures[2]]).unwrap_or_else(|e| panic!("session {n}: {e}"));
            rig.fill(&textures[0], 400);
            rig.fill(&textures[1], 440);
            fruc.process(&textures[0], 0.0, None).unwrap();
            assert!(!fruc.process(&textures[1], 1.0, Some((&textures[2], 0.5))).unwrap());
            assert!((rig.square(&textures[2]).unwrap() - 420.0).abs() < 3.0, "session {n}");
            if n == 3 {
                before = used();
            }
        }
        let grown = used() - before;
        println!("20 more sessions: {grown} MiB more video memory in use");
        assert!(grown < 1000, "{grown} MiB of video memory left behind by 20 sessions");
    }
}
