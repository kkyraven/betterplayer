#![allow(dead_code)]

use std::ffi::c_void;
use std::path::PathBuf;

use libloading::{Library, Symbol};

pub const DLL: &str = "NvOFFRUC.dll";

const MAX_RESOURCE: usize = 10;

type Handle = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status(pub i32);

impl Status {
    pub const SUCCESS: Status = Status(0);
    pub const NOT_SUPPORTED: Status = Status(1);
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
    a: u64,
    b: u64,
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

#[repr(C)]
struct UnregisterParam {
    resources: [*mut c_void; MAX_RESOURCE],
    count: u32,
}

type CreateFn = unsafe extern "system" fn(*const CreateParam, *mut Handle) -> Status;
type RegisterFn = unsafe extern "system" fn(Handle, *const RegisterParam) -> Status;
type UnregisterFn = unsafe extern "system" fn(Handle, *const UnregisterParam) -> Status;
type ProcessFn = unsafe extern "system" fn(Handle, *const ProcessIn, *const ProcessOut) -> Status;
type DestroyFn = unsafe extern "system" fn(Handle) -> Status;


pub struct Api {
    create: CreateFn,
    register: RegisterFn,
    unregister: UnregisterFn,
    process: ProcessFn,
    destroy: DestroyFn,

    _lib: Library,
}

impl Api {

    pub fn load() -> Result<Api, String> {
        let candidates: Vec<PathBuf> = super::module_dir().into_iter().map(|d| d.join(DLL)).chain([PathBuf::from(DLL)]).collect();
        let mut last = String::new();
        for path in candidates {
            match unsafe { Library::new(&path) } {
                Ok(lib) => return Api::resolve(lib),
                Err(e) => last = format!("{}: {e}", path.display()),
            }
        }
        Err(last)
    }

    fn resolve(lib: Library) -> Result<Api, String> {
        unsafe fn sym<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
            let s: Symbol<T> = unsafe { lib.get(name) }.map_err(|e| format!("{}: {e}", String::from_utf8_lossy(name)))?;
            Ok(*s)
        }
        unsafe {
            Ok(Api {
                create: sym(&lib, b"NvOFFRUCCreate\0")?,
                register: sym(&lib, b"NvOFFRUCRegisterResource\0")?,
                unregister: sym(&lib, b"NvOFFRUCUnregisterResource\0")?,
                process: sym(&lib, b"NvOFFRUCProcess\0")?,
                destroy: sym(&lib, b"NvOFFRUCDestroy\0")?,
                _lib: lib,
            })
        }
    }
}


pub fn available() -> Result<(), String> {
    Api::load().map(|_| ())
}



pub struct Fruc {
    api: Api,
    handle: Handle,
    registered: Vec<*mut c_void>,
}

impl Fruc {
    pub fn new(api: Api, device: *mut c_void, width: u32, height: u32) -> Result<Fruc, String> {
        let param = CreateParam {
            width,
            height,
            device,
            resource_type: RESOURCE_DIRECTX11,
            surface_format: SURFACE_ARGB,
            cuda_resource_type: CUDA_RESOURCE_UNDEFINED,
            reserved: [0; 32],
        };
        let mut handle: Handle = std::ptr::null_mut();
        let status = unsafe { (api.create)(&param, &mut handle) };
        if status != Status::SUCCESS || handle.is_null() {
            return Err(match status {
                Status::NOT_SUPPORTED => "optical flow is not supported on this GPU".into(),
                Status(code) => format!("NvOFFRUCCreate failed with code {code}"),
            });
        }
        Ok(Fruc { api, handle, registered: Vec::new() })
    }


    pub fn register(&mut self, textures: &[*mut c_void]) -> Result<(), String> {
        if textures.len() > MAX_RESOURCE {
            return Err(format!("NvOFFRUC takes at most {MAX_RESOURCE} resources"));
        }
        let mut param = RegisterParam { resources: [std::ptr::null_mut(); MAX_RESOURCE], fence: std::ptr::null_mut(), count: textures.len() as u32 };
        param.resources[..textures.len()].copy_from_slice(textures);
        let status = unsafe { (self.api.register)(self.handle, &param) };
        if status != Status::SUCCESS {
            return Err(format!("NvOFFRUCRegisterResource failed with code {}", status.0));
        }
        self.registered.extend_from_slice(textures);
        Ok(())
    }




    pub fn process(&mut self, input: *mut c_void, input_ts: f64, output: *mut c_void, output_ts: f64) -> Result<bool, String> {
        let mut repeated = false;
        let in_params = ProcessIn {
            input: FrameData { frame: input, timestamp: input_ts, cuda_pitch: 0, repetition: std::ptr::null_mut(), reserved: [0; 32] },
            flags: 0,
            sync: Sync::default(),
            reserved: [0; 32],
        };
        let out_params = ProcessOut {
            output: FrameData { frame: output, timestamp: output_ts, cuda_pitch: 0, repetition: &mut repeated, reserved: [0; 32] },
            sync: Sync::default(),
            reserved: [0; 32],
        };
        let status = unsafe { (self.api.process)(self.handle, &in_params, &out_params) };
        if status != Status::SUCCESS {
            return Err(format!("NvOFFRUCProcess failed with code {}", status.0));
        }
        Ok(repeated)
    }
}

impl Drop for Fruc {
    fn drop(&mut self) {
        unsafe {
            for chunk in self.registered.chunks(MAX_RESOURCE) {
                let mut param = UnregisterParam { resources: [std::ptr::null_mut(); MAX_RESOURCE], count: chunk.len() as u32 };
                param.resources[..chunk.len()].copy_from_slice(chunk);
                (self.api.unregister)(self.handle, &param);
            }
            (self.api.destroy)(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn struct_sizes_match_the_header() {
        assert_eq!(std::mem::size_of::<CreateParam>(), 8 + 8 + 12 + 4 + 128);
        assert_eq!(std::mem::size_of::<FrameData>(), 8 + 8 + 8 + 8 + 128);
        assert_eq!(std::mem::size_of::<Sync>(), 16);
        assert_eq!(std::mem::size_of::<ProcessIn>(), 160 + 8 + 16 + 128);
        assert_eq!(std::mem::size_of::<ProcessOut>(), 160 + 16 + 128);
        assert_eq!(std::mem::size_of::<RegisterParam>(), 80 + 8 + 8);
        assert_eq!(std::mem::size_of::<UnregisterParam>(), 80 + 8);
    }
}
