// 系統匣（§4.9）：顯示/隱藏字幕、移動字幕、釘選播放來源、開啟控制面板、開機自動啟動、結束
use serde_json::json;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

static SESSIONS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (aumid, 顯示名稱)

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    TrayIconBuilder::with_id("tray")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("魔唱")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| on_menu(app, e.id.as_ref()))
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                crate::windows_ui::show_panel(tray.app_handle().clone());
            }
        })
        .build(app)?;
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let visible = crate::windows_ui::is_visible(app);
    let editing = crate::windows_ui::is_editing();
    let pinned = crate::settings::get()["pinnedAumid"].as_str().map(String::from);
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);

    let m_panel = MenuItem::with_id(app, "panel", "開啟控制面板", true, None::<&str>)?;
    let m_toggle = MenuItem::with_id(app, "toggle", if visible { "隱藏字幕" } else { "顯示字幕" }, true, None::<&str>)?;
    let m_move = MenuItem::with_id(app, "move", if editing { "移好了，完成" } else { "移動字幕" }, true, None::<&str>)?;
    let m_bottom = MenuItem::with_id(app, "bottom", "字幕放回螢幕下方", true, None::<&str>)?;

    let src = Submenu::with_id(app, "src", "播放來源", true)?;
    src.append(&CheckMenuItem::with_id(app, "src:auto", "自動選擇（YT Music 優先）", true, pinned.is_none(), None::<&str>)?)?;
    let sessions = SESSIONS.lock().unwrap().clone();
    if !sessions.is_empty() {
        src.append(&PredefinedMenuItem::separator(app)?)?;
    }
    for (aumid, label) in &sessions {
        let on = pinned.as_deref() == Some(aumid.as_str());
        src.append(&CheckMenuItem::with_id(app, format!("src:{aumid}"), label, true, on, None::<&str>)?)?;
    }
    if let Some(p) = pinned.as_ref().filter(|p| !sessions.iter().any(|(a, _)| a == *p)) {
        // 釘選的來源目前沒在播放，也列出來讓使用者能取消
        src.append(&CheckMenuItem::with_id(app, format!("src:{p}"), format!("{}（目前沒有播放）", crate::smtc::app_name(p)), true, true, None::<&str>)?)?;
    }

    let m_auto = CheckMenuItem::with_id(app, "autostart", "開機自動啟動", true, autostart, None::<&str>)?;
    let m_quit = MenuItem::with_id(app, "quit", "結束魔唱", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&m_panel, &sep1, &m_toggle, &m_move, &m_bottom, &src, &m_auto, &sep2, &m_quit])
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "panel" => crate::windows_ui::show_panel(app.clone()),
        "toggle" => {
            crate::windows_ui::set_overlay_visible(app.clone(), None);
        }
        "move" => {
            let on = !crate::windows_ui::is_editing();
            crate::windows_ui::set_edit_mode(app.clone(), Some(on));
        }
        "bottom" => crate::windows_ui::overlay_preset(app.clone(), "bottom".into()),
        "autostart" => {
            let al = app.autolaunch();
            let on = al.is_enabled().unwrap_or(false);
            let _ = if on { al.disable() } else { al.enable() };
            refresh(app);
        }
        "src:auto" => {
            crate::settings::set(app, &json!({ "pinnedAumid": null }));
        }
        "quit" => {
            if let Some(ov) = crate::windows_ui::overlay(app) {
                crate::windows_ui::save_geometry(&ov);
            }
            app.exit(0);
        }
        other => {
            if let Some(aumid) = other.strip_prefix("src:") {
                crate::settings::set(app, &json!({ "pinnedAumid": aumid }));
            }
        }
    }
}

/// 狀態改變時重建選單（選單很小，重建比逐項更新簡單）
pub fn refresh(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (app2.tray_by_id("tray"), build_menu(&app2)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

pub fn set_sessions(app: &AppHandle, list: Vec<(String, String)>) {
    *SESSIONS.lock().unwrap() = list;
    refresh(app);
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, on: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if on { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    refresh(&app);
    Ok(al.is_enabled().unwrap_or(false))
}
