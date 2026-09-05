use std::ffi::{CStr, c_void};

pub struct GlContext {

    ctx: platform::Context,
}

impl GlContext {

    pub fn new() -> Result<GlContext, String> {
        Ok(GlContext { ctx: platform::Context::new()? })
    }


    pub fn get_proc_address(&self, name: &CStr) -> *mut c_void {
        self.ctx.get_proc_address(name)
    }



    pub fn describe(&self) -> String {
        self.ctx.describe()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{CStr, c_void};
    use std::ptr;

    type CGLPixelFormatObj = *mut c_void;
    type CGLContextObj = *mut c_void;

    const K_CGL_PFA_ACCELERATED: u32 = 73;
    const K_CGL_PFA_ALLOW_OFFLINE_RENDERERS: u32 = 96;
    const K_CGL_PFA_OPENGL_PROFILE: u32 = 99;
    const K_CGL_OGLP_VERSION_GL4_CORE: u32 = 0x4100;

    #[link(name = "OpenGL", kind = "framework")]
    unsafe extern "C" {
        fn CGLChoosePixelFormat(attribs: *const u32, pix: *mut CGLPixelFormatObj, npix: *mut i32) -> i32;
        fn CGLReleasePixelFormat(pix: CGLPixelFormatObj);
        fn CGLCreateContext(pix: CGLPixelFormatObj, share: CGLContextObj, ctx: *mut CGLContextObj) -> i32;
        fn CGLDestroyContext(ctx: CGLContextObj) -> i32;
        fn CGLSetCurrentContext(ctx: CGLContextObj) -> i32;
        fn CGLErrorString(code: i32) -> *const std::ffi::c_char;
    }

    fn cgl_err(code: i32, what: &str) -> String {
        let msg = unsafe { CStr::from_ptr(CGLErrorString(code)).to_string_lossy() };
        format!("{what}: {msg}")
    }

    pub struct Context {
        ctx: CGLContextObj,

        lib: *mut c_void,
    }

    impl Context {
        pub fn new() -> Result<Context, String> {
            let attribs = [
                K_CGL_PFA_OPENGL_PROFILE,
                K_CGL_OGLP_VERSION_GL4_CORE,
                K_CGL_PFA_ACCELERATED,
                K_CGL_PFA_ALLOW_OFFLINE_RENDERERS,
                0,
            ];
            let mut pix: CGLPixelFormatObj = ptr::null_mut();
            let mut npix = 0;
            let r = unsafe { CGLChoosePixelFormat(attribs.as_ptr(), &mut pix, &mut npix) };
            if r != 0 || pix.is_null() {
                return Err(cgl_err(r, "CGLChoosePixelFormat"));
            }
            let mut ctx: CGLContextObj = ptr::null_mut();
            let r = unsafe { CGLCreateContext(pix, ptr::null_mut(), &mut ctx) };
            unsafe { CGLReleasePixelFormat(pix) };
            if r != 0 || ctx.is_null() {
                return Err(cgl_err(r, "CGLCreateContext"));
            }
            let lib = unsafe {
                libc::dlopen(
                    c"/System/Library/Frameworks/OpenGL.framework/OpenGL".as_ptr(),
                    libc::RTLD_LAZY | libc::RTLD_LOCAL,
                )
            };
            if lib.is_null() {
                unsafe { CGLDestroyContext(ctx) };
                return Err("dlopen OpenGL.framework failed".into());
            }
            let c = Context { ctx, lib };
            c.make_current()?;
            Ok(c)
        }

        pub fn make_current(&self) -> Result<(), String> {
            let r = unsafe { CGLSetCurrentContext(self.ctx) };
            if r != 0 { Err(cgl_err(r, "CGLSetCurrentContext")) } else { Ok(()) }
        }

        pub fn get_proc_address(&self, name: &CStr) -> *mut c_void {
            unsafe { libc::dlsym(self.lib, name.as_ptr()) }
        }

        pub fn describe(&self) -> String {
            "CGL OpenGL 4 core".into()
        }
    }

    impl Drop for Context {
        fn drop(&mut self) {
            unsafe {
                CGLSetCurrentContext(ptr::null_mut());
                CGLDestroyContext(self.ctx);
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    pub use crate::windows::egl::Context;
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use std::ffi::{CStr, c_void};

    pub struct Context;

    impl Context {
        pub fn new() -> Result<Context, String> {
            Err("offscreen GL context is only implemented on macOS and Windows so far".into())
        }

        pub fn get_proc_address(&self, _name: &CStr) -> *mut c_void {
            std::ptr::null_mut()
        }

        pub fn describe(&self) -> String {
            "none".into()
        }
    }
}
