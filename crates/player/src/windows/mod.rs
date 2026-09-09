//! Windows only: the ANGLE context, the GPU probe, the NvOFFRUC bindings and the DLSS 5 worker.

pub mod dlss;
pub mod dlss5;
pub mod egl;
pub mod fruc;
pub mod probe;

use std::path::PathBuf;

use libloading::Library;
use libloading::os::windows::{LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, Library as WinLibrary};
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
        let path = String::from_utf16_lossy(&buf[..len]);
        // Node opens addons by their verbatim (`\\?\`) path and the loader reports it back that
        // way. LoadLibraryExW's per-DLL directory search, which finds libGLESv2.dll next to
        // libEGL.dll, wants a plain fully qualified path, so the prefix goes.
        let path = match path.strip_prefix(r"\\?\UNC\") {
            Some(rest) => format!(r"\\{rest}"),
            None => path.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(path),
        };
        PathBuf::from(path).parent().map(PathBuf::from)
    }
}

/// Loads a DLL from next to the addon when a copy is there, else by the loader's own search
/// order. The addon-local load also resolves the DLL's own dependents from that folder
/// (`libGLESv2.dll` next to `libEGL.dll`), which `LoadLibrary`'s default search does not.
/// The error names every path tried.
pub fn load_dll(name: &str) -> Result<Library, String> {
    let mut errors = Vec::new();
    if let Some(path) = module_dir().map(|d| d.join(name)) {
        if path.exists() {
            match unsafe { WinLibrary::load_with_flags(&path, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) } {
                Ok(lib) => return Ok(lib.into()),
                Err(e) => errors.push(format!("{}: {}", path.display(), describe(&e))),
            }
        } else {
            errors.push(format!("{}: not there", path.display()));
        }
    }
    match unsafe { Library::new(name) } {
        Ok(lib) => Ok(lib),
        Err(e) => {
            errors.push(format!("{name} on the search path: {}", describe(&e)));
            Err(errors.join("; "))
        }
    }
}

fn describe(e: &libloading::Error) -> String {
    match std::error::Error::source(e) {
        Some(cause) => format!("{e} ({cause})"),
        None => e.to_string(),
    }
}

/// What this GPU offers: VSR on an NVIDIA card with a new enough driver; frame generation and
/// DLSS 5 once their runtimes are present and the D3D11 render path exists (it does not yet).
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
    // DLSS 5 runs its worker over a byte pipe, so the render path (windows/dlss.rs) needs no
    // D3D11 interop: it is available whenever the runtime is present next to the engine.
    let (dlss, dlss_reason) = match dlss5::available() {
        Ok(_) => (true, None),
        Err(e) => (false, Some(e)),
    };
    EnhanceCapabilities { vsr: true, dlss, vsr_reason: None, dlss_reason, gpu: Some(gpu.name), ..EnhanceCapabilities::none(&frame_gen_reason) }
}
