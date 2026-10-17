//! Tauri runtime assembly: plugins, tray, window semantics, commands.
//!
//! Shaped after cc-switch's `src-tauri/src/lib.rs`: single-instance registered
//! first, then log/store/window-state, the tray built in `setup`, close-to-tray
//! in `on_window_event`, and the macOS Dock-reopen handled in the run callback.
//!
//! Window policy differs from cc-switch on purpose: cc-switch shows the window on
//! a normal launch, while this target keeps `visible: false` in tauri.conf.json
//! and is driven from the tray, which is what was asked for here. The override
//! for development is the `--show` argument.

mod auto_launch;
mod commands;
mod core_client;
mod tray;

use tauri::WindowEvent;
// macOS-only variant; importing it unconditionally fails to compile elsewhere.
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri_plugin_window_state::StateFlags;

/// POSITION|SIZE|MAXIMIZED, the same set cc-switch persists.
///
/// `VISIBLE` is deliberately excluded: the window starts hidden and the tray owns
/// visibility, so restoring "visible" would make the next launch flash a window
/// the tray immediately has to take back.
fn window_state_flags() -> StateFlags {
    StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED
}

/// Startup visibility. The window is declared hidden in tauri.conf.json, so the
/// tray is the normal entry point; `--show` exists for development and for a user
/// who wants the window on launch.
fn should_show_on_launch() -> bool {
    std::env::args().any(|arg| arg == "--show")
}

pub fn run() {
    let builder = tauri::Builder::default();

    // single-instance must be the first plugin registered: it has to observe a
    // second launch before the other plugins initialise.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // A second launch must surface the running instance instead of starting
        // a second tray icon and a second window.
        log::info!("检测到重复启动，唤出已有窗口");
        tray::show_main_window(app);
    }));

    let builder = builder
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            // Lane 1: read-only views over the core.
            commands::view,
            commands::doctor,
            commands::target,
            commands::console_url,
            commands::backup_export,
            commands::backup_inspect,
            commands::backup_import,
            commands::reveal_export,
            // Lane 2: knowledge management.
            commands::approve_proposal,
            commands::reject_proposal,
            commands::archive_proposal,
            commands::write_knowledge,
            commands::delete_knowledge,
            commands::supersede_knowledge,
            commands::approve_workflow_draft,
            commands::retry_maintenance,
            // Lane 3: shell state (tray, login item, window).
            commands::auto_launch_status,
            commands::set_auto_launch,
            commands::core_overview,
            commands::window_action,
        ])
        .setup(|app| {
            tray::create_tray(app.handle())?;
            if should_show_on_launch() {
                tray::show_main_window(app.handle());
            } else {
                // `visible: false` is what keeps the window off screen; this call
                // re-asserts it and logs whether it held, so a regression shows up
                // in the log instead of silently putting a window on the desktop.
                tray::ensure_main_window_hidden(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing hides to the tray. Only the tray's 退出 (app.exit) ends
                // the process, so a stray close cannot kill the background shell.
                api.prevent_close();
                let _ = window.hide();
                log::info!("关闭请求已拦截，窗口隐藏到托盘 (label={})", window.label());
            }
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS only: clicking the Dock icon while the app runs activates it
            // again, and the window has to come back for that to mean anything.
            //
            // `RunEvent::Reopen` is itself macOS-only in tauri, so this arm must
            // stay behind a cfg: on Windows the enum has no such variant. The
            // compiler found that; it was not assumed.
            #[cfg(target_os = "macos")]
            {
                if let RunEvent::Reopen { .. } = event {
                    log::info!("收到 Reopen 事件（Dock 图标），显示主窗口");
                    tray::show_main_window(app_handle);
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app_handle, event);
            }
        });
}
