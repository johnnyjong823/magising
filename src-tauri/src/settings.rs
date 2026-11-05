// 設定存在 data\settings.json；預設值只定義在這裡，前端讀 settings_get 拿到合併後的完整設定
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static SETTINGS: Mutex<Option<Value>> = Mutex::new(None);

pub fn defaults() -> Value {
    json!({
        "globalOffsetMs": 0,
        "s2t": true,
        "showTranslation": false,
        "showRomaji": false,
        "providers": { "netease": true, "kugou": true, "lrclib": true },
        "lrcDir": "",
        "pinnedAumid": null,
        "style": {
            "font": "pixel",
            "lines": 2,
            "unsung": "#ffffff",
            "sungFrom": "#62d0ff",
            "sungTo": "#b98cff",
            "outline": true,
            "outlineColor": "#0d2747",
            "shadow": true,
            "opacity": 1.0
        },
        "hotkeys": {
            "toggle": "Ctrl+Alt+L",
            "edit": "Ctrl+Alt+E",
            "earlier": "Ctrl+Alt+]",
            "later": "Ctrl+Alt+[",
            "earlierFine": "Ctrl+Alt+Shift+]",
            "laterFine": "Ctrl+Alt+Shift+[",
            "resetOffset": "Ctrl+Alt+0",
            "research": "Ctrl+Alt+R"
        }
    })
}

/// 物件逐層合併；其他型別（含陣列、null）直接覆蓋
pub fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(b), Value::Object(p)) => {
            for (k, v) in p {
                match b.get_mut(k) {
                    Some(slot) if slot.is_object() && v.is_object() => merge(slot, v),
                    _ => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (b, p) => *b = p.clone(),
    }
}

fn load() -> Value {
    let mut v = defaults();
    if let Some(stored) = std::fs::read_to_string(crate::paths::file("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    {
        merge(&mut v, &stored);
    }
    v
}

pub fn get() -> Value {
    SETTINGS.lock().unwrap().get_or_insert_with(load).clone()
}

pub fn set(app: &AppHandle, patch: &Value) -> Value {
    let merged = {
        let mut g = SETTINGS.lock().unwrap();
        let cur = g.get_or_insert_with(load);
        merge(cur, patch);
        cur.clone()
    };
    let tmp = crate::paths::file("settings.json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(&merged).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, crate::paths::file("settings.json"));
    }
    if patch.get("hotkeys").is_some() {
        crate::hotkeys::apply(app);
    }
    if patch.get("pinnedAumid").is_some() {
        crate::tray::refresh(app);
    }
    let _ = app.emit("settings", &merged);
    merged
}

#[tauri::command]
pub fn settings_get() -> Value {
    get()
}

#[tauri::command]
pub fn settings_set(app: AppHandle, patch: Value) -> Value {
    set(&app, &patch)
}

#[tauri::command]
pub fn settings_defaults() -> Value {
    defaults()
}
