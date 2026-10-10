pub fn cursor_position() -> Option<(i32, i32)> {
    #[cfg(target_os = "linux")]
    {
        return linux::position();
    }
    #[cfg(target_os = "macos")]
    {
        return macos::position();
    }
    #[cfg(target_os = "windows")]
    {
        return windows::position();
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::c_int;

    #[link(name = "X11")]
    unsafe extern "C" {
        fn XOpenDisplay(name: *const i8) -> *mut std::ffi::c_void;
        fn XCloseDisplay(display: *mut std::ffi::c_void) -> c_int;
        fn XDefaultRootWindow(display: *mut std::ffi::c_void) -> u64;
        fn XQueryPointer(
            display: *mut std::ffi::c_void,
            window: u64,
            root_return: *mut u64,
            child_return: *mut u64,
            root_x: *mut c_int,
            root_y: *mut c_int,
            win_x: *mut c_int,
            win_y: *mut c_int,
            mask: *mut u32,
        ) -> c_int;
    }

    pub fn position() -> Option<(i32, i32)> {
        unsafe {
            let display = XOpenDisplay(std::ptr::null());
            if display.is_null() {
                return None;
            }
            let root = XDefaultRootWindow(display);
            let mut root_return = 0u64;
            let mut child_return = 0u64;
            let mut root_x = 0;
            let mut root_y = 0;
            let mut win_x = 0;
            let mut win_y = 0;
            let mut mask = 0u32;
            let ok = XQueryPointer(
                display,
                root,
                &mut root_return,
                &mut child_return,
                &mut root_x,
                &mut root_y,
                &mut win_x,
                &mut win_y,
                &mut mask,
            );
            XCloseDisplay(display);
            if ok == 0 {
                None
            } else {
                Some((root_x, root_y))
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreate(source: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
        fn CFRelease(value: *mut std::ffi::c_void);
    }

    pub fn position() -> Option<(i32, i32)> {
        unsafe {
            let event = CGEventCreate(std::ptr::null_mut());
            if event.is_null() {
                return None;
            }
            let point = CGEventGetLocation(event);
            CFRelease(event);
            Some((point.x.round() as i32, point.y.round() as i32))
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[link(name = "user32")]
    unsafe extern "C" {
        fn GetCursorPos(point: *mut Point) -> i32;
    }

    pub fn position() -> Option<(i32, i32)> {
        unsafe {
            let mut point = Point { x: 0, y: 0 };
            if GetCursorPos(&mut point) == 0 {
                None
            } else {
                Some((point.x, point.y))
            }
        }
    }
}
