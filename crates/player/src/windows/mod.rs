//! Windows only: the ANGLE context, the GPU probe and the NvOFFRUC bindings.

pub mod egl;
pub mod fruc;
pub mod probe;

use std::path::PathBuf;

use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, GetModuleFileNameW, GetModuleHandleExW};
use windows::core::PCWSTR;

use crate::enhance::EnhanceCapabilities;

/// The folder this addon was loaded from, where optional DLLs are looked for first.
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

/// What this GPU offers: VSR on an NVIDIA card with a new enough driver; frame generation
/// once the DLL is present and the D3D11 render path exists (it does not yet).
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
    EnhanceCapabilities { vsr: true, frame_gen: false, vsr_reason: None, frame_gen_reason: Some(frame_gen_reason), gpu: Some(gpu.name) }
}
