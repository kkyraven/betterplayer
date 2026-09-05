pub mod egl;
pub mod fruc;
pub mod probe;

use std::path::PathBuf;

use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, GetModuleFileNameW, GetModuleHandleExW};
use windows::core::PCWSTR;

use crate::enhance::EnhanceCapabilities;


pub fn module_dir() -> Option<PathBuf> {
    unsafe {
        let mut module = HMODULE::default();
        let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
        GetModuleHandleExW(flags, PCWSTR(module_dir as *const () as *const u16), &mut module).ok()?;
        let mut buf = [0u16; 1024];
        let len = GetModuleFileNameW(Some(module), &mut buf) as usize;
        if len == 0 {
            return None;
        }
        PathBuf::from(String::from_utf16_lossy(&buf[..len])).parent().map(PathBuf::from)
    }
}



pub fn capabilities() -> EnhanceCapabilities {
    let gpu = match probe::gpu() {
        Ok(g) => g,
        Err(e) => return EnhanceCapabilities::none(&e),
    };
    if !gpu.nvidia {
        return EnhanceCapabilities { gpu: Some(gpu.name.clone()), ..EnhanceCapabilities::none("needs an NVIDIA RTX card") };
    }
    if gpu.driver > 0.0 && gpu.driver < probe::VSR_MIN_DRIVER {
        let reason = format!("NVIDIA driver {:.2} is below {:.2}", gpu.driver, probe::VSR_MIN_DRIVER);
        return EnhanceCapabilities { gpu: Some(gpu.name.clone()), ..EnhanceCapabilities::none(&reason) };
    }
    let frame_gen_reason = match fruc::available() {
        Ok(()) => "frame generation needs the D3D11 render path, not built yet".to_string(),
        Err(_) => format!("{} not found next to the engine", fruc::DLL),
    };
    EnhanceCapabilities { vsr: true, vsr_reason: None, gpu: Some(gpu.name), ..EnhanceCapabilities::none(&frame_gen_reason) }
}
