// SMTC 偵測（SRC-A1~A6）：每 250 ms 讀所有 Session；有變化才 emit 'smtc'，另外每 2 秒送一次心跳。
// 換歌時讀封面，emit 'smtc-thumb'。選哪個 Session、時間外插都在前端（web/sources/smtc.ts）。
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub aumid: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub status: &'static str,
    pub position_ms: i64,
    pub end_ms: i64,
    pub last_updated_unix_ms: i64,
    pub rate: f64,
    pub is_current: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Thumb {
    aumid: String,
    title: String,
    artist: String,
    data_url: Option<String>,
}

const FILETIME_UNIX_DIFF: i64 = 116_444_736_000_000_000; // 1601→1970，單位 100ns

/// 本程式自己的 WebView2 也會出現在 SMTC（M0 F5），一律排除
fn is_self(aumid: &str) -> bool {
    let a = aumid.to_ascii_lowercase();
    a.contains("msedgewebview2") || a.contains("magising") || a.contains("johnnykaraoke") || a.contains("johnny.karaoke")
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED);
        }
        let mgr = loop {
            match Manager::RequestAsync().and_then(|op| op.get()) {
                Ok(m) => break m,
                Err(e) => {
                    crate::paths::log(&format!("[smtc] 初始化失敗：{e}，5 秒後重試"));
                    std::thread::sleep(Duration::from_secs(5));
                }
            }
        };
        crate::paths::log("[smtc] ready");
        let mut last: Vec<SessionInfo> = Vec::new();
        let mut last_emit = Instant::now() - Duration::from_secs(10);
        let mut songs: HashMap<String, (String, String, Option<Instant>)> = HashMap::new(); // aumid → (歌名, 歌手, 待補讀封面的時間)
        let mut tray_ids: Vec<(String, String)> = Vec::new();
        let mut last_err = Instant::now() - Duration::from_secs(120);
        loop {
            match read_all(&mgr) {
                Ok((list, raw)) => {
                    if list != last || last_emit.elapsed() >= Duration::from_secs(2) {
                        let _ = app.emit("smtc", &list);
                        last_emit = Instant::now();
                    }
                    for (s, sess) in list.iter().zip(raw.iter()) {
                        let prev = songs.get(&s.aumid).cloned();
                        let changed = prev.as_ref().map(|(t, a, _)| t != &s.title || a != &s.artist).unwrap_or(true);
                        if changed && !s.title.is_empty() {
                            // 換歌時讀一次封面，1.5 秒後再讀一次（Chrome 常晚一點才換封面）
                            songs.insert(s.aumid.clone(), (s.title.clone(), s.artist.clone(), Some(Instant::now())));
                            emit_thumb(&app, s, sess);
                        } else if let Some((_, _, Some(at))) = prev {
                            if at.elapsed() >= Duration::from_millis(1500) {
                                songs.insert(s.aumid.clone(), (s.title.clone(), s.artist.clone(), None));
                                emit_thumb(&app, s, sess);
                            }
                        }
                    }
                    let ids: Vec<(String, String)> = list.iter().map(|s| (s.aumid.clone(), label(s))).collect();
                    if ids != tray_ids {
                        crate::tray::set_sessions(&app, ids.clone());
                        tray_ids = ids;
                    }
                    last = list;
                }
                Err(e) => {
                    // 限流：最多每分鐘記一次
                    if last_err.elapsed() >= Duration::from_secs(60) {
                        crate::paths::log(&format!("[smtc] 讀取失敗：{e}"));
                        last_err = Instant::now();
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

/// 認得的播放器（由上往下第一個符合的為準）；和 web/sources/smtc.ts 的 APPS 保持一致
const APPS: &[(&[&str], &str)] = &[
    (&["_crx_cinhimbnkk"], "YT Music"),
    (&["spotify"], "Spotify"),
    (&["applemusic", "itunes"], "Apple Music"),
    (&["amazonmusic", "amazon music"], "Amazon Music"),
    (&["kkbox"], "KKBOX"),
    (&["tidal"], "TIDAL"),
    (&["deezer"], "Deezer"),
    (&["zunemusic"], "媒體播放器"),
    (&["foobar2000"], "foobar2000"),
    (&["musicbee"], "MusicBee"),
    (&["aimp"], "AIMP"),
    (&["cloudmusic"], "網易雲音樂"),
    (&["qqmusic"], "QQ 音樂"),
    (&["kugou"], "酷狗音樂"),
    (&["_crx_"], "網頁 App"),
    (&["chrome"], "Chrome"),
    (&["msedge"], "Edge"),
    (&["firefox", "308046b0af4a39cb"], "Firefox"),
    (&["opera"], "Opera"),
    (&["brave"], "Brave"),
    (&["vivaldi"], "Vivaldi"),
];

pub fn app_name(aumid: &str) -> String {
    let a = aumid.to_ascii_lowercase();
    match APPS.iter().find(|(keys, _)| keys.iter().any(|k| a.contains(k))) {
        Some((_, name)) => (*name).into(),
        None => aumid.trim_end_matches(".exe").rsplit(['\\', '!']).next().unwrap_or(aumid).to_string(),
    }
}

fn emit_thumb(app: &AppHandle, s: &SessionInfo, sess: &Session) {
    let data_url = read_thumb(sess);
    let _ = app.emit("smtc-thumb", Thumb { aumid: s.aumid.clone(), title: s.title.clone(), artist: s.artist.clone(), data_url });
}

fn label(s: &SessionInfo) -> String {
    let song: String = s.title.chars().take(24).collect();
    if song.is_empty() {
        app_name(&s.aumid)
    } else {
        format!("{} — {}", app_name(&s.aumid), song)
    }
}

fn read_one(s: &Session, current: Option<&str>) -> windows::core::Result<SessionInfo> {
    let aumid = s.SourceAppUserModelId()?.to_string();
    if is_self(&aumid) {
        return Err(windows::core::Error::empty());
    }
    let props = s.TryGetMediaPropertiesAsync()?.get()?;
    let tl = s.GetTimelineProperties()?;
    let info = s.GetPlaybackInfo()?;
    let st = info.PlaybackStatus()?;
    let status = if st == Status::Playing {
        "playing"
    } else if st == Status::Paused {
        "paused"
    } else if st == Status::Stopped || st == Status::Closed {
        "stopped"
    } else {
        "other"
    };
    let rate = info.PlaybackRate().and_then(|r| r.Value()).unwrap_or(1.0);
    Ok(SessionInfo {
        is_current: current == Some(aumid.as_str()),
        aumid,
        title: props.Title()?.to_string(),
        artist: props.Artist()?.to_string(),
        album: props.AlbumTitle()?.to_string(),
        status,
        position_ms: tl.Position()?.Duration / 10_000,
        end_ms: (tl.EndTime()?.Duration - tl.StartTime()?.Duration) / 10_000,
        last_updated_unix_ms: (tl.LastUpdatedTime()?.UniversalTime - FILETIME_UNIX_DIFF) / 10_000,
        rate: if rate > 0.0 { rate } else { 1.0 },
    })
}

fn read_all(mgr: &Manager) -> windows::core::Result<(Vec<SessionInfo>, Vec<Session>)> {
    let current = mgr.GetCurrentSession().ok().and_then(|s| s.SourceAppUserModelId().ok()).map(|h| h.to_string());
    let mut out = Vec::new();
    let mut raw = Vec::new();
    for s in mgr.GetSessions()? {
        // 某個 App 的資料讀不到時只略過它，不要讓其他 Session（例如 YT Music）一起消失
        if let Ok(info) = read_one(&s, current.as_deref()) {
            out.push(info);
            raw.push(s);
        }
    }
    Ok((out, raw))
}

/// 封面圖轉成 data URL（最多 2 MB）；讀不到回傳 None
fn read_thumb(s: &Session) -> Option<String> {
    let props = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > 2_000_000 {
        return None;
    }
    let ct = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let mime = if ct.starts_with("image/") { ct } else { "image/png".into() };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}
