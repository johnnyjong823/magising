// 魔唱：Rust 只負責作業系統整合（SMTC、視窗旗標、快捷鍵、系統匣、SQLite、網路代查），其餘邏輯在 web/
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod files;
mod hotkeys;
mod net;
mod paths;
mod settings;
mod smtc;
mod tray;
mod windows_ui;

fn main() {
    paths::init_log();
    paths::log(concat!("啟動 v", env!("CARGO_PKG_VERSION")));
    let minimized = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        // 再開一次程式 → 叫出原本那個的控制面板
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| windows_ui::show_panel(app.clone())))
        .plugin(hotkeys::plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .invoke_handler(tauri::generate_handler![
            windows_ui::set_edit_mode,
            windows_ui::set_overlay_visible,
            windows_ui::get_ui_state,
            windows_ui::overlay_preset,
            windows_ui::overlay_scale,
            windows_ui::open_panel,
            settings::settings_get,
            settings::settings_set,
            settings::settings_defaults,
            hotkeys::hotkeys_status,
            hotkeys::hotkeys_suspend,
            tray::autostart_get,
            tray::autostart_set,
            db::db_lyrics_get,
            db::db_lyrics_put,
            db::db_lyrics_delete,
            db::db_pref_get,
            db::db_pref_set,
            net::lrclib_get,
            net::lrclib_search,
            net::netease_search,
            net::netease_lyric,
            net::kugou_search,
            net::kugou_lyric,
            net::net_set_gen,
            files::lrc_list,
            files::lrc_read,
            paths::log_line,
            paths::open_data_dir,
            paths::data_dir_path,
            paths::open_link,
            paths::links_enabled,
            paths::open_doc,
        ])
        .setup(move |app| {
            let h = app.handle();
            windows_ui::create_overlay(h)?;
            tray::create(h)?;
            hotkeys::apply(h);
            smtc::spawn(h.clone());
            if !minimized {
                windows_ui::show_panel(h.clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, e| {
            // 控制面板關掉時不要結束程式（字幕視窗還在），只有系統匣「結束」才會 exit
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = e {
                api.prevent_exit();
            }
        });
}
