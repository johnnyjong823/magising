// 新版本提示（輕量版）：只讀 GitHub 的 releases/latest 比對版本號，有新版就在控制面板與系統匣提示，
// 由使用者自己開 Release 頁下載安裝。不在背景下載、不自動安裝。
// 送出的只有一般的 HTTPS 請求（User-Agent 含版本號），不帶任何歌曲或使用資料
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const API: &str = "https://api.github.com/repos/johnnyjong823/magising/releases/latest";
/// 只開這個前綴的網址，避免 API 回傳的內容叫瀏覽器開到別的地方
const RELEASE_PREFIX: &str = "https://github.com/johnnyjong823/magising/releases/";
const FALLBACK_URL: &str = "https://github.com/johnnyjong823/magising/releases/latest";
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const FIRST_DELAY: Duration = Duration::from_secs(15);
const INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// 每小時醒來看一次牆上時間：電腦睡眠時 sleep 不計時，直接睡 24 小時可能好幾天才查一次
const TICK: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Default)]
struct Found {
    version: String,
    url: String,
}

static FOUND: Mutex<Option<Found>> = Mutex::new(None);
/// 使用者按了「稍後」的版本：這次執行期間不再跳面板橫幅（系統匣項目保留）
static DISMISSED: Mutex<Option<String>> = Mutex::new(None);

/// "v0.4.2" → [0, 4, 2]；"-beta" 之類的後綴忽略
fn parse(v: &str) -> Vec<u64> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let core = v.split(['-', '+']).next().unwrap_or("");
    core.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

fn newer(latest: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse(latest), parse(current));
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a > b
}

fn fetch() -> Result<Option<Found>, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build();
    let v: Value = agent
        .get(API)
        .set("User-Agent", concat!("MagiSing/", env!("CARGO_PKG_VERSION")))
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    let tag = v["tag_name"].as_str().unwrap_or("");
    if tag.is_empty() || !newer(tag, CURRENT) {
        return Ok(None);
    }
    let url = v["html_url"].as_str().filter(|u| u.starts_with(RELEASE_PREFIX)).unwrap_or(FALLBACK_URL);
    Ok(Some(Found { version: tag.trim_start_matches(['v', 'V']).to_string(), url: url.to_string() }))
}

fn status() -> Value {
    let found = FOUND.lock().unwrap().clone();
    let dismissed = DISMISSED.lock().unwrap().clone();
    match found {
        Some(f) => json!({ "current": CURRENT, "latest": f.version, "available": true, "dismissed": dismissed.as_deref() == Some(f.version.as_str()) }),
        None => json!({ "current": CURRENT, "latest": null, "available": false, "dismissed": false }),
    }
}

/// 檢查一次並更新狀態；有新版時通知面板、重建系統匣選單
fn check(app: &AppHandle) -> Result<Value, String> {
    let r = fetch();
    match &r {
        Ok(Some(f)) => crate::paths::log(&format!("[update] 有新版本 v{}（目前 v{CURRENT}）", f.version)),
        Ok(None) => crate::paths::log(&format!("[update] 已是最新版本 v{CURRENT}")),
        Err(e) => crate::paths::log(&format!("[update] 檢查失敗：{e}")),
    }
    let found = r?;
    let changed = {
        let mut g = FOUND.lock().unwrap();
        let changed = g.as_ref().map(|f| f.version.clone()) != found.as_ref().map(|f| f.version.clone());
        *g = found;
        changed
    };
    let s = status();
    if changed {
        crate::tray::refresh(app);
        let _ = app.emit("update", &s);
    }
    Ok(s)
}

fn enabled() -> bool {
    crate::settings::get()["checkUpdates"].as_bool().unwrap_or(true)
}

/// 啟動後等一下再查（不跟找歌詞搶網路），之後每天查一次（失敗也等到隔天）。設定關掉時跳過
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_DELAY);
        let mut last: Option<std::time::SystemTime> = None;
        loop {
            let due = last.and_then(|t| t.elapsed().ok()).map(|e| e >= INTERVAL).unwrap_or(true);
            if due && enabled() {
                let _ = check(&app);
                last = Some(std::time::SystemTime::now());
            }
            std::thread::sleep(TICK);
        }
    });
}

/// 設定改了 checkUpdates：關掉就收起已經顯示的提示；打開就馬上查一次
pub fn on_setting_changed(app: &AppHandle) {
    if enabled() {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = check(&app);
        });
    } else if FOUND.lock().unwrap().take().is_some() {
        crate::tray::refresh(app);
        let _ = app.emit("update", status());
    }
}

/// 系統匣用：有新版時回傳版本號
pub fn available() -> Option<String> {
    FOUND.lock().unwrap().as_ref().map(|f| f.version.clone())
}

pub fn open() {
    let url = FOUND.lock().unwrap().as_ref().map(|f| f.url.clone()).unwrap_or_else(|| FALLBACK_URL.to_string());
    let _ = std::process::Command::new("explorer.exe").arg(url).spawn();
}

#[tauri::command]
pub fn update_status() -> Value {
    status()
}

/// 「關於 → 檢查更新」：不管設定開關，立刻查一次；之前按過「稍後」的也重新顯示
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = check(&app);
        // 查成功才取消「稍後」，並一律通知面板（版本沒變時 check 不會送事件）
        if r.is_ok() {
            *DISMISSED.lock().unwrap() = None;
            let _ = app.emit("update", status());
        }
        r.map(|_| status())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn update_open() {
    open();
}

#[tauri::command]
pub fn update_dismiss(app: AppHandle) {
    *DISMISSED.lock().unwrap() = available();
    let _ = app.emit("update", status());
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn compares_versions() {
        assert!(newer("v0.4.2", "0.4.1"));
        assert!(newer("v0.10.0", "0.9.9"));
        assert!(newer("1.0", "0.9.9"));
        assert!(!newer("v0.4.1", "0.4.1"));
        assert!(!newer("v0.4.0", "0.4.1"));
        assert!(!newer("0.4.1-beta", "0.4.1"));
        assert!(!newer("", "0.4.1"));
    }
}
