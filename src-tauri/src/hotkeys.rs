// 全域快捷鍵（§4.9）。設定裡的字串（例如 "Ctrl+Alt+]"）→ 註冊；註冊失敗記下來給面板標紅，不中斷啟動
use serde::Serialize;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Serialize, Clone)]
pub struct Status {
    action: String,
    accel: String,
    ok: bool,
    error: Option<String>,
}

static ACTIONS: Mutex<Option<HashMap<u32, String>>> = Mutex::new(None);
static STATUS: Mutex<Vec<Status>> = Mutex::new(Vec::new());

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, sc, ev| {
            if ev.state() != ShortcutState::Pressed {
                return;
            }
            let action = ACTIONS.lock().unwrap().as_ref().and_then(|m| m.get(&sc.id()).cloned());
            if let Some(a) = action {
                run(app, &a);
            }
        })
        .build()
}

fn run(app: &AppHandle, action: &str) {
    match action {
        "toggle" => {
            crate::windows_ui::set_overlay_visible(app.clone(), None);
        }
        "edit" => {
            crate::windows_ui::set_edit_mode(app.clone(), None);
        }
        // 偏移、重新搜尋由字幕視窗裡的核心處理
        other => {
            let _ = app.emit_to("overlay", "hotkey", other);
        }
    }
}

pub fn apply(app: &AppHandle) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = HashMap::new();
    let mut status = Vec::new();
    let keys = crate::settings::get()["hotkeys"].clone();
    if let Some(obj) = keys.as_object() {
        for (action, accel) in obj {
            let accel = accel.as_str().unwrap_or("").trim().to_string();
            if accel.is_empty() {
                status.push(Status { action: action.clone(), accel, ok: true, error: None });
                continue;
            }
            let r = Shortcut::from_str(&accel).map_err(|e| ("看不懂這個按鍵".to_string(), e.to_string())).and_then(|sc| {
                gs.register(sc).map_err(|e| ("已經被其他程式佔用".to_string(), e.to_string()))?;
                Ok(sc)
            });
            match r {
                Ok(sc) => {
                    map.insert(sc.id(), action.clone());
                    status.push(Status { action: action.clone(), accel, ok: true, error: None });
                }
                Err((msg, detail)) => {
                    crate::paths::log(&format!("[hotkey] {action} = {accel} 註冊失敗：{detail}"));
                    status.push(Status { action: action.clone(), accel, ok: false, error: Some(msg) });
                }
            }
        }
    }
    *ACTIONS.lock().unwrap() = Some(map);
    *STATUS.lock().unwrap() = status.clone();
    let _ = app.emit("hotkeys-status", status);
}

#[tauri::command]
pub fn hotkeys_status() -> Vec<Status> {
    STATUS.lock().unwrap().clone()
}

/// 面板錄製新快捷鍵時，先暫停全部快捷鍵，避免按下去就觸發
#[tauri::command]
pub fn hotkeys_suspend(app: AppHandle, suspend: bool) {
    if suspend {
        let _ = app.global_shortcut().unregister_all();
    } else {
        apply(&app);
    }
}
