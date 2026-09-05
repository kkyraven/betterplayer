use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr;
use std::sync::atomic::AtomicU64;

#[repr(C)]
pub struct mpv_handle {
    _p: [u8; 0],
}
#[repr(C)]
pub struct mpv_render_context {
    _p: [u8; 0],
}

pub const MPV_FORMAT_STRING: c_int = 1;
pub const MPV_FORMAT_FLAG: c_int = 3;
pub const MPV_FORMAT_DOUBLE: c_int = 5;

pub const MPV_EVENT_SHUTDOWN: c_int = 1;
pub const MPV_EVENT_LOG_MESSAGE: c_int = 2;
pub const MPV_EVENT_END_FILE: c_int = 7;
pub const MPV_EVENT_FILE_LOADED: c_int = 8;
pub const MPV_EVENT_SEEK: c_int = 20;
pub const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;
pub const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;

pub const MPV_RENDER_PARAM_INVALID: c_int = 0;
pub const MPV_RENDER_PARAM_API_TYPE: c_int = 1;
pub const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
pub const MPV_RENDER_PARAM_OPENGL_FBO: c_int = 3;
pub const MPV_RENDER_PARAM_FLIP_Y: c_int = 4;
pub const MPV_RENDER_PARAM_ADVANCED_CONTROL: c_int = 10;
pub const MPV_RENDER_PARAM_NEXT_FRAME_INFO: c_int = 11;
pub const MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME: c_int = 12;
pub const MPV_RENDER_PARAM_SKIP_RENDERING: c_int = 13;
pub const MPV_RENDER_UPDATE_FRAME: u64 = 1;
pub const MPV_RENDER_FRAME_INFO_PRESENT: u64 = 1;
pub const MPV_RENDER_FRAME_INFO_REDRAW: u64 = 2;
pub const MPV_RENDER_FRAME_INFO_REPEAT: u64 = 4;

#[repr(C)]
pub struct mpv_event {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_end_file {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
    pub playlist_insert_id: i64,
    pub playlist_insert_num_entries: c_int,
}

#[repr(C)]
pub struct mpv_event_property {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_log_message {
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
    pub log_level: c_int,
}

#[repr(C)]
#[derive(Default)]
pub struct mpv_render_frame_info {
    pub flags: u64,
    pub target_time: i64,
}

#[repr(C)]
pub struct mpv_render_param {
    pub type_: c_int,
    pub data: *mut c_void,
}

pub type GetProcAddressFn = unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char) -> *mut c_void;

#[repr(C)]
pub struct mpv_opengl_init_params {
    pub get_proc_address: Option<GetProcAddressFn>,
    pub get_proc_address_ctx: *mut c_void,
}

#[repr(C)]
pub struct mpv_opengl_fbo {
    pub fbo: c_int,
    pub w: c_int,
    pub h: c_int,
    pub internal_format: c_int,
}

unsafe extern "C" {
    pub fn mpv_create() -> *mut mpv_handle;
    pub fn mpv_initialize(h: *mut mpv_handle) -> c_int;
    pub fn mpv_terminate_destroy(h: *mut mpv_handle);
    pub fn mpv_set_option_string(h: *mut mpv_handle, name: *const c_char, data: *const c_char) -> c_int;
    pub fn mpv_set_property_string(h: *mut mpv_handle, name: *const c_char, data: *const c_char) -> c_int;
    pub fn mpv_command(h: *mut mpv_handle, args: *mut *const c_char) -> c_int;
    pub fn mpv_get_property(h: *mut mpv_handle, name: *const c_char, format: c_int, data: *mut c_void) -> c_int;
    pub fn mpv_wait_event(h: *mut mpv_handle, timeout: f64) -> *mut mpv_event;
    pub fn mpv_error_string(error: c_int) -> *const c_char;
    pub fn mpv_request_log_messages(h: *mut mpv_handle, min_level: *const c_char) -> c_int;
    pub fn mpv_observe_property(h: *mut mpv_handle, reply_userdata: u64, name: *const c_char, format: c_int) -> c_int;

    pub fn mpv_render_context_create(
        res: *mut *mut mpv_render_context,
        h: *mut mpv_handle,
        params: *mut mpv_render_param,
    ) -> c_int;
    pub fn mpv_render_context_set_update_callback(
        ctx: *mut mpv_render_context,
        cb: Option<unsafe extern "C" fn(*mut c_void)>,
        cb_ctx: *mut c_void,
    );
    pub fn mpv_render_context_get_info(ctx: *mut mpv_render_context, param: mpv_render_param) -> c_int;
    pub fn mpv_render_context_update(ctx: *mut mpv_render_context) -> u64;
    pub fn mpv_render_context_render(ctx: *mut mpv_render_context, params: *mut mpv_render_param) -> c_int;
    pub fn mpv_render_context_report_swap(ctx: *mut mpv_render_context);
    pub fn mpv_render_context_free(ctx: *mut mpv_render_context);
}

pub fn error_string(code: c_int) -> String {
    unsafe { CStr::from_ptr(mpv_error_string(code)).to_string_lossy().into_owned() }
}

fn check(code: c_int, what: &str) -> Result<(), String> {
    if code < 0 { Err(format!("mpv {what}: {}", error_string(code))) } else { Ok(()) }
}


pub struct Mpv {
    pub handle: *mut mpv_handle,

    pub observed_time: AtomicU64,
}
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}


pub enum Event {
    None,
    Shutdown,
    FileLoaded,
    EndFile { error: Option<String> },
    Seek,
    PlaybackRestart,

    Property { name: String, value: Option<Property> },
    Log(String),
    Other,
}

#[derive(Clone, Copy, Debug)]
pub enum Property {
    Double(f64),
    Flag(bool),
}

impl Mpv {
    pub fn create() -> Result<Mpv, String> {

        unsafe { libc::setlocale(libc::LC_NUMERIC, c"C".as_ptr()) };
        let handle = unsafe { mpv_create() };
        if handle.is_null() {
            return Err("mpv_create failed (check LC_NUMERIC)".into());
        }
        Ok(Mpv { handle, observed_time: AtomicU64::new(0.0f64.to_bits()) })
    }

    pub fn set_option(&self, name: &str, value: &str) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let v = CString::new(value).map_err(|e| e.to_string())?;
        check(unsafe { mpv_set_option_string(self.handle, n.as_ptr(), v.as_ptr()) }, name)
    }

    pub fn set_property(&self, name: &str, value: &str) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        let v = CString::new(value).map_err(|e| e.to_string())?;
        check(unsafe { mpv_set_property_string(self.handle, n.as_ptr(), v.as_ptr()) }, name)
    }

    pub fn initialize(&self) -> Result<(), String> {
        check(unsafe { mpv_initialize(self.handle) }, "initialize")
    }

    pub fn request_log(&self, min_level: &str) -> Result<(), String> {
        let l = CString::new(min_level).map_err(|e| e.to_string())?;
        check(unsafe { mpv_request_log_messages(self.handle, l.as_ptr()) }, "request_log_messages")
    }


    pub fn observe(&self, name: &str, format: c_int) -> Result<(), String> {
        let n = CString::new(name).map_err(|e| e.to_string())?;
        check(unsafe { mpv_observe_property(self.handle, 0, n.as_ptr(), format) }, name)
    }

    pub fn command(&self, args: &[&str]) -> Result<(), String> {
        let owned: Vec<CString> = args
            .iter()
            .map(|a| CString::new(*a).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(ptr::null());
        check(unsafe { mpv_command(self.handle, ptrs.as_mut_ptr()) }, args.first().copied().unwrap_or("command"))
    }

    pub fn get_double(&self, name: &str) -> Option<f64> {
        let n = CString::new(name).ok()?;
        let mut out: f64 = 0.0;
        let r = unsafe { mpv_get_property(self.handle, n.as_ptr(), MPV_FORMAT_DOUBLE, &mut out as *mut f64 as *mut c_void) };
        (r >= 0).then_some(out)
    }

    pub fn get_flag(&self, name: &str) -> Option<bool> {
        let n = CString::new(name).ok()?;
        let mut out: c_int = 0;
        let r = unsafe { mpv_get_property(self.handle, n.as_ptr(), MPV_FORMAT_FLAG, &mut out as *mut c_int as *mut c_void) };
        (r >= 0).then_some(out != 0)
    }

    pub fn get_string(&self, name: &str) -> Option<String> {
        let n = CString::new(name).ok()?;
        let mut out: *mut c_char = ptr::null_mut();
        let r = unsafe { mpv_get_property(self.handle, n.as_ptr(), MPV_FORMAT_STRING, &mut out as *mut *mut c_char as *mut c_void) };
        if r < 0 || out.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(out).to_string_lossy().into_owned() };
        unsafe { mpv_free(out as *mut c_void) };
        Some(s)
    }


    pub fn wait_event(&self, timeout: f64) -> Event {
        let ev = unsafe { &*mpv_wait_event(self.handle, timeout) };
        match ev.event_id {
            0 => Event::None,
            MPV_EVENT_SHUTDOWN => Event::Shutdown,
            MPV_EVENT_FILE_LOADED => Event::FileLoaded,
            MPV_EVENT_SEEK => Event::Seek,
            MPV_EVENT_PLAYBACK_RESTART => Event::PlaybackRestart,
            MPV_EVENT_PROPERTY_CHANGE => {
                let d = unsafe { &*(ev.data as *const mpv_event_property) };
                let name = unsafe { CStr::from_ptr(d.name).to_string_lossy().into_owned() };
                let value = match d.format {
                    MPV_FORMAT_DOUBLE => Some(Property::Double(unsafe { *(d.data as *const f64) })),
                    MPV_FORMAT_FLAG => Some(Property::Flag(unsafe { *(d.data as *const c_int) } != 0)),
                    _ => None,
                };
                Event::Property { name, value }
            }
            MPV_EVENT_END_FILE => {
                let d = unsafe { &*(ev.data as *const mpv_event_end_file) };

                let error = (d.reason == 4).then(|| error_string(d.error));
                Event::EndFile { error }
            }
            MPV_EVENT_LOG_MESSAGE => {
                let d = unsafe { &*(ev.data as *const mpv_event_log_message) };
                let text = unsafe { CStr::from_ptr(d.text).to_string_lossy() };
                let prefix = unsafe { CStr::from_ptr(d.prefix).to_string_lossy() };
                Event::Log(format!("[{prefix}] {}", text.trim_end()))
            }
            _ => Event::Other,
        }
    }
}

unsafe extern "C" {
    fn mpv_free(data: *mut c_void);
}

impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe { mpv_terminate_destroy(self.handle) };
    }
}
