use std::ffi::{CStr, c_char, c_void};
use std::ptr;

use libloading::{Library, Symbol};

type EGLDisplay = *mut c_void;
type EGLConfig = *mut c_void;
type EGLContext = *mut c_void;
type EGLSurface = *mut c_void;
type EGLint = i32;
type EGLBoolean = u32;

const EGL_NONE: EGLint = 0x3038;
const EGL_TRUE: EGLBoolean = 1;
const EGL_SURFACE_TYPE: EGLint = 0x3033;
const EGL_PBUFFER_BIT: EGLint = 0x0001;
const EGL_RENDERABLE_TYPE: EGLint = 0x3040;
const EGL_OPENGL_ES3_BIT: EGLint = 0x0040;
const EGL_RED_SIZE: EGLint = 0x3024;
const EGL_GREEN_SIZE: EGLint = 0x3023;
const EGL_BLUE_SIZE: EGLint = 0x3022;
const EGL_ALPHA_SIZE: EGLint = 0x3021;
const EGL_WIDTH: EGLint = 0x3057;
const EGL_HEIGHT: EGLint = 0x3056;
const EGL_CONTEXT_CLIENT_VERSION: EGLint = 0x3098;

const EGL_PLATFORM_ANGLE_ANGLE: u32 = 0x3202;
const EGL_PLATFORM_ANGLE_TYPE_ANGLE: EGLint = 0x3203;
const EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE: EGLint = 0x3208;

type GetPlatformDisplayFn = unsafe extern "system" fn(u32, *mut c_void, *const EGLint) -> EGLDisplay;
type InitializeFn = unsafe extern "system" fn(EGLDisplay, *mut EGLint, *mut EGLint) -> EGLBoolean;
type ChooseConfigFn = unsafe extern "system" fn(EGLDisplay, *const EGLint, *mut EGLConfig, EGLint, *mut EGLint) -> EGLBoolean;
type CreatePbufferFn = unsafe extern "system" fn(EGLDisplay, EGLConfig, *const EGLint) -> EGLSurface;
type CreateContextFn = unsafe extern "system" fn(EGLDisplay, EGLConfig, EGLContext, *const EGLint) -> EGLContext;
type MakeCurrentFn = unsafe extern "system" fn(EGLDisplay, EGLSurface, EGLSurface, EGLContext) -> EGLBoolean;
type DestroyContextFn = unsafe extern "system" fn(EGLDisplay, EGLContext) -> EGLBoolean;
type DestroySurfaceFn = unsafe extern "system" fn(EGLDisplay, EGLSurface) -> EGLBoolean;
type GetErrorFn = unsafe extern "system" fn() -> EGLint;
type GetProcAddressFn = unsafe extern "system" fn(*const c_char) -> *mut c_void;
type QueryStringFn = unsafe extern "system" fn(EGLDisplay, EGLint) -> *const c_char;

const EGL_EXTENSIONS: EGLint = 0x3055;
const EGL_VENDOR: EGLint = 0x3053;
const EGL_VERSION: EGLint = 0x3054;

struct Egl {
    initialize: InitializeFn,
    choose_config: ChooseConfigFn,
    create_pbuffer: CreatePbufferFn,
    create_context: CreateContextFn,
    make_current: MakeCurrentFn,
    destroy_context: DestroyContextFn,
    destroy_surface: DestroySurfaceFn,
    get_error: GetErrorFn,
    get_proc_address: GetProcAddressFn,
    query_string: QueryStringFn,
    _lib: Library,
}

impl Egl {
    fn load() -> Result<Egl, String> {
        let lib = super::load_dll("libEGL.dll").map_err(|e| format!("ANGLE (libEGL.dll with libGLESv2.dll, next to the engine addon) not loadable: {e}"))?;
        Egl::resolve(lib)
    }

    fn resolve(lib: Library) -> Result<Egl, String> {
        unsafe fn sym<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
            let s: Symbol<T> = unsafe { lib.get(name) }.map_err(|e| format!("{}: {e}", String::from_utf8_lossy(name)))?;
            Ok(*s)
        }
        unsafe {
            Ok(Egl {
                initialize: sym(&lib, b"eglInitialize\0")?,
                choose_config: sym(&lib, b"eglChooseConfig\0")?,
                create_pbuffer: sym(&lib, b"eglCreatePbufferSurface\0")?,
                create_context: sym(&lib, b"eglCreateContext\0")?,
                make_current: sym(&lib, b"eglMakeCurrent\0")?,
                destroy_context: sym(&lib, b"eglDestroyContext\0")?,
                destroy_surface: sym(&lib, b"eglDestroySurface\0")?,
                get_error: sym(&lib, b"eglGetError\0")?,
                get_proc_address: sym(&lib, b"eglGetProcAddress\0")?,
                query_string: sym(&lib, b"eglQueryString\0")?,
                _lib: lib,
            })
        }
    }

    fn err(&self, what: &str) -> String {
        format!("{what}: EGL error 0x{:x}", unsafe { (self.get_error)() })
    }

    fn query(&self, display: EGLDisplay, name: EGLint) -> String {
        let p = unsafe { (self.query_string)(display, name) };
        if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() }
    }
}

pub struct Context {
    egl: Egl,
    display: EGLDisplay,
    surface: EGLSurface,
    context: EGLContext,
}

impl Context {

    pub fn new() -> Result<Context, String> {
        let egl = Egl::load()?;


        let client_exts = egl.query(ptr::null_mut(), EGL_EXTENSIONS);
        if !client_exts.split(' ').any(|e| e == "EGL_ANGLE_platform_angle_d3d") {
            return Err(format!("libEGL.dll is not ANGLE with a D3D11 backend (client extensions: {client_exts:?})"));
        }
        let get_platform_display: GetPlatformDisplayFn = unsafe {
            let p = (egl.get_proc_address)(c"eglGetPlatformDisplayEXT".as_ptr());
            if p.is_null() {
                return Err("ANGLE without EGL_EXT_platform_base".into());
            }
            std::mem::transmute(p)
        };
        let display_attribs = [EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE, EGL_NONE];
        let display = unsafe { get_platform_display(EGL_PLATFORM_ANGLE_ANGLE, ptr::null_mut(), display_attribs.as_ptr()) };
        if display.is_null() {
            return Err(egl.err("eglGetPlatformDisplayEXT"));
        }
        let (mut major, mut minor) = (0, 0);
        if unsafe { (egl.initialize)(display, &mut major, &mut minor) } != EGL_TRUE {
            return Err(egl.err("eglInitialize"));
        }
        let config_attribs = [
            EGL_SURFACE_TYPE,
            EGL_PBUFFER_BIT,
            EGL_RENDERABLE_TYPE,
            EGL_OPENGL_ES3_BIT,
            EGL_RED_SIZE,
            8,
            EGL_GREEN_SIZE,
            8,
            EGL_BLUE_SIZE,
            8,
            EGL_ALPHA_SIZE,
            8,
            EGL_NONE,
        ];
        let mut config: EGLConfig = ptr::null_mut();
        let mut count = 0;
        if unsafe { (egl.choose_config)(display, config_attribs.as_ptr(), &mut config, 1, &mut count) } != EGL_TRUE || count == 0 {
            return Err(egl.err("eglChooseConfig"));
        }
        let surface_attribs = [EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE];
        let surface = unsafe { (egl.create_pbuffer)(display, config, surface_attribs.as_ptr()) };
        if surface.is_null() {
            return Err(egl.err("eglCreatePbufferSurface"));
        }
        let context_attribs = [EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE];
        let context = unsafe { (egl.create_context)(display, config, ptr::null_mut(), context_attribs.as_ptr()) };
        if context.is_null() {
            let e = egl.err("eglCreateContext");
            unsafe { (egl.destroy_surface)(display, surface) };
            return Err(e);
        }
        let c = Context { egl, display, surface, context };
        c.make_current()?;
        Ok(c)
    }



    pub fn describe(&self) -> String {
        format!("{} {}", self.egl.query(self.display, EGL_VENDOR), self.egl.query(self.display, EGL_VERSION))
    }

    pub fn make_current(&self) -> Result<(), String> {
        if unsafe { (self.egl.make_current)(self.display, self.surface, self.surface, self.context) } != EGL_TRUE {
            return Err(self.egl.err("eglMakeCurrent"));
        }
        Ok(())
    }


    pub fn get_proc_address(&self, name: &CStr) -> *mut c_void {
        unsafe { (self.egl.get_proc_address)(name.as_ptr()) }
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        unsafe {
            (self.egl.make_current)(self.display, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
            (self.egl.destroy_context)(self.display, self.context);
            (self.egl.destroy_surface)(self.display, self.surface);

        }
    }
}
