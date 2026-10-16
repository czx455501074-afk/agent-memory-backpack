//! System tray: icon, tooltip, menu, and the implementation of every menu item.
//!
//! Menu semantics follow the Electron shell this desktop target replaces
//! (`console/main.cjs`) and cc-switch's tray: show/hide the window, an
//! auto-launch checkbox that reads the *real* OS registration state, and a real
//! quit.
//!
//! `重启核心` is deliberately absent. The core exposes no restart endpoint
//! (`src/server.ts` has no such route) and no Tauri sidecar is configured, so the
//! item would be a label with nothing behind it. Its slot is taken by
//! `检查核心连接`, which performs an actual authenticated `/v1/stats` request and
//! reports the outcome in the tooltip, the log and an `amb-core-probe` event.
//! TODO: revisit once the core ships a restart route or a sidecar is declared.

use crate::auto_launch;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, MenuBuilder, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

#[cfg(target_os = "windows")]
use tauri::tray::{MouseButton, MouseButtonState};

/// Identity of the tray icon; also how [`update_tooltip`] finds it again.
pub const TRAY_ID: &str = "amb-tray";

/// Window label. Matches `app.windows[0].label` in tauri.conf.json.
pub const MAIN_WINDOW_LABEL: &str = "main";

const MENU_TOGGLE_WINDOW: &str = "toggle-main-window";
const MENU_AUTO_LAUNCH: &str = "toggle-auto-launch";
const MENU_CHECK_CORE: &str = "check-core";
const MENU_QUIT: &str = "quit";

const TRAY_TOOLTIP: &str = "Agent Memory Backpack 知识控制台";

/// Builds the tray icon and its menu. Called once from `setup`.
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // Read the registration state from the OS instead of assuming a default: the
    // checkbox must show reality, and the user may have enabled it in a previous
    // session or through the installer.
    let auto_launch_enabled = auto_launch::is_auto_launch_enabled().unwrap_or_else(|error| {
        log::warn!("无法读取开机自启状态: {error}");
        false
    });

    let toggle_window =
        MenuItem::with_id(app, MENU_TOGGLE_WINDOW, "显示 / 隐藏主窗口", true, None::<&str>)?;
    let check_core =
        MenuItem::with_id(app, MENU_CHECK_CORE, "检查核心连接", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "彻底退出", true, None::<&str>)?;
    let auto_start = CheckMenuItem::with_id(
        app,
        MENU_AUTO_LAUNCH,
        "开机自动启动并隐藏到托盘",
        true,
        auto_launch_enabled,
        None::<&str>,
    )?;

    let menu = MenuBuilder::new(app)
        .item(&toggle_window)
        .item(&auto_start)
        .separator()
        .item(&check_core)
        .separator()
        .item(&quit)
        .build()?;

    // The checkbox handle travels with the event handler so a click can correct
    // the tick from the state the OS reports afterwards, without a lookup that
    // would depend on menu traversal APIs.
    let auto_start_item = auto_start.clone();

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, &event.id.0, &auto_start_item);
        })
        .on_tray_icon_event(|tray, event| handle_tray_event(tray.app_handle(), &event));

    // Windows convention: left click opens the app, right click opens the menu.
    // macOS is used to the opposite and Linux (AppIndicator) only delivers clicks
    // that open the menu, so the menu stays on the left button there. cc-switch
    // makes the same split with `cfg!(not(target_os = "windows"))`.
    #[cfg(target_os = "windows")]
    {
        builder = builder.show_menu_on_left_click(false);
    }
    #[cfg(not(target_os = "windows"))]
    {
        builder = builder.show_menu_on_left_click(true);
    }

    if let Some(icon) = tray_icon(app) {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    log::info!("托盘已创建 (id={TRAY_ID})");
    Ok(())
}

/// Tray artwork. The bundle icon is reused so there is a single source of truth;
/// if it is missing the tray is still created (blank on Windows, generic on
/// macOS) and the problem is logged rather than turning into a startup failure.
fn tray_icon<R: Runtime>(app: &AppHandle<R>) -> Option<Image<'static>> {
    match app.default_window_icon() {
        Some(icon) => Some(icon.clone().to_owned()),
        None => {
            log::warn!("未找到默认图标，托盘将没有图标；请先补齐 src-tauri/icons/");
            None
        }
    }
}

/// Brings the main window to the front. Also the single-instance and Dock-reopen
/// entry point.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            log::info!("已唤出主窗口");
        }
        None => log::warn!("主窗口不存在，无法显示"),
    }
}

/// Hides the main window back into the tray.
pub fn hide_main_window<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => {
            let _ = window.hide();
            log::info!("已隐藏主窗口到托盘");
        }
        None => log::warn!("主窗口不存在，无法隐藏"),
    }
}

/// Hides the window at startup and verifies that it stayed hidden.
///
/// `visible: false` in tauri.conf.json is the mechanism that keeps the window off
/// screen, and it does work: enumerating top-level windows by class on a plain
/// launch shows the `Tauri Window` with `WS_VISIBLE=false`. This call re-asserts
/// the state and, more usefully, records the outcome, so a future regression is
/// visible in the log instead of silently putting a window on the desktop.
///
/// A note for the next reader, because the first diagnosis here was wrong: testing
/// `Process.MainWindowHandle` on a debug build resolves to the
/// `PseudoConsoleWindow` of the console subsystem, not to the Tauri window, and
/// that handle reports itself visible forever. Enumerate windows by class
/// (`Tauri Window`) when checking this, never by `MainWindowHandle`.
pub fn ensure_main_window_hidden<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!("主窗口不存在，无法隐藏");
        return;
    };

    if let Err(error) = window.hide() {
        log::warn!("隐藏主窗口失败: {error}");
        return;
    }

    match window.is_visible() {
        Ok(true) => log::warn!("主窗口仍然可见：托盘不是唯一入口，需进一步排查"),
        Ok(false) => log::info!("主窗口已隐藏，等待托盘唤出"),
        Err(error) => log::warn!("无法确认窗口可见状态: {error}"),
    }
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!("主窗口不存在，无法切换显示状态");
        return;
    };
    match window.is_visible() {
        Ok(true) => hide_main_window(app),
        Ok(false) => show_main_window(app),
        Err(error) => log::warn!("无法读取窗口可见状态: {error}"),
    }
}

fn handle_menu_event<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    auto_start: &CheckMenuItem<R>,
) {
    match id {
        MENU_TOGGLE_WINDOW => toggle_main_window(app),
        MENU_AUTO_LAUNCH => toggle_auto_launch(app, auto_start),
        MENU_CHECK_CORE => probe_core(app.clone()),
        MENU_QUIT => {
            log::info!("退出应用（托盘菜单）");
            app.exit(0);
        }
        other => log::warn!("未知的托盘菜单项: {other}"),
    }
}

/// Left-button click on the icon. Only Windows routes it to the window; on the
/// other platforms the same gesture opens the menu, so there is nothing to do.
fn handle_tray_event<R: Runtime>(app: &AppHandle<R>, event: &TrayIconEvent) {
    #[cfg(target_os = "windows")]
    {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            toggle_main_window(app);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, event);
    }
}

/// Flips the login item. The menu tick is never the source of truth: the current
/// state is read first, the opposite action is applied, and the tick is then set
/// from what the OS reports. That also self-corrects when the registration was
/// changed outside the app (installer, registry editor, System Settings).
fn toggle_auto_launch<R: Runtime>(app: &AppHandle<R>, auto_start: &CheckMenuItem<R>) {
    let current = match auto_launch::is_auto_launch_enabled() {
        Ok(value) => value,
        Err(error) => {
            log::error!("读取开机自启状态失败: {error}");
            sync_auto_launch_tick(app, auto_start);
            return;
        }
    };

    let result = if current {
        auto_launch::disable_auto_launch()
    } else {
        auto_launch::enable_auto_launch()
    };

    if let Err(error) = result {
        log::error!("切换开机自启失败: {error}");
    }

    sync_auto_launch_tick(app, auto_start);
}

/// Re-reads the OS state and moves the tick to match, so a failed enable/disable
/// does not leave the menu claiming something untrue.
fn sync_auto_launch_tick<R: Runtime>(app: &AppHandle<R>, auto_start: &CheckMenuItem<R>) {
    let enabled = auto_launch::is_auto_launch_enabled().unwrap_or_else(|error| {
        log::warn!("无法回读开机自启状态: {error}");
        false
    });

    if let Err(error) = auto_start.set_checked(enabled) {
        log::warn!("更新自启勾选状态失败: {error}");
    }

    log::info!("开机自启状态: {}", if enabled { "已启用" } else { "已禁用" });
    let _ = app.emit("amb-auto-launch-changed", enabled);
}

/// Authenticated connectivity probe against the core. Runs off the UI thread
/// because the tray callback is synchronous.
fn probe_core<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let summary = crate::commands::core_probe_summary().await;
        log::info!("核心连接检查: {summary}");
        update_tooltip(&app, &format!("{TRAY_TOOLTIP}\n{summary}"));
        let _ = app.emit("amb-core-probe", summary);
    });
}

fn update_tooltip<R: Runtime>(app: &AppHandle<R>, text: &str) {
    let id = tauri::tray::TrayIconId::from(TRAY_ID);
    match app.tray_by_id(&id) {
        Some(tray) => {
            if let Err(error) = tray.set_tooltip(Some(text)) {
                log::warn!("更新托盘提示失败: {error}");
            }
        }
        None => log::warn!("未找到托盘图标，无法更新提示"),
    }
}
