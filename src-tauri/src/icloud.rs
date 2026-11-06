//! iCloud Drive 自检：TCC 能否访问、NSFileCoordinator 协调读写、同步状态资源值、
//! 驱逐成「无数据文件」后再读能否按需下载。只动 iCloud Drive/Excalidraw-P0-test/ 这一个测试文件夹。

use std::{fs, path::PathBuf, time::{Duration, Instant}};

use serde_json::{json, Value};

#[tauri::command]
pub fn icloud_probe() -> Value {
    probe()
}

const SF_DATALESS: u32 = 0x4000_0000;

fn st_flags(p: &PathBuf) -> Option<u32> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::stat(c.as_ptr(), &mut st) } == 0).then_some(st.st_flags)
}

pub fn probe() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let root = PathBuf::from(&home).join("Library/Mobile Documents/com~apple~CloudDocs");
    let dir = root.join("Excalidraw-P0-test");
    let file = dir.join("probe.excalidraw");
    let mut r = json!({ "root": root.display().to_string() });

    r["listRoot"] = match fs::read_dir(&root) {
        Ok(it) => json!({ "ok": true, "entries": it.count() }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    };
    if let Err(e) = fs::create_dir_all(&dir) {
        r["mkdir"] = json!({ "ok": false, "error": e.to_string() });
        return r;
    }

    // 200KB 左右的正文，接近一张中等复杂度的图
    let payload: String = format!(
        "{{\"type\":\"excalidraw\",\"version\":2,\"source\":\"p0-probe\",\"elements\":[],\"appState\":{{}},\"pad\":\"{}\"}}",
        "x".repeat(200_000)
    );
    #[cfg(target_os = "macos")]
    {
        let t = Instant::now();
        let w = mac::coordinated_write(&file, payload.as_bytes());
        r["coordinatedWrite"] = json!({ "ok": w.is_ok(), "ms": t.elapsed().as_secs_f64() * 1e3, "error": w.err() });
        let t = Instant::now();
        let rd = mac::coordinated_read(&file);
        r["coordinatedRead"] = json!({ "ok": rd.as_ref().map(|b| b == payload.as_bytes()).unwrap_or(false), "ms": t.elapsed().as_secs_f64() * 1e3 });
        r["isUbiquitous"] = json!(mac::is_ubiquitous(&file));
        r["resourceValuesAfterWrite"] = json!(mac::resource_values(&file));

        // 等上传完成才能驱逐
        let t = Instant::now();
        let mut uploaded = false;
        while t.elapsed() < Duration::from_secs(90) {
            if mac::resource_values(&file).contains("NSURLUbiquitousItemIsUploadedKey = 1") {
                uploaded = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        r["upload"] = json!({ "uploaded": uploaded, "waitedMs": t.elapsed().as_millis() as u64 });
        if uploaded {
            r["evict"] = json!(mac::evict(&file));
            let t = Instant::now();
            let mut dataless = false;
            while t.elapsed() < Duration::from_secs(15) {
                if st_flags(&file).map(|f| f & SF_DATALESS != 0).unwrap_or(false) {
                    dataless = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            r["afterEvict"] = json!({
                "dataless": dataless, "waitedMs": t.elapsed().as_millis() as u64,
                "placeholderIcloudFile": dir.join(".probe.excalidraw.icloud").exists(),
                "resourceValues": mac::resource_values(&file),
            });
            let t = Instant::now();
            let rd = mac::coordinated_read(&file);
            r["readEvicted"] = json!({
                "ok": rd.as_ref().map(|b| b == payload.as_bytes()).unwrap_or(false),
                "ms": t.elapsed().as_secs_f64() * 1e3,
                "error": rd.err(),
                "datalessAfter": st_flags(&file).map(|f| f & SF_DATALESS != 0),
            });
        }
        r["unresolvedConflicts"] = json!(mac::conflict_count(&file));
    }
    r
}

#[cfg(target_os = "macos")]
pub use mac::{conflict_versions, coordinated_read, coordinated_write, resolve_conflicts, sync_status, trash};

/// iCloud 冲突版本（NSFileVersion）
#[derive(serde::Serialize, Clone)]
pub struct ConflictVersion {
    /// 版本内容所在的路径（系统的版本库里），只读
    pub path: String,
    pub device: String,
    pub modified: f64,
}

/// iCloud 同步状态（非 iCloud 路径 ubiquitous=false）
#[derive(serde::Serialize, Default)]
pub struct SyncStatus {
    pub ubiquitous: bool,
    pub dataless: bool,
    pub downloaded: bool,
    pub uploaded: bool,
    pub uploading: bool,
    pub downloading: bool,
    pub conflict: bool,
}

pub fn is_dataless(p: &std::path::Path) -> bool {
    st_flags(&p.to_path_buf()).map(|f| f & SF_DATALESS != 0).unwrap_or(false)
}

#[cfg(target_os = "macos")]
mod mac {
    use std::{path::Path, ptr::NonNull};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, ClassType};
    use objc2_foundation::{NSArray, NSError, NSFileManager, NSString, NSURL};

    fn url(p: &Path) -> Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&p.display().to_string()))
    }
    fn coordinator() -> Retained<AnyObject> {
        let cls = AnyClass::get(c"NSFileCoordinator").unwrap();
        unsafe {
            let obj: *mut AnyObject = msg_send![cls, alloc];
            let obj: *mut AnyObject = msg_send![obj, initWithFilePresenter: std::ptr::null_mut::<AnyObject>()];
            Retained::from_raw(obj).unwrap()
        }
    }
    fn path_of(u: NonNull<AnyObject>) -> String {
        unsafe { (&*(u.as_ptr() as *const NSURL)).path().map(|s| s.to_string()).unwrap_or_default() }
    }
    fn err_text(e: *mut NSError) -> Option<String> {
        (!e.is_null()).then(|| unsafe { (*e).localizedDescription().to_string() })
    }

    /// NSFileCoordinatorWritingForReplacing：写临时文件再 rename，和真实保存链路一致
    pub fn coordinated_write(p: &Path, bytes: &[u8]) -> Result<(), String> {
        let c = coordinator();
        let u = url(p);
        let bytes = bytes.to_vec();
        let result = std::cell::RefCell::new(Err::<(), String>("accessor not called".into()));
        let block = RcBlock::new(|nu: NonNull<AnyObject>| {
            let target = std::path::PathBuf::from(path_of(nu));
            let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let tmp = target.with_file_name(format!(".{name}.tmp~"));
            *result.borrow_mut() = std::fs::write(&tmp, &bytes)
                .and_then(|_| std::fs::rename(&tmp, &target))
                .map_err(|e| e.to_string());
        });
        let mut err: *mut NSError = std::ptr::null_mut();
        unsafe {
            let _: () = msg_send![&*c, coordinateWritingItemAtURL: &*u, options: 8usize, error: &mut err, byAccessor: &*block];
        }
        drop(block);
        if let Some(e) = err_text(err) {
            return Err(e);
        }
        result.into_inner()
    }

    pub fn coordinated_read(p: &Path) -> Result<Vec<u8>, String> {
        let c = coordinator();
        let u = url(p);
        let result = std::cell::RefCell::new(Err::<Vec<u8>, String>("accessor not called".into()));
        let block = RcBlock::new(|nu: NonNull<AnyObject>| {
            *result.borrow_mut() = std::fs::read(path_of(nu)).map_err(|e| e.to_string());
        });
        let mut err: *mut NSError = std::ptr::null_mut();
        unsafe {
            let _: () = msg_send![&*c, coordinateReadingItemAtURL: &*u, options: 0usize, error: &mut err, byAccessor: &*block];
        }
        drop(block);
        if let Some(e) = err_text(err) {
            return Err(e);
        }
        result.into_inner()
    }

    pub fn is_ubiquitous(p: &Path) -> bool {
        let fm = NSFileManager::defaultManager();
        let u = url(p);
        let b: Bool = unsafe { msg_send![&*fm, isUbiquitousItemAtURL: &*u] };
        b.as_bool()
    }

    pub fn resource_values(p: &Path) -> String {
        let u = url(p);
        let keys = [
            "NSURLUbiquitousItemDownloadingStatusKey",
            "NSURLUbiquitousItemIsUploadedKey",
            "NSURLUbiquitousItemIsUploadingKey",
            "NSURLUbiquitousItemIsDownloadingKey",
            "NSURLUbiquitousItemHasUnresolvedConflictsKey",
            "NSURLIsUbiquitousItemKey",
        ]
        .map(NSString::from_str);
        let arr = NSArray::from_retained_slice(&keys);
        // 资源值有缓存，先清掉再读
        unsafe {
            let _: () = msg_send![&*u, removeAllCachedResourceValues];
            let dict: *mut AnyObject = msg_send![&*u, resourceValuesForKeys: &*arr, error: std::ptr::null_mut::<*mut NSError>()];
            if dict.is_null() {
                return "nil".into();
            }
            let d: *mut NSString = msg_send![dict, description];
            (*d).to_string().split_whitespace().collect::<Vec<_>>().join(" ")
        }
    }

    pub fn evict(p: &Path) -> Result<(), String> {
        let fm = NSFileManager::defaultManager();
        let u = url(p);
        let mut err: *mut NSError = std::ptr::null_mut();
        let ok: Bool = unsafe { msg_send![&*fm, evictUbiquitousItemAtURL: &*u, error: &mut err] };
        if ok.as_bool() { Ok(()) } else { Err(err_text(err).unwrap_or_default()) }
    }

    pub fn conflict_count(p: &Path) -> usize {
        let Some(cls) = AnyClass::get(c"NSFileVersion") else { return 0 };
        let u = url(p);
        unsafe {
            let arr: *mut AnyObject = msg_send![cls, unresolvedConflictVersionsOfItemAtURL: &*u];
            if arr.is_null() { 0 } else { msg_send![arr, count] }
        }
    }

    fn resource(u: &NSURL, key: &str) -> Option<Retained<AnyObject>> {
        let k = NSString::from_str(key);
        let mut out: *mut AnyObject = std::ptr::null_mut();
        let ok: Bool = unsafe { msg_send![u, getResourceValue: &mut out, forKey: &*k, error: std::ptr::null_mut::<*mut NSError>()] };
        if !ok.as_bool() || out.is_null() {
            return None;
        }
        unsafe { Retained::retain(out) }
    }
    fn bool_of(o: Option<Retained<AnyObject>>) -> bool {
        o.map(|v| { let b: Bool = unsafe { msg_send![&*v, boolValue] }; b.as_bool() }).unwrap_or(false)
    }

    pub fn sync_status(p: &Path) -> super::SyncStatus {
        let u = url(p);
        unsafe { let _: () = msg_send![&*u, removeAllCachedResourceValues]; }
        let ubiquitous = bool_of(resource(&u, "NSURLIsUbiquitousItemKey"));
        if !ubiquitous {
            return super::SyncStatus::default();
        }
        let status = resource(&u, "NSURLUbiquitousItemDownloadingStatusKey")
            .map(|v| unsafe { (*(Retained::as_ptr(&v) as *const NSString)).to_string() })
            .unwrap_or_default();
        super::SyncStatus {
            ubiquitous,
            dataless: super::is_dataless(p),
            downloaded: status.ends_with("Current") || status.ends_with("Downloaded"),
            uploaded: bool_of(resource(&u, "NSURLUbiquitousItemIsUploadedKey")),
            uploading: bool_of(resource(&u, "NSURLUbiquitousItemIsUploadingKey")),
            downloading: bool_of(resource(&u, "NSURLUbiquitousItemIsDownloadingKey")),
            conflict: bool_of(resource(&u, "NSURLUbiquitousItemHasUnresolvedConflictsKey")),
        }
    }

    /// 移到废纸篓（可恢复），返回废纸篓里的新路径
    pub fn trash(p: &Path) -> Result<String, String> {
        let fm = NSFileManager::defaultManager();
        let u = url(p);
        let mut out: *mut NSURL = std::ptr::null_mut();
        let mut err: *mut NSError = std::ptr::null_mut();
        let ok: Bool = unsafe { msg_send![&*fm, trashItemAtURL: &*u, resultingItemURL: &mut out, error: &mut err] };
        if !ok.as_bool() {
            return Err(err_text(err).unwrap_or_else(|| "移到废纸篓失败".into()));
        }
        Ok(if out.is_null() { String::new() } else { unsafe { (*out).path().map(|s| s.to_string()).unwrap_or_default() } })
    }

    pub fn conflict_versions(p: &Path) -> Vec<super::ConflictVersion> {
        let Some(cls) = AnyClass::get(c"NSFileVersion") else { return vec![] };
        let u = url(p);
        let mut out = vec![];
        unsafe {
            let arr: *mut AnyObject = msg_send![cls, unresolvedConflictVersionsOfItemAtURL: &*u];
            if arr.is_null() {
                return out;
            }
            let n: usize = msg_send![arr, count];
            for i in 0..n {
                let v: *mut AnyObject = msg_send![arr, objectAtIndex: i];
                let vu: *mut NSURL = msg_send![v, URL];
                let name: *mut NSString = msg_send![v, localizedNameOfSavingComputer];
                let date: *mut AnyObject = msg_send![v, modificationDate];
                let modified: f64 = if date.is_null() { 0.0 } else { msg_send![date, timeIntervalSince1970] };
                out.push(super::ConflictVersion {
                    path: if vu.is_null() { String::new() } else { (*vu).path().map(|s| s.to_string()).unwrap_or_default() },
                    device: if name.is_null() { String::new() } else { (*name).to_string() },
                    modified,
                });
            }
        }
        out
    }

    /// 冲突版本都已合并进当前文件：标记已解决并清掉
    pub fn resolve_conflicts(p: &Path) -> Result<(), String> {
        let Some(cls) = AnyClass::get(c"NSFileVersion") else { return Ok(()) };
        let u = url(p);
        unsafe {
            let arr: *mut AnyObject = msg_send![cls, unresolvedConflictVersionsOfItemAtURL: &*u];
            if !arr.is_null() {
                let n: usize = msg_send![arr, count];
                for i in 0..n {
                    let v: *mut AnyObject = msg_send![arr, objectAtIndex: i];
                    let _: () = msg_send![v, setResolved: Bool::YES];
                }
            }
            let mut err: *mut NSError = std::ptr::null_mut();
            let ok: Bool = msg_send![cls, removeOtherVersionsOfItemAtURL: &*u, error: &mut err];
            if !ok.as_bool() {
                return Err(err_text(err).unwrap_or_default());
            }
        }
        Ok(())
    }

    #[allow(dead_code)]
    fn _assert_class() {
        let _ = NSURL::class();
    }
}
