//! 关掉 WKWebView 的 60fps 限制（WebKit 私有偏好 PreferPageRenderingUpdatesNear60FPSEnabled）。
//! 私有 API：每一步都先 respondsToSelector:，系统改了就静默降级回 60fps。

#[cfg(target_os = "macos")]
pub unsafe fn set_60fps_cap(wk_webview: *mut std::ffi::c_void, enabled: bool) -> bool {
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    use objc2_foundation::NSString;

    const KEY: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";
    let wv = wk_webview as *mut AnyObject;
    if wv.is_null() {
        return false;
    }
    unsafe {
        let config: *mut AnyObject = msg_send![wv, configuration];
        let prefs: *mut AnyObject = msg_send![config, preferences];
        let Some(cls) = AnyClass::get(c"WKPreferences") else { return false };
        let ok: Bool = msg_send![cls, respondsToSelector: sel!(_features)];
        let can_set: Bool = msg_send![prefs, respondsToSelector: sel!(_setEnabled:forFeature:)];
        if !ok.as_bool() || !can_set.as_bool() {
            return false;
        }
        let features: *mut AnyObject = msg_send![cls, _features];
        let count: usize = msg_send![features, count];
        for i in 0..count {
            let f: *mut AnyObject = msg_send![features, objectAtIndex: i];
            let key: *mut AnyObject = msg_send![f, key];
            if !key.is_null() && (*(key as *const NSString)).to_string() == KEY {
                let _: () = msg_send![prefs, _setEnabled: Bool::new(enabled), forFeature: f];
                return true;
            }
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
pub unsafe fn set_60fps_cap(_: *mut std::ffi::c_void, _: bool) -> bool {
    false
}
