//! 无头自测（`--headless`）：窗口停在所有屏幕之外，WebKit 照样当它看得见。
//!
//! WKWebView 发现窗口被挡住（在屏幕外、被别的窗口盖住、锁屏）就把页面当成隐藏：`requestAnimationFrame` 停掉，
//! 定时器降到大约每 200ms 一次，演示这类等 rAF 的自测步骤就一直等下去。关掉它的遮挡检测后，页面一直是 `visible`，
//! rAF 按 60fps 跑（2026-11-24 用独立的 WKWebView 实测：屏幕外窗口不关检测 rAF 3 秒 1 次，关了 180 次）。
//! 要在窗口显示之前关：页面已经被判成隐藏后再关不会恢复，得重新显示一次窗口（同一个实测）。
//! 私有 API `_setWindowOcclusionDetectionEnabled:`：先 respondsToSelector:，系统里没有就返回 false，调用方把窗口挪回屏幕上。

#[cfg(target_os = "macos")]
pub unsafe fn disable_occlusion_detection(wk_webview: *mut std::ffi::c_void) -> bool {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};

    let wv = wk_webview as *mut AnyObject;
    if wv.is_null() {
        return false;
    }
    unsafe {
        let ok: Bool = msg_send![wv, respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)];
        if !ok.as_bool() {
            return false;
        }
        let _: () = msg_send![wv, _setWindowOcclusionDetectionEnabled: Bool::NO];
    }
    true
}

#[cfg(not(target_os = "macos"))]
pub unsafe fn disable_occlusion_detection(_: *mut std::ffi::c_void) -> bool {
    false
}
