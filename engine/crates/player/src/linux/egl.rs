use libloading::Library;
use std::ffi::{CStr, c_char, c_void};
use std::fs::File;
use std::os::fd::AsRawFd;
use std::ptr;
use std::sync::OnceLock;

type Handle = *mut c_void;
type PlatformDisplay = unsafe extern "C" fn(u32, Handle, *const i32) -> Handle;
type QueryDevices = unsafe extern "C" fn(i32, *mut Handle, *mut i32) -> u32;
type QueryDisplay = unsafe extern "C" fn(Handle, i32, *mut isize) -> u32;
type QueryDeviceString = unsafe extern "C" fn(Handle, i32) -> *const c_char;
const NONE: i32 = 0x3038;
const EXTENSIONS: i32 = 0x3055;
const DEVICE: i32 = 0x322C;
const DRM_RENDER_NODE: i32 = 0x3377;
const PLATFORM_SURFACELESS: u32 = 0x31DD;
const PLATFORM_DEVICE: u32 = 0x313F;
const OPENGL_API: u32 = 0x30A2;
const SURFACE_TYPE: i32 = 0x3033;
const PBUFFER_BIT: i32 = 1;
const RENDERABLE_TYPE: i32 = 0x3040;
const OPENGL_BIT: i32 = 8;
const RED_SIZE: i32 = 0x3024;
const GREEN_SIZE: i32 = 0x3023;
const BLUE_SIZE: i32 = 0x3022;
const ALPHA_SIZE: i32 = 0x3021;
const CONTEXT_MAJOR: i32 = 0x3098;
const CONTEXT_MINOR: i32 = 0x30FB;
const CONTEXT_PROFILE_MASK: i32 = 0x30FD;
const OPENGL_CORE_PROFILE_BIT: i32 = 1;
const WIDTH: i32 = 0x3057;
const HEIGHT: i32 = 0x3056;
const VERSION: i32 = 0x3054;

struct Egl {
    get_display: unsafe extern "C" fn(Handle) -> Handle,
    get_current_context: unsafe extern "C" fn() -> Handle,
    initialize: unsafe extern "C" fn(Handle, *mut i32, *mut i32) -> u32,
    bind_api: unsafe extern "C" fn(u32) -> u32,
    choose_config: unsafe extern "C" fn(Handle, *const i32, *mut Handle, i32, *mut i32) -> u32,
    create_context: unsafe extern "C" fn(Handle, Handle, Handle, *const i32) -> Handle,
    create_pbuffer: unsafe extern "C" fn(Handle, Handle, *const i32) -> Handle,
    make_current: unsafe extern "C" fn(Handle, Handle, Handle, Handle) -> u32,
    destroy_context: unsafe extern "C" fn(Handle, Handle) -> u32,
    destroy_surface: unsafe extern "C" fn(Handle, Handle) -> u32,
    get_error: unsafe extern "C" fn() -> i32,
    get_proc_address: unsafe extern "C" fn(*const c_char) -> Handle,
    query_string: unsafe extern "C" fn(Handle, i32) -> *const c_char,
    lib: Library,
    gl: Library,
}

impl Egl {
    fn load() -> Result<Self, String> {
        unsafe fn symbol<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
            unsafe { lib.get::<T>(name) }.map(|s| *s).map_err(|e| e.to_string())
        }
        unsafe {
            let lib = Library::new("libEGL.so.1").map_err(|e| format!("Load libEGL.so.1: {e}"))?;
            let gl = Library::new("libOpenGL.so.0").or_else(|_| Library::new("libGL.so.1")).map_err(|e| format!("Load desktop OpenGL: {e}"))?;
            Ok(Self {
                get_display: symbol(&lib, b"eglGetDisplay\0")?,
                get_current_context: symbol(&lib, b"eglGetCurrentContext\0")?,
                initialize: symbol(&lib, b"eglInitialize\0")?,
                bind_api: symbol(&lib, b"eglBindAPI\0")?,
                choose_config: symbol(&lib, b"eglChooseConfig\0")?,
                create_context: symbol(&lib, b"eglCreateContext\0")?,
                create_pbuffer: symbol(&lib, b"eglCreatePbufferSurface\0")?,
                make_current: symbol(&lib, b"eglMakeCurrent\0")?,
                destroy_context: symbol(&lib, b"eglDestroyContext\0")?,
                destroy_surface: symbol(&lib, b"eglDestroySurface\0")?,
                get_error: symbol(&lib, b"eglGetError\0")?,
                get_proc_address: symbol(&lib, b"eglGetProcAddress\0")?,
                query_string: symbol(&lib, b"eglQueryString\0")?,
                lib,
                gl,
            })
        }
    }

    fn query(&self, display: Handle, key: i32) -> String {
        string(unsafe { (self.query_string)(display, key) })
    }

    fn error(&self, action: &str) -> String {
        format!("{action}: EGL error 0x{:04x}", unsafe { (self.get_error)() })
    }

    fn address(&self, name: &CStr) -> Handle {
        unsafe {
            let address = (self.get_proc_address)(name.as_ptr());
            if !address.is_null() {
                return address;
            }
            let lib = if name.to_bytes().starts_with(b"egl") { &self.lib } else { &self.gl };
            lib.get::<Handle>(name.to_bytes_with_nul()).map(|s| *s).unwrap_or(ptr::null_mut())
        }
    }

    fn render_node(&self, display: Handle) -> Option<String> {
        let query_display = self.address(c"eglQueryDisplayAttribEXT");
        let query_device = self.address(c"eglQueryDeviceStringEXT");
        if query_display.is_null() || query_device.is_null() {
            return None;
        }
        let query_display: QueryDisplay = unsafe { std::mem::transmute(query_display) };
        let query_device: QueryDeviceString = unsafe { std::mem::transmute(query_device) };
        let mut device = 0isize;
        if unsafe { query_display(display, DEVICE, &mut device) } == 0 {
            return None;
        }
        let extensions = string(unsafe { query_device(device as Handle, EXTENSIONS) });
        if !has(&extensions, "EGL_EXT_device_drm_render_node") {
            return None;
        }
        let node = string(unsafe { query_device(device as Handle, DRM_RENDER_NODE) });
        if node.is_empty() { None } else { Some(node) }
    }
}

fn string(value: *const c_char) -> String {
    if value.is_null() { String::new() } else { unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned() }
}

fn has(extensions: &str, name: &str) -> bool {
    extensions.split_ascii_whitespace().any(|e| e == name)
}

pub struct Context {
    egl: &'static Egl,
    display: Handle,
    surface: Handle,
    context: Handle,
    render_node: Option<File>,
}

impl Context {
    pub fn new() -> Result<Self, String> {
        static EGL: OnceLock<Result<Egl, String>> = OnceLock::new();
        let egl = EGL.get_or_init(Egl::load).as_ref().map_err(Clone::clone)?;
        let extensions = egl.query(ptr::null_mut(), EXTENSIONS);
        let platform = egl.address(c"eglGetPlatformDisplayEXT");
        let mut displays = Vec::new();
        let requested = std::env::var("BP_DRM_DEVICE").ok().filter(|path| !path.is_empty());
        if !platform.is_null() {
            let platform: PlatformDisplay = unsafe { std::mem::transmute(platform) };
            if requested.is_none() && has(&extensions, "EGL_MESA_platform_surfaceless") {
                displays.push(unsafe { platform(PLATFORM_SURFACELESS, ptr::null_mut(), [NONE].as_ptr()) });
            }
            let query = egl.address(c"eglQueryDevicesEXT");
            if !query.is_null() && has(&extensions, "EGL_EXT_platform_device") {
                let query: QueryDevices = unsafe { std::mem::transmute(query) };
                let mut count = 0;
                if unsafe { query(0, ptr::null_mut(), &mut count) } != 0 && count > 0 {
                    let mut devices = vec![ptr::null_mut(); count as usize];
                    if unsafe { query(count, devices.as_mut_ptr(), &mut count) } != 0 {
                        for device in devices.into_iter().take(count as usize) {
                            displays.push(unsafe { platform(PLATFORM_DEVICE, device, [NONE].as_ptr()) });
                        }
                    }
                }
            }
        }
        if requested.is_none() {
            displays.push(unsafe { (egl.get_display)(ptr::null_mut()) });
        }
        let mut errors = Vec::new();
        let mut software = None;
        for display in displays {
            if display.is_null() {
                continue;
            }
            if unsafe { (egl.initialize)(display, ptr::null_mut(), ptr::null_mut()) } == 0 {
                errors.push(egl.error("eglInitialize"));
                continue;
            }
            let node = egl.render_node(display);
            if requested.as_ref().is_some_and(|path| node.as_ref() != Some(path)) {
                continue;
            }
            match Self::create(egl, display, node) {
                Ok(context) => {
                    let renderer = context.describe().to_ascii_lowercase();
                    let is_software = ["llvmpipe", "softpipe", "software rasterizer"].iter().any(|name| renderer.contains(name));
                    if !is_software || std::env::var("LIBGL_ALWAYS_SOFTWARE").is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "yes")) {
                        return Ok(context);
                    }
                    if software.is_none() {
                        software = Some(context);
                    }
                }
                Err(error) => errors.push(error),
            }
        }
        if let Some(context) = software {
            if unsafe { (egl.make_current)(context.display, context.surface, context.surface, context.context) } == 0 {
                return Err(egl.error("eglMakeCurrent(software fallback)"));
            }
            return Ok(context);
        }
        Err(format!(
            "Cannot create Linux OpenGL 3.3 context{}: {}. Check the Mesa or NVIDIA EGL driver and /dev/dri permissions.",
            requested.map(|s| format!(" on {s}")).unwrap_or_default(),
            errors.join("; ")
        ))
    }

    fn create(egl: &'static Egl, display: Handle, node: Option<String>) -> Result<Self, String> {
        if unsafe { (egl.bind_api)(OPENGL_API) } == 0 {
            return Err(egl.error("eglBindAPI(OpenGL)"));
        }
        let config_attributes = [SURFACE_TYPE, PBUFFER_BIT, RENDERABLE_TYPE, OPENGL_BIT, RED_SIZE, 8, GREEN_SIZE, 8, BLUE_SIZE, 8, ALPHA_SIZE, 8, NONE];
        let mut config = ptr::null_mut();
        let mut count = 0;
        if unsafe { (egl.choose_config)(display, config_attributes.as_ptr(), &mut config, 1, &mut count) } == 0 || count == 0 {
            return Err(egl.error("eglChooseConfig(OpenGL pbuffer)"));
        }
        let context_attributes = [CONTEXT_MAJOR, 3, CONTEXT_MINOR, 3, CONTEXT_PROFILE_MASK, OPENGL_CORE_PROFILE_BIT, NONE];
        let context = unsafe { (egl.create_context)(display, config, ptr::null_mut(), context_attributes.as_ptr()) };
        if context.is_null() {
            return Err(egl.error("eglCreateContext(OpenGL 3.3 core)"));
        }
        let mut result = Self { egl, display, context, surface: ptr::null_mut(), render_node: None };
        let surfaceless = has(&egl.query(display, EXTENSIONS), "EGL_KHR_surfaceless_context");
        if !surfaceless || unsafe { (egl.make_current)(display, ptr::null_mut(), ptr::null_mut(), context) } == 0 {
            result.surface = unsafe { (egl.create_pbuffer)(display, config, [WIDTH, 1, HEIGHT, 1, NONE].as_ptr()) };
            if result.surface.is_null() {
                return Err(egl.error("eglCreatePbufferSurface"));
            }
            if unsafe { (egl.make_current)(display, result.surface, result.surface, context) } == 0 {
                return Err(egl.error("eglMakeCurrent"));
            }
        }
        if let Some(path) = node {
            match File::options().read(true).write(true).open(&path) {
                Ok(file) => result.render_node = Some(file),
                Err(error) => eprintln!("Linux hardware decode: cannot open {path}: {error}"),
            }
        }
        Ok(result)
    }

    pub fn render_fd(&self) -> i32 {
        self.render_node.as_ref().map_or(-1, AsRawFd::as_raw_fd)
    }

    pub fn get_proc_address(&self, name: &CStr) -> Handle {
        self.egl.address(name)
    }

    pub fn describe(&self) -> String {
        let address = self.egl.address(c"glGetString");
        if address.is_null() {
            return "EGL desktop OpenGL".into();
        }
        let get_string: unsafe extern "C" fn(u32) -> *const c_char = unsafe { std::mem::transmute(address) };
        format!(
            "{} ({}, EGL {})",
            string(unsafe { get_string(gl::RENDERER) }),
            string(unsafe { get_string(gl::VERSION) }),
            self.egl.query(self.display, VERSION)
        )
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        unsafe {
            if (self.egl.get_current_context)() == self.context {
                (self.egl.make_current)(self.display, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
            }
            (self.egl.destroy_context)(self.display, self.context);
            if !self.surface.is_null() {
                (self.egl.destroy_surface)(self.display, self.surface);
            }
        }
    }
}
