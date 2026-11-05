// 歌詞網路查詢。由 Rust 代查：可以帶 User-Agent、不受 CORS 限制、統一逾時（LYR-6：單一來源 4 秒）
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(4);
const UA_LRCLIB: &str = concat!("MagiSing/", env!("CARGO_PKG_VERSION"), " (https://johnnyx9487.bdcweb.org/)");
// 網易雲會擋非瀏覽器的 User-Agent，所以這裡用瀏覽器字串
const UA_BROWSER: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(TIMEOUT).build()
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------------- LRCLIB ----------------

fn lrclib(path_and_query: &str) -> Result<Value, String> {
    match agent().get(&format!("https://lrclib.net/api/{path_and_query}")).set("User-Agent", UA_LRCLIB).call() {
        Ok(r) => r.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(404, _)) => Ok(Value::Null),
        Err(e) => Err(format!("LRCLIB：{e}")),
    }
}

/// 精確查詢；查不到回傳 null
#[tauri::command]
pub async fn lrclib_get(track: String, artist: String, album: Option<String>, duration_s: Option<u32>) -> Result<Value, String> {
    blocking(move || {
        let mut q = format!("get?track_name={}&artist_name={}", enc(&track), enc(&artist));
        if let Some(a) = album.filter(|a| !a.is_empty()) {
            q += &format!("&album_name={}", enc(&a));
        }
        if let Some(d) = duration_s.filter(|d| *d > 0) {
            q += &format!("&duration={d}");
        }
        lrclib(&q)
    })
    .await
}

/// 關鍵字搜尋；回傳陣列
#[tauri::command]
pub async fn lrclib_search(q: String) -> Result<Value, String> {
    blocking(move || Ok(lrclib(&format!("search?q={}", enc(&q)))?.as_array().cloned().map(Value::Array).unwrap_or(json!([])))).await
}

// ---------------- 網易雲（非官方端點，LYR-9 限流對策）----------------

const CANCELLED: &str = "已換歌，取消";
const GAP: Duration = Duration::from_millis(1500);
const COOLDOWN: Duration = Duration::from_secs(30 * 60);
static LAST: Mutex<Option<Instant>> = Mutex::new(None);
static BANNED: Mutex<Option<HashMap<&'static str, Instant>>> = Mutex::new(None);
/// 前端換歌時遞增；排隊中、屬於舊世代的網易雲請求直接放棄，不佔用 1.5 秒間隔
static LATEST_GEN: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn net_set_gen(gen: u64) {
    LATEST_GEN.fetch_max(gen, Ordering::SeqCst);
}

fn stale(gen: Option<u64>) -> bool {
    gen.map(|g| g < LATEST_GEN.load(Ordering::SeqCst)).unwrap_or(false)
}

fn banned(endpoint: &'static str) -> bool {
    BANNED.lock().unwrap().as_ref().and_then(|m| m.get(endpoint)).map(|t| t.elapsed() < COOLDOWN).unwrap_or(false)
}

fn netease(endpoint: &'static str, url: &str, gen: Option<u64>) -> Result<Value, String> {
    if stale(gen) {
        return Err(CANCELLED.into());
    }
    if banned(endpoint) {
        return Err(format!("網易雲 {endpoint} 冷卻中（被限流）"));
    }
    // 節流：同網域請求間隔 ≥ 1.5 秒。拿著鎖等待，讓所有請求排隊
    let mut last = LAST.lock().unwrap();
    if stale(gen) {
        return Err(CANCELLED.into());
    }
    if let Some(t) = *last {
        if t.elapsed() < GAP {
            std::thread::sleep(GAP - t.elapsed());
        }
    }
    let res = agent().get(url).set("User-Agent", UA_BROWSER).set("Referer", "https://music.163.com/").call();
    *last = Some(Instant::now());
    drop(last);
    let v: Value = match res {
        Ok(r) => r.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(405, _)) => json!({ "code": 405 }),
        Err(e) => return Err(format!("網易雲：{e}")),
    };
    if v["code"].as_i64() == Some(405) {
        BANNED.lock().unwrap().get_or_insert_with(HashMap::new).insert(endpoint, Instant::now());
        crate::paths::log(&format!("[netease] {endpoint} 被限流（405），冷卻 30 分鐘"));
        return Err("網易雲限流（405）".into());
    }
    Ok(v)
}

fn names(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str().map(String::from)).collect()).unwrap_or_default()
}

fn map_songs(v: &Value, artists_key: &str, dur_key: &str, album: impl Fn(&Value) -> Value) -> Vec<Value> {
    v["result"]["songs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| json!({ "id": s["id"], "name": s["name"], "artists": names(&s[artists_key]), "durationMs": s[dur_key], "album": album(s) }))
                .collect()
        })
        .unwrap_or_default()
}

/// 搜尋歌曲：cloudsearch/pc 為主，失敗或被限流時改用 search/get/web
/// 回傳 [{ id, name, artists, durationMs, album }]
#[tauri::command]
pub async fn netease_search(keywords: String, gen: Option<u64>) -> Result<Value, String> {
    blocking(move || {
        let k = enc(&keywords);
        let songs = match netease("cloudsearch", &format!("https://music.163.com/api/cloudsearch/pc?s={k}&type=1&limit=10"), gen) {
            Ok(v) if v["code"].as_i64() == Some(200) => map_songs(&v, "ar", "dt", |s| s["al"]["name"].clone()),
            Err(e) if e == CANCELLED => return Err(e),
            other => {
                crate::paths::log(&format!("[netease] cloudsearch 失敗（{:?}），改用備援", other.err()));
                let v = netease("search-web", &format!("https://music.163.com/api/search/get/web?s={k}&type=1&limit=10"), gen)?;
                map_songs(&v, "artists", "duration", |s| s["album"]["name"].clone())
            }
        };
        Ok(Value::Array(songs))
    })
    .await
}

/// 取歌詞：{ lrc, yrc（逐字）, tlyric（翻譯）, romalrc（羅馬拼音）}
#[tauri::command]
pub async fn netease_lyric(id: u64, gen: Option<u64>) -> Result<Value, String> {
    blocking(move || {
        let v = netease(
            "lyric",
            &format!("https://music.163.com/api/song/lyric/v1?id={id}&cp=false&tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0"),
            gen,
        )?;
        Ok(json!({
            "lrc": v["lrc"]["lyric"].as_str().unwrap_or(""),
            "yrc": v["yrc"]["lyric"].as_str().unwrap_or(""),
            "tlyric": v["tlyric"]["lyric"].as_str().unwrap_or(""),
            "romalrc": v["romalrc"]["lyric"].as_str().unwrap_or(""),
        }))
    })
    .await
}

// ---------------- 酷狗（日文歌多、KRC 逐字，還附中文翻譯與羅馬拼音）----------------

fn kugou(url: &str) -> Result<Value, String> {
    agent().get(url).set("User-Agent", UA_BROWSER).call().map_err(|e| format!("酷狗：{e}"))?.into_json().map_err(|e| format!("酷狗：{e}"))
}

/// 用「歌手 - 歌名」+ 時長直接搜歌詞。這個端點很依賴時長（沒給時長常常查不到），
/// 所以不知道時長時先用歌曲搜尋拿第一筆的 hash 與時長再查。
/// 回傳 [{ id, accesskey, singer, song, durationMs }]
#[tauri::command]
pub async fn kugou_search(keyword: String, duration_ms: Option<u64>) -> Result<Value, String> {
    blocking(move || {
        let mut d = duration_ms.unwrap_or(0);
        let mut hash = String::new();
        if d == 0 {
            // 這個歌曲搜尋端點只有 http
            let url = format!("http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={}&page=1&pagesize=1", enc(&keyword.replace(" - ", " ")));
            if let Ok(s) = kugou(&url) {
                if let Some(x) = s["data"]["info"].as_array().and_then(|a| a.first()) {
                    d = x["duration"].as_u64().unwrap_or(0) * 1000;
                    hash = x["hash"].as_str().unwrap_or("").to_string();
                }
            }
        }
        let v = kugou(&format!(
            "https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword={}&duration={d}&hash={}",
            enc(&keyword),
            enc(&hash)
        ))?;
        let list = v["candidates"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| json!({ "id": c["id"], "accesskey": c["accesskey"], "singer": c["singer"], "song": c["song"], "durationMs": c["duration"] }))
                    .collect()
            })
            .unwrap_or_default();
        Ok(Value::Array(list))
    })
    .await
}

/// KRC 檔：base64 → 去掉開頭 "krc1" → 固定金鑰 XOR → zlib 解壓
fn decode_krc(b64: &str) -> Result<String, String> {
    use base64::Engine;
    use std::io::Read;
    const KEY: [u8; 16] = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
    let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| format!("酷狗歌詞格式錯誤：{e}"))?;
    if raw.len() <= 4 {
        return Err("酷狗歌詞是空的".into());
    }
    let xored: Vec<u8> = raw[4..].iter().enumerate().map(|(i, b)| b ^ KEY[i % KEY.len()]).collect();
    let mut out = String::new();
    flate2::read::ZlibDecoder::new(&xored[..]).read_to_string(&mut out).map_err(|e| format!("酷狗歌詞解壓失敗：{e}"))?;
    Ok(out.trim_start_matches('\u{feff}').to_string())
}

/// 取 KRC 歌詞（已解碼的文字）
#[tauri::command]
pub async fn kugou_lyric(id: String, accesskey: String) -> Result<String, String> {
    blocking(move || {
        let v = kugou(&format!(
            "https://lyrics.kugou.com/download?ver=1&client=pc&id={}&accesskey={}&fmt=krc&charset=utf8",
            enc(&id),
            enc(&accesskey)
        ))?;
        let content = v["content"].as_str().unwrap_or("");
        if content.is_empty() {
            return Err("酷狗沒有這首的歌詞內容".into());
        }
        decode_krc(content)
    })
    .await
}
