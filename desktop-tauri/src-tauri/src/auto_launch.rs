//! Login-item (open at login) control.
//!
//! Mirrors cc-switch's `auto_launch.rs`: one `AutoLaunch` instance built from
//! `current_exe()`, macOS path normalisation, and thin enable/disable/status
//! wrappers that log. The only deliberate differences are the application name
//! and the error type (`String` here, because this crate has no `error.rs`).

use auto_launch::{AutoLaunch, AutoLaunchBuilder};

/// Registered application name. Appears in the Windows startup list and in the
/// macOS login items, so it must be the product name, not the crate name.
pub const APP_NAME: &str = "Agent Memory Backpack";

/// Rewrites `/path/App.app/Contents/MacOS/App` to `/path/App.app`.
///
/// macOS login items are AppleScript-based: handing them the inner executable
/// makes the app start in a terminal context instead of as a bundled app. Only
/// the macOS branch of [`get_auto_launch`] uses the result; the function itself
/// stays platform-independent so its tests run on every host rather than only on
/// a Mac (cc-switch guards the equivalent tests with `cfg(target_os = "macos")`).
///
/// `allow(dead_code)` is for the non-macOS builds, where the only caller is the
/// test module.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn normalize_app_path(path: &str) -> String {
    match path.find(".app/Contents/MacOS/") {
        // `.app` is four bytes; keep the bundle root and drop everything after it.
        Some(position) => path[..position + 4].to_string(),
        None => path.to_string(),
    }
}

fn get_auto_launch() -> Result<AutoLaunch, String> {
    let exe_path =
        std::env::current_exe().map_err(|e| format!("无法获取应用路径: {e}"))?;
    let raw = exe_path.to_string_lossy().to_string();

    // macOS needs the bundle root; Windows (Run key) and Linux (XDG autostart)
    // want the executable path as-is.
    #[cfg(target_os = "macos")]
    let app_path = normalize_app_path(&raw);

    #[cfg(not(target_os = "macos"))]
    let app_path = raw;

    // AutoLaunchBuilder hides the per-platform differences (registry on Windows,
    // AppleScript on macOS, .desktop on Linux).
    AutoLaunchBuilder::new()
        .set_app_name(APP_NAME)
        .set_app_path(&app_path)
        .build()
        .map_err(|e| format!("创建 AutoLaunch 失败: {e}"))
}

/// Enables "start at login". The OS is the source of truth; callers must read
/// the state back with [`is_auto_launch_enabled`] rather than assume success.
pub fn enable_auto_launch() -> Result<(), String> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .enable()
        .map_err(|e| format!("启用开机自启失败: {e}"))?;
    log::info!("已启用开机自启");
    Ok(())
}

/// Disables "start at login".
pub fn disable_auto_launch() -> Result<(), String> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .disable()
        .map_err(|e| format!("禁用开机自启失败: {e}"))?;
    log::info!("已禁用开机自启");
    Ok(())
}

/// Reads the real registration state (Windows Run key / macOS login item /
/// Linux autostart file). Never cached.
pub fn is_auto_launch_enabled() -> Result<bool, String> {
    let auto_launch = get_auto_launch()?;
    auto_launch
        .is_enabled()
        .map_err(|e| format!("检查开机自启状态失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::normalize_app_path;

    #[test]
    fn reduces_bundle_executable_to_bundle_root() {
        assert_eq!(
            normalize_app_path("/Applications/Agent Memory Backpack.app/Contents/MacOS/Agent Memory Backpack"),
            "/Applications/Agent Memory Backpack.app"
        );
    }

    #[test]
    fn keeps_application_path_with_spaces() {
        assert_eq!(
            normalize_app_path("/Users/test/My Apps/App.app/Contents/MacOS/App"),
            "/Users/test/My Apps/App.app"
        );
    }

    #[test]
    fn leaves_paths_outside_a_bundle_alone() {
        for path in [
            "/usr/local/bin/amb-desktop",
            "/Users/dev/project/target/debug/amb-desktop",
            "C:\\Program Files\\Agent Memory Backpack\\amb-desktop.exe",
        ] {
            assert_eq!(normalize_app_path(path), path);
        }
    }

    #[test]
    fn trims_everything_after_the_first_bundle_marker() {
        // Nested markers keep only the outermost bundle, which is the app the
        // login item should launch.
        assert_eq!(
            normalize_app_path("/opt/Outer.app/Contents/MacOS/Inner.app/Contents/MacOS/x"),
            "/opt/Outer.app"
        );
    }
}
