// 資料夾：安裝版存 %APPDATA%\MagiSing\；exe 同目錄有 data\ 資料夾時視為免安裝版，存在那裡
// 舊名「強尼練歌坊」存在 %APPDATA%\JohnnyKaraoke\，第一次啟動時複製過來（舊資料夾保留不動）
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DIR: OnceLock<PathBuf> = OnceLock::new();
// 搬移結果要等資料夾決定後才能寫進紀錄檔（log() 本身會呼叫 data_dir()）
static MIGRATE_MSG: OnceLock<String> = OnceLock::new();

pub fn data_dir() -> &'static PathBuf {
    DIR.get_or_init(|| {
        let portable = std::env::current_exe().ok().and_then(|p| Some(p.parent()?.join("data"))).filter(|p| p.is_dir());
        let dir = portable.unwrap_or_else(|| {
            let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
            let dir = base.join("MagiSing");
            let old = base.join("JohnnyKaraoke");
            if !dir.exists() && old.is_dir() {
                let msg = match migrate(&old, &dir) {
                    Ok(()) => format!("[migrate] 已從 {} 複製舊資料", old.display()),
                    Err(e) => format!("[migrate] 從 {} 複製舊資料失敗：{e}", old.display()),
                };
                let _ = MIGRATE_MSG.set(msg);
            }
            dir
        });
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
}

/// 從舊資料夾搬設定與歌詞快取。先做在暫存資料夾，全部成功才改名成正式資料夾：
/// 中途失敗或被關掉，下次啟動會重試，不會留下半套資料。
/// 舊版可能還開著，資料庫用 VACUUM INTO 取一致的快照，不直接複製 -wal/-shm
fn migrate(old: &Path, dir: &Path) -> Result<(), String> {
    let tmp = dir.with_extension("migrating");
    let _ = std::fs::remove_dir_all(&tmp);
    let r = (|| {
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        for name in ["settings.json", "overlay.json"] {
            if old.join(name).is_file() {
                std::fs::copy(old.join(name), tmp.join(name)).map_err(|e| format!("{name}：{e}"))?;
            }
        }
        let db = old.join("karaoke.db");
        if db.is_file() {
            let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
            let c = rusqlite::Connection::open_with_flags(&db, flags).map_err(|e| format!("karaoke.db：{e}"))?;
            c.execute("VACUUM INTO ?1", [tmp.join("karaoke.db").to_string_lossy().as_ref()]).map_err(|e| format!("karaoke.db：{e}"))?;
        }
        std::fs::rename(&tmp, dir).map_err(|e| e.to_string())
    })();
    if r.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    r
}

pub fn file(name: &str) -> PathBuf {
    data_dir().join(name)
}

/// 簡單的紀錄檔（data\app.log）；超過 1 MB 時在啟動時清空
pub fn init_log() {
    let f = file("app.log");
    if std::fs::metadata(&f).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&f);
    }
    if let Some(msg) = MIGRATE_MSG.get() {
        log(msg);
    }
}

pub fn log(msg: &str) {
    let line = format!("[{}] {msg}\n", now_text());
    eprint!("{line}");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file("app.log")) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn now_text() -> String {
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // UTC 時間，只用來排查問題
    format!("{:02}:{:02}:{:02}Z", (s / 3600) % 24, (s / 60) % 60, s % 60)
}

#[tauri::command]
pub fn log_line(msg: String) {
    log(&msg);
}

#[tauri::command]
pub fn open_data_dir() {
    let _ = std::process::Command::new("explorer.exe").arg(data_dir()).spawn();
}

#[tauri::command]
pub fn data_dir_path() -> String {
    data_dir().display().to_string()
}

/// 「關於」頁的外部連結。只開這張表裡的網址，不讓網頁端任意叫起程式。
/// 網址留空 = 還沒準備好，面板不顯示對應按鈕（例如斗內連結還沒申請好）
const LINKS: &[(&str, &str)] = &[
    ("site", "https://johnnyx9487.bdcweb.org/"),
    ("github", "https://github.com/johnnyjong823/magising"),
    ("donate", ""), // 綠界實況主收款的斗內網址
];

#[tauri::command]
pub fn open_link(which: String) {
    if let Some((_, url)) = LINKS.iter().find(|(k, u)| *k == which && !u.is_empty()) {
        let _ = std::process::Command::new("explorer.exe").arg(url).spawn();
    }
}

/// 有設定網址的連結名稱
#[tauri::command]
pub fn links_enabled() -> Vec<&'static str> {
    LINKS.iter().filter(|(_, u)| !u.is_empty()).map(|(k, _)| *k).collect()
}

/// 用記事本開安裝目錄裡的文件：使用條款（LICENSE.txt）、開源授權（THIRD-PARTY-NOTICES.txt）
#[tauri::command]
pub fn open_doc(app: tauri::AppHandle, which: String) -> Result<(), String> {
    use tauri::Manager;
    let name = match which.as_str() {
        "license" => "LICENSE.txt",
        "notices" => "THIRD-PARTY-NOTICES.txt",
        _ => return Err("未知的文件".into()),
    };
    let f = app.path().resource_dir().map_err(|e| e.to_string())?.join(name);
    if !f.is_file() {
        return Err(format!("找不到 {}", f.display()));
    }
    std::process::Command::new("notepad.exe").arg(f).spawn().map(|_| ()).map_err(|e| e.to_string())
}
