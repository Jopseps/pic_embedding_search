// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell.
//!
//! Owns the window and the sidecar process, and nothing else — no ML, no
//! database work. It spawns `uv run python -m picsearch.server`, reads the
//! single `{"port": …, "token": …}` line from its stdout, hands that to the
//! frontend through the `sidecar_handshake` command, and kills the child when
//! the app goes away. See `sidecar.rs` for why "when the app goes away" needs
//! three separate hooks.
//!
//! If the sidecar cannot start, the window still opens: `resolveApi()` in
//! `src/lib/api.ts` falls back to the mock adapter, and the reason is reported
//! to the frontend rather than swallowed.

mod sidecar;

use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

use sidecar::{Handshake, Sidecar};

struct SidecarState{
    inner: Mutex<Option<Sidecar>>,
    error: Option<String>,
}

impl SidecarState{
    fn kill(&self){
        if let Ok(mut guard) = self.inner.lock(){
            if let Some(sc) = guard.as_mut(){
                sc.kill();
            }
            *guard = None;
        }
    }
}

/// The frontend calls this once, before rendering. An `Err` here is not fatal —
/// it means "run against mock data and say so".
#[tauri::command]
fn sidecar_handshake(state: tauri::State<'_, SidecarState>) -> Result<Handshake, String>{
    let guard = state
        .inner
        .lock()
        .map_err(|_| "sidecar state is poisoned".to_string())?;
    match guard.as_ref(){
        Some(sc) => Ok(sc.handshake.clone()),
        None => Err(state
            .error
            .clone()
            .unwrap_or_else(|| "the sidecar is not running".to_string())),
    }
}

fn main(){
    sidecar::install_panic_hook();

    let (running, error) = match Sidecar::spawn(){
        Ok(sc) => (Some(sc), None),
        Err(e) => {
            eprintln!("sidecar unavailable: {e}");
            (None, Some(e))
        }
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState{ inner: Mutex::new(running), error })
        .invoke_handler(tauri::generate_handler![sidecar_handshake])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed){
                window.state::<SidecarState>().kill();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the tauri application");

    app.run(|handle, event| {
        // Belt and braces: Destroyed already fired for a normal close, but a
        // programmatic exit or a closed last window may not route through it.
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested{ .. }){
            handle.state::<SidecarState>().kill();
        }
    });
}
