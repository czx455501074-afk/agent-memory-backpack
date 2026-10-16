// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux/WebKitGTK: values taken verbatim from cc-switch's main.rs. Both are
    // workarounds for WebKit rendering bugs (tauri-apps/tauri#9394) rather than
    // application logic, so they are set here and never overridden if a user has
    // already exported their own value.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    // Everything else lives in the library target so the assembly in lib.rs can
    // be unit-tested and read like cc-switch's `cc_switch_lib::run()`.
    amb_desktop_lib::run();
}
