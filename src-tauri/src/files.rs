// 本機 LRC 資料夾（LYR §4.5 順序 3）與拖入的 .lrc 檔
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct LrcFile {
    name: String,
    path: String,
}

fn walk(dir: &Path, depth: u32, out: &mut Vec<LrcFile>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= 5000 {
            return;
        }
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                walk(&p, depth - 1, out);
            }
        } else if is_lrc(&p) {
            out.push(LrcFile {
                name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                path: p.display().to_string(),
            });
        }
    }
}

fn is_lrc(p: &Path) -> bool {
    p.extension().map(|x| x.eq_ignore_ascii_case("lrc")).unwrap_or(false)
}

/// 網路路徑（\\server\share）不讀：避免卡住，也避免把 Windows 認證送到別台機器
fn is_unc(p: &str) -> bool {
    p.starts_with(r"\\") || p.starts_with("//")
}

/// 列出資料夾（含兩層子資料夾）裡的 .lrc；name 是不含副檔名的檔名
#[tauri::command]
pub async fn lrc_list(dir: String) -> Vec<LrcFile> {
    if dir.is_empty() || is_unc(&dir) {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        walk(Path::new(&dir), 2, &mut out);
        out
    })
    .await
    .unwrap_or_default()
}

/// 讀 .lrc 文字檔。常見編碼：UTF-8（含 BOM）、UTF-16、GBK、Big5
#[tauri::command]
pub fn lrc_read(path: String) -> Result<String, String> {
    if is_unc(&path) {
        return Err("不支援網路資料夾裡的檔案".into());
    }
    let p = PathBuf::from(&path);
    if !is_lrc(&p) {
        return Err("只能讀取 .lrc 檔".into());
    }
    let len = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if len > 1_000_000 {
        return Err("檔案太大，不像是歌詞檔".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(decode(&bytes))
}

fn decode(b: &[u8]) -> String {
    use encoding_rs::{BIG5, GB18030, UTF_16BE, UTF_16LE};
    if let Some(rest) = b.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if b.starts_with(&[0xFF, 0xFE]) {
        return UTF_16LE.decode(&b[2..]).0.into_owned();
    }
    if b.starts_with(&[0xFE, 0xFF]) {
        return UTF_16BE.decode(&b[2..]).0.into_owned();
    }
    if let Ok(s) = std::str::from_utf8(b) {
        return s.to_string();
    }
    // GBK 與 Big5 都可能「解得開」，選替代字元較少、常用字比例較高的那個
    let (gb, _, gb_err) = GB18030.decode(b);
    let (big5, _, big5_err) = BIG5.decode(b);
    match (gb_err, big5_err) {
        (false, true) => gb.into_owned(),
        (true, false) => big5.into_owned(),
        _ => {
            let common = |s: &str| s.chars().filter(|c| "的一是不了我你在人有他這个这們们愛爱心".contains(*c)).count();
            if common(&big5) > common(&gb) {
                big5.into_owned()
            } else {
                gb.into_owned()
            }
        }
    }
}
