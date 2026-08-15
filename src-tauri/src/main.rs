// Prevents a console window from opening alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell.
//!
//! Today this only hosts the web frontend, which runs against the mock adapter
//! in `src/lib/api.ts`. Build step 5 in ARCHITECTURE.md adds `sidecar.rs`:
//! spawn `uv run python -m picsearch.server`, read the single
//! `{"port": …, "token": …}` line from its stdout, expose it to the frontend
//! through a `sidecar_handshake` command, and kill the child on exit *and* on
//! panic. Do not add an auth-bypass flag while doing so — see CLAUDE.md.

fn main(){
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
