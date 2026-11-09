// 字幕視窗（OVL-1~4、14、15）與控制面板視窗
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const OV_W: f64 = 1100.0; // 字幕視窗基準大小（邏輯像素，縮放 100%）
pub const OV_H: f64 = 230.0;
static EDIT_MODE: AtomicBool = AtomicBool::new(false);

pub fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("overlay")
}

pub fn create_overlay(app: &AppHandle) -> tauri::Result<()> {
    let ov = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("魔唱 字幕")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .resizable(true)
        .min_inner_size(440.0, 100.0)
        .inner_size(OV_W, OV_H)
        .visible(false)
        .build()?;
    set_no_activate(&ov);
    set_click_through(&ov, true);
    if !restore_geometry(&ov) {
        place(&ov, "bottom");
    }
    show_no_activate(&ov);
    Ok(())
}

/// 控制面板：關閉時整個 WebView 釋放（NFR：面板關閉要釋放記憶體），要用時再建
pub fn show_panel(app: AppHandle) {
    if let Some(w) = app.get_webview_window("panel") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let r = WebviewWindowBuilder::new(&app, "panel", WebviewUrl::App("panel.html".into()))
        .title("魔唱")
        .inner_size(900.0, 880.0)
        .min_inner_size(640.0, 560.0)
        .build();
    match r {
        Ok(w) => {
            let app2 = app.clone();
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    // 面板關掉時：錄快捷鍵途中關掉也要恢復；字幕不要停在預覽
                    crate::hotkeys::apply(&app2);
                    let _ = app2.emit_to("overlay", "core-cmd", json!({ "type": "preview", "on": false }));
                }
            });
        }
        Err(e) => crate::paths::log(&format!("[panel] 建立失敗：{e}")),
    }
}

/// 從網頁呼叫時一定要用非同步指令建立視窗（同步指令在 Windows 上會卡死）
#[tauri::command]
pub async fn open_panel(app: AppHandle) {
    show_panel(app);
}

// ---------------- 移動字幕 / 顯示隱藏 ----------------

#[tauri::command]
pub fn set_edit_mode(app: AppHandle, on: Option<bool>) -> bool {
    let on = on.unwrap_or(!EDIT_MODE.load(Ordering::SeqCst));
    EDIT_MODE.store(on, Ordering::SeqCst);
    if let Some(ov) = overlay(&app) {
        if on {
            show_no_activate(&ov);
            let _ = app.emit("overlay-visible", true);
        }
        set_click_through(&ov, !on);
        if !on {
            save_geometry(&ov);
        }
    }
    let _ = app.emit("edit-mode", on);
    crate::tray::refresh(&app);
    on
}

#[tauri::command]
pub fn set_overlay_visible(app: AppHandle, visible: Option<bool>) -> bool {
    let Some(ov) = overlay(&app) else { return false };
    let visible = visible.unwrap_or(!ov.is_visible().unwrap_or(true));
    if visible {
        show_no_activate(&ov);
    } else {
        hide(&ov);
    }
    if !visible && EDIT_MODE.load(Ordering::SeqCst) {
        set_edit_mode(app.clone(), Some(false));
    }
    let _ = app.emit("overlay-visible", visible);
    crate::tray::refresh(&app);
    visible
}

pub fn is_visible(app: &AppHandle) -> bool {
    overlay(app).and_then(|o| o.is_visible().ok()).unwrap_or(true)
}

pub fn is_editing() -> bool {
    EDIT_MODE.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn get_ui_state(app: AppHandle) -> Value {
    let scale = overlay(&app)
        .and_then(|o| Some(o.outer_size().ok()?.height as f64 / (OV_H * o.scale_factor().ok()?)))
        .unwrap_or(1.0);
    json!({ "edit": is_editing(), "visible": is_visible(&app), "scale": (scale * 10.0).round() / 10.0 })
}

// ---------------- 擺放位置與大小 ----------------

fn place(ov: &WebviewWindow, where_: &str) {
    let Ok(Some(m)) = ov.current_monitor().or_else(|_| ov.primary_monitor()) else { return };
    let Ok(size) = ov.outer_size() else { return };
    let (mp, ms, sf) = (m.position(), m.size(), m.scale_factor());
    let x = mp.x + (ms.width as i32 - size.width as i32) / 2;
    let margin = (70.0 * sf) as i32;
    let y = match where_ {
        "top" => mp.y + margin,
        "center" => mp.y + (ms.height as i32 - size.height as i32) / 2,
        _ => mp.y + ms.height as i32 - size.height as i32 - margin - (20.0 * sf) as i32,
    };
    let _ = ov.set_position(PhysicalPosition::new(x, y));
}

/// OVL-15：快速放到字幕目前所在螢幕的 上方 / 中間 / 下方
#[tauri::command]
pub fn overlay_preset(app: AppHandle, place_at: String) {
    let Some(ov) = overlay(&app) else { return };
    place(&ov, &place_at);
    show_no_activate(&ov);
    save_geometry(&ov);
}

/// OVL-14：等比例縮放字幕視窗，維持底邊中心不動（字的大小跟著視窗高度）
#[tauri::command]
pub fn overlay_scale(app: AppHandle, scale: f64) {
    let Some(ov) = overlay(&app) else { return };
    let scale = scale.clamp(0.6, 1.6);
    let (Ok(pos), Ok(old), Ok(sf)) = (ov.outer_position(), ov.outer_size(), ov.scale_factor()) else { return };
    let w = (OV_W * scale * sf) as i32;
    let h = (OV_H * scale * sf) as i32;
    let cx = pos.x + old.width as i32 / 2;
    let bottom = pos.y + old.height as i32;
    let _ = ov.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = ov.set_position(PhysicalPosition::new(cx - w / 2, bottom - h));
    save_geometry(&ov);
}

// ---------------- 記住位置（OVL-4：螢幕名稱 + 相對座標 + 邏輯大小）----------------

pub fn save_geometry(w: &WebviewWindow) {
    let (Ok(p), Ok(s), Ok(Some(m))) = (w.outer_position(), w.outer_size(), w.current_monitor()) else { return };
    let (mp, ms, sf) = (m.position(), m.size(), m.scale_factor());
    let v = json!({
        "monitor": m.name().cloned().unwrap_or_default(),
        "rect": [mp.x, mp.y, ms.width, ms.height],
        "rx": ((p.x - mp.x) as f64 / ms.width as f64).clamp(0.0, 0.99),
        "ry": ((p.y - mp.y) as f64 / ms.height as f64).clamp(0.0, 0.99),
        "lw": s.width as f64 / sf,
        "lh": s.height as f64 / sf,
    });
    let _ = std::fs::write(crate::paths::file("overlay.json"), v.to_string());
}

fn restore_geometry(w: &WebviewWindow) -> bool {
    let Some(v) = std::fs::read_to_string(crate::paths::file("overlay.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    else {
        return false;
    };
    let name = v["monitor"].as_str().unwrap_or("");
    // 找不到原來的螢幕（拔掉外接螢幕、換電腦）→ 回到主螢幕下方預設位置
    // 螢幕編號（\\.\DISPLAYn）可能在接上底座後重排，所以名稱和位置大小要一起對
    let rect: Vec<i64> = v["rect"].as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default();
    let same_rect = |m: &tauri::Monitor| {
        let (p, s) = (m.position(), m.size());
        rect == [p.x as i64, p.y as i64, s.width as i64, s.height as i64]
    };
    let mons = w.available_monitors().unwrap_or_default();
    let Some(m) = mons
        .iter()
        .find(|m| m.name().map(|n| n == name).unwrap_or(false) && (rect.is_empty() || same_rect(m)))
        .or_else(|| mons.iter().find(|m| same_rect(m)))
        .cloned()
    else {
        return false;
    };
    let (rx, ry) = (v["rx"].as_f64().unwrap_or(-1.0), v["ry"].as_f64().unwrap_or(-1.0));
    let (lw, lh) = (v["lw"].as_f64().unwrap_or(0.0), v["lh"].as_f64().unwrap_or(0.0));
    if !(0.0..1.0).contains(&rx) || !(0.0..1.0).contains(&ry) || lw < 200.0 || lh < 60.0 {
        return false;
    }
    let (mp, ms, sf) = (m.position(), m.size(), m.scale_factor());
    let pos = PhysicalPosition::new(mp.x + (rx * ms.width as f64) as i32, mp.y + (ry * ms.height as f64) as i32);
    // 先移到目標螢幕（可能觸發 DPI 變更），再依那個螢幕的縮放設定大小
    let _ = w.set_position(pos);
    let _ = w.set_size(PhysicalSize::new((lw * sf) as u32, (lh * sf) as u32));
    let _ = w.set_position(pos);
    true
}

// 字幕視窗的顯示、隱藏、點穿一律直接用 Win32，不要呼叫 Tauri 的 show / hide / set_ignore_cursor_events：
// tao 自己記一份「是否顯示」，我們用 ShowWindow 顯示它不知道；之後只要 tao 改任何視窗旗標，
// 就會依它記的狀態把視窗藏起來，並整個重寫 GWL_EXSTYLE（洗掉 WS_EX_NOACTIVATE / WS_EX_TOOLWINDOW）。
// v0.4.1 以前「移動字幕」一切換點穿字幕就消失，就是這個原因。

fn hide(w: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    if let Ok(h) = w.hwnd() {
        unsafe {
            let _ = ShowWindow(HWND(h.0 as _), SW_HIDE);
        }
    }
}

/// 點穿：和 tao 的 set_ignore_cursor_events 一樣切換 WS_EX_TRANSPARENT | WS_EX_LAYERED，但保留其他樣式
fn set_click_through(w: &WebviewWindow, on: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, WS_EX_LAYERED, WS_EX_TRANSPARENT,
    };
    let Ok(h) = w.hwnd() else { return };
    let bits = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
    unsafe {
        let hwnd = HWND(h.0 as _);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, if on { ex | bits } else { ex & !bits });
        let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE);
    }
}

/// 顯示字幕視窗但不啟用它（SW_SHOWNOACTIVATE），避免按快捷鍵顯示字幕時搶走 VS Code 的焦點
fn show_no_activate(w: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    match w.hwnd() {
        Ok(h) => unsafe {
            let _ = ShowWindow(HWND(h.0 as _), SW_SHOWNOACTIVATE);
        },
        Err(_) => {
            let _ = w.show();
        }
    }
}

/// OVL-1：字幕視窗永遠不會被啟用（不搶焦點），並從 Alt+Tab 隱藏
fn set_no_activate(w: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
    if let Ok(h) = w.hwnd() {
        unsafe {
            let hwnd = HWND(h.0 as _);
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
        }
    }
}
