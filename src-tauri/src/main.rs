// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell.
//!
//! Owns the window and the sidecar process, and nothing else — no ML, no
//! database work. `backend.rs` boots the sidecar on a worker thread (building
//! its Python environment first on a packaged first run), the frontend polls
//! `backend_status` until it is ready, and the child is killed when the app
//! goes away. See `sidecar.rs` for why "when the app goes away" needs three
//! separate hooks.
//!
//! If the sidecar cannot start, the window still opens and says why, with a
//! retry — the fixture library is for the browser dev server only.

mod backend;
mod runtime;
mod sidecar;

use tauri::{Manager, RunEvent, WindowEvent};

use backend::Backend;

fn main(){
    sidecar::install_panic_hook();
    // Wayland names a window by its app id, which GTK takes from the program
    // name, and the shell finds the icon through the .desktop file of that
    // name. The binary is `picsearch` and the file is `PicSearch.desktop`, so
    // Alt+Tab showed the generic Wayland icon. Before GTK starts, or it is too late.
    #[cfg(target_os = "linux")]
    glib::set_prgname(Some("PicSearch"));

    let app = tauri::Builder::default()
        // First, as its docs require: a second launch must exit before `setup`
        // starts a second sidecar (or a second `uv sync` on the same venv).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main"){
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // Hands the OS a file drag that the frontend starts when the pointer
        // leaves the window. Inside the window the drop targets are ours.
        .plugin(tauri_plugin_drag::init())
        .manage(Backend::new())
        .setup(|app| {
            app.state::<Backend>().boot(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend::backend_status,
            backend::backend_retry,
            backend::backend_reset,
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed){
                window.state::<Backend>().shutdown();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the tauri application");

    app.run(|handle, event| {
        // Belt and braces: Destroyed already fired for a normal close, but a
        // programmatic exit or a closed last window may not route through it.
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested{ .. }){
            handle.state::<Backend>().shutdown();
        }
    });
}
