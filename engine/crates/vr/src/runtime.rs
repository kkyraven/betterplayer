use std::ffi::{CStr, c_char, c_void};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use libloading::Library;
use libloading::os::windows::{LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, Library as WinLibrary};
use windows::Win32::Foundation::{CloseHandle, HMODULE};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
use windows::Win32::System::LibraryLoader::{GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, GetModuleFileNameW, GetModuleHandleExW};
use windows::core::PCWSTR;

use crate::sys::*;

macro_rules! vr {
    ($table:expr, $f:ident($($arg:expr),* $(,)?)) => {
        unsafe { ($table.$f.expect(stringify!($f)))($($arg),*) }
    };
}
pub(crate) use vr;

pub(crate) struct Api {
    init: PFN_VR_InitInternal2,
    shutdown: PFN_VR_ShutdownInternal,
    hmd_present: PFN_VR_IsHmdPresent,
    installed: PFN_VR_IsRuntimeInstalled,
    interface: PFN_VR_GetGenericInterface,
    version_valid: PFN_VR_IsInterfaceVersionValid,
    describe: PFN_VR_GetVRInitErrorAsEnglishDescription,
    _lib: Library,
}

pub(crate) fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(load).as_ref().map_err(Clone::clone)
}

fn load() -> Result<Api, String> {
    let lib = load_dll("openvr_api.dll").map_err(|e| format!("openvr_api.dll (next to the engine addon) not loadable: {e}"))?;
    unsafe fn sym<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
        unsafe { lib.get::<T>(name) }.map(|s| *s).map_err(|e| format!("openvr_api.dll {}: {e}", String::from_utf8_lossy(&name[..name.len() - 1])))
    }
    unsafe {
        Ok(Api {
            init: sym(&lib, b"VR_InitInternal2\0")?,
            shutdown: sym(&lib, b"VR_ShutdownInternal\0")?,
            hmd_present: sym(&lib, b"VR_IsHmdPresent\0")?,
            installed: sym(&lib, b"VR_IsRuntimeInstalled\0")?,
            interface: sym(&lib, b"VR_GetGenericInterface\0")?,
            version_valid: sym(&lib, b"VR_IsInterfaceVersionValid\0")?,
            describe: sym(&lib, b"VR_GetVRInitErrorAsEnglishDescription\0")?,
            _lib: lib,
        })
    }
}

fn load_dll(name: &str) -> Result<Library, String> {
    let mut errors = Vec::new();
    if let Some(path) = addon_dir().map(|d| d.join(name)).filter(|p| p.exists()) {
        match unsafe { WinLibrary::load_with_flags(&path, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) } {
            Ok(lib) => return Ok(lib.into()),
            Err(e) => errors.push(format!("{}: {e}", path.display())),
        }
    }
    unsafe { Library::new(name) }.map_err(|e| {
        errors.push(format!("{name} on the search path: {e}"));
        errors.join("; ")
    })
}

fn addon_dir() -> Option<PathBuf> {
    unsafe {
        let mut module = HMODULE::default();
        let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
        GetModuleHandleExW(flags, PCWSTR(addon_dir as *const () as *const u16), &mut module).ok()?;
        let mut buf = [0u16; 1024];
        let len = GetModuleFileNameW(Some(module), &mut buf) as usize;
        if len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len]);
        let path = match path.strip_prefix(r"\\?\UNC\") {
            Some(rest) => format!(r"\\{rest}"),
            None => path.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(path),
        };
        PathBuf::from(path).parent().map(PathBuf::from)
    }
}

pub(crate) fn steamvr_running() -> bool {
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return false };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case("vrserver.exe") {
                found = true;
                break;
            }
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

pub(crate) fn installed() -> bool {
    api().is_ok_and(|api| unsafe { (api.installed)() })
}

pub(crate) fn hmd_present() -> bool {
    api().is_ok_and(|api| unsafe { (api.hmd_present)() })
}

static CONNECTED: AtomicBool = AtomicBool::new(false);

pub(crate) struct Session {
    api: &'static Api,
}

impl Session {
    pub fn connect(kind: EVRApplicationType) -> Result<Session, String> {
        let api = api()?;
        if !steamvr_running() {
            return Err("not-running: SteamVR is not running".into());
        }
        if CONNECTED.swap(true, Ordering::AcqRel) {
            return Err("busy: SteamVR is already in use by Better Player".into());
        }
        let mut error = EVRInitError::VRInitError_None;
        unsafe { (api.init)(&mut error, kind, std::ptr::null()) };
        if error != EVRInitError::VRInitError_None {
            CONNECTED.store(false, Ordering::Release);
            return Err(init_error(api, error));
        }
        let session = Session { api };
        if !unsafe { (api.version_valid)(c"IVRSystem_026".as_ptr()) } {
            return Err("old-steamvr: SteamVR is too old for Better Player; update SteamVR".into());
        }
        let system: &VR_IVRSystem_FnTable = unsafe { session.table(IVRSystem_FnTable)? };
        let error = vr!(system, SetSDKVersion(2, 15, 6));
        if error != EVRInitError::VRInitError_None {
            return Err(init_error(api, error));
        }
        Ok(session)
    }

    pub unsafe fn table<T>(&self, name: &[u8]) -> Result<&'static T, String> {
        let mut error = EVRInitError::VRInitError_None;
        let p = unsafe { (self.api.interface)(name.as_ptr() as *const c_char, &mut error) };
        if p.is_null() || error != EVRInitError::VRInitError_None {
            let name = String::from_utf8_lossy(&name[..name.len() - 1]).into_owned();
            return Err(format!("old-steamvr: SteamVR has no {name} ({})", error.0));
        }
        Ok(unsafe { &*(p as *const T) })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe { (self.api.shutdown)() };
        CONNECTED.store(false, Ordering::Release);
    }
}

pub(crate) unsafe fn connected_table<T>(name: &[u8]) -> Result<&'static T, String> {
    if !CONNECTED.load(Ordering::Acquire) {
        return Err("not connected to SteamVR".into());
    }
    let mut error = EVRInitError::VRInitError_None;
    let p = unsafe { (api()?.interface)(name.as_ptr() as *const c_char, &mut error) };
    if p.is_null() { Err("SteamVR has no such interface".into()) } else { Ok(unsafe { &*(p as *const T) }) }
}

fn init_error(api: &Api, error: EVRInitError) -> String {
    let code = init_code(error);
    match code {
        "no-headset" => "no-headset: SteamVR has no headset".into(),
        "not-installed" => "not-installed: SteamVR is not installed".into(),
        _ => {
            let p = unsafe { (api.describe)(error) };
            let text = if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() };
            format!("{code}: SteamVR: {text} ({})", error.0)
        }
    }
}

fn init_code(error: EVRInitError) -> &'static str {
    use EVRInitError as E;
    match error {
        E::VRInitError_Init_HmdNotFound | E::VRInitError_Init_HmdNotFoundPresenceFailed => "no-headset",
        E::VRInitError_Init_InstallationNotFound | E::VRInitError_Init_VRClientDLLNotFound => "not-installed",
        E::VRInitError_Init_InterfaceNotFound | E::VRInitError_Init_InvalidInterface => "old-steamvr",
        E::VRInitError_Init_NoServerForBackgroundApp => "not-running",
        E::VRInitError_Init_AnotherAppLaunching
        | E::VRInitError_Init_RebootingBusy
        | E::VRInitError_Init_FirmwareUpdateBusy
        | E::VRInitError_Init_FirmwareRecoveryBusy
        | E::VRInitError_Init_USBServiceBusy => "busy",
        E(300..=399) => "not-running",
        E(400..=499) => "compositor",
        _ => "failed",
    }
}

pub(crate) fn c_string(s: &str) -> Vec<u8> {
    let mut end = s.len().min(127);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut v: Vec<u8> = s[..end].bytes().filter(|&b| b != 0).collect();
    v.push(0);
    v
}

pub(crate) fn device_string(system: &VR_IVRSystem_FnTable, device: u32, prop: ETrackedDeviceProperty) -> String {
    let mut buf = [0 as c_char; 256];
    let mut error = ETrackedPropertyError::default();
    let len = vr!(system, GetStringTrackedDeviceProperty(device, prop, buf.as_mut_ptr(), buf.len() as u32, &mut error));
    if len == 0 {
        return String::new();
    }
    unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned()
}

pub(crate) fn head_pose(system: &VR_IVRSystem_FnTable) -> Option<crate::Pose> {
    let mut pose = TrackedDevicePose_t::default();
    vr!(system, GetDeviceToAbsoluteTrackingPose(ETrackingUniverseOrigin::TrackingUniverseStanding, 0.0, &mut pose, 1));
    pose.bPoseIsValid.then_some(crate::Pose(pose.mDeviceToAbsoluteTracking.m))
}

pub(crate) fn output_luid(system: &VR_IVRSystem_FnTable) -> u64 {
    let mut luid = 0u64;
    vr!(system, GetOutputDevice(&mut luid, ETextureType::TextureType_DirectX, std::ptr::null_mut::<c_void>()));
    luid
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_errors_get_the_apps_codes() {
        assert_eq!(init_code(EVRInitError::VRInitError_Init_HmdNotFoundPresenceFailed), "no-headset");
        assert_eq!(init_code(EVRInitError::VRInitError_Init_VRClientDLLNotFound), "not-installed");
        assert_eq!(init_code(EVRInitError::VRInitError_IPC_ConnectFailed), "not-running");
        assert_eq!(init_code(EVRInitError::VRInitError_Compositor_FailedToCreateSwapChain), "compositor");
        assert_eq!(init_code(EVRInitError::VRInitError_Init_USBServiceBusy), "busy");
        assert_eq!(init_code(EVRInitError::VRInitError_Init_InterfaceNotFound), "old-steamvr");
        assert_eq!(init_code(EVRInitError(1)), "failed");
    }
}
