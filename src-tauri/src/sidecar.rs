//! Sidecar lifecycle: spawn, handshake, and — above all — kill on exit.
//!
//! The failure this file exists to prevent: an orphaned uvicorn process holding
//! 2 GB of VRAM after the app goes away. Both halves are required and neither
//! is sufficient alone.
//!
//! * **Here (Rust)**: hold the `Child`, kill it on window-destroy, on the
//!   runtime's exit event, and from a panic hook. The happy path alone is not
//!   enough.
//! * **There (Python)**: `server.py` watches its parent pid and calls
//!   `os._exit(0)` when it changes. That is what survives `pkill -9` on this
//!   process, which never gets to run any of the code below.
//!
//! The sidecar prints exactly one JSON line — `{"port": …, "token": …}` — before
//! it starts serving. Everything after that line is log output and is drained
//! into stderr so a full pipe can never block the child.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How long to wait for the handshake line. The sidecar loads no model at
/// startup, so this is generous — it covers a cold `uv sync` resolving first.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);

/// Read by the panic hook, which cannot borrow the managed state.
static CHILD_PID: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Handshake{
    pub port: u16,
    pub token: String,
}

pub struct Sidecar{
    child: Option<Child>,
    pub handshake: Handshake,
}

impl Sidecar{
    pub fn spawn() -> Result<Self, String>{
        let dir = sidecar_dir()?;

        // No --model flag: the active model comes from config.toml, and passing
        // one here would silently disagree with the vectors already in the DB.
        let mut child = Command::new("uv")
            .args([
                "run",
                "python",
                "-m",
                "picsearch.server",
                "--parent-pid",
                &std::process::id().to_string(),
            ])
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start the sidecar in {}: {e}", dir.display()))?;

        CHILD_PID.store(child.id(), Ordering::SeqCst);

        let stdout = child.stdout.take().ok_or("sidecar stdout was not piped")?;
        if let Some(stderr) = child.stderr.take(){
            drain("sidecar", stderr);
        }

        // Read the handshake off a worker thread so a sidecar that dies before
        // printing anything cannot hang the whole app.
        let (tx, rx) = mpsc::channel::<Result<Handshake, String>>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let outcome = match reader.read_line(&mut line){
                Ok(0) => Err("sidecar exited before printing its handshake".to_string()),
                Ok(_) => serde_json::from_str::<Handshake>(line.trim())
                    .map_err(|e| format!("unparseable handshake {line:?}: {e}")),
                Err(e) => Err(format!("could not read the handshake: {e}")),
            };
            let ok = outcome.is_ok();
            let _ = tx.send(outcome);
            // Everything after the handshake is log noise; keep draining it.
            if ok{
                drain("sidecar", reader.into_inner());
            }
        });

        match rx.recv_timeout(HANDSHAKE_TIMEOUT){
            Ok(Ok(handshake)) => {
                eprintln!("sidecar listening on 127.0.0.1:{}", handshake.port);
                Ok(Sidecar{ child: Some(child), handshake })
            }
            Ok(Err(e)) => {
                let _ = child.kill();
                Err(e)
            }
            Err(_) => {
                let _ = child.kill();
                Err(format!("sidecar did not hand over a port within {HANDSHAKE_TIMEOUT:?}"))
            }
        }
    }

    pub fn kill(&mut self){
        if let Some(mut child) = self.child.take(){
            let _ = child.kill();
            let _ = child.wait();
            CHILD_PID.store(0, Ordering::SeqCst);
            eprintln!("sidecar stopped");
        }
    }
}

impl Drop for Sidecar{
    fn drop(&mut self){
        self.kill();
    }
}

/// Kills the child without touching managed state. Safe to call from a panic
/// hook, where borrowing anything is not an option.
pub fn kill_orphan(){
    let pid = CHILD_PID.swap(0, Ordering::SeqCst);
    if pid == 0{
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

/// Installs a panic hook that takes the sidecar down with the app.
pub fn install_panic_hook(){
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        kill_orphan();
        previous(info);
    }));
}

/// Where `picsearch` lives. Packaging is dev-mode only for v0.1 (see
/// ARCHITECTURE.md), so this resolves against the source tree, with an env
/// override for anyone running the shell from somewhere else.
fn sidecar_dir() -> Result<PathBuf, String>{
    if let Ok(dir) = std::env::var("PICSEARCH_SIDECAR_DIR"){
        return Ok(PathBuf::from(dir));
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest
        .parent()
        .ok_or("could not resolve the project root")?
        .join("sidecar");
    if candidate.is_dir(){
        return Ok(candidate);
    }
    Err(format!(
        "no sidecar directory at {} — set PICSEARCH_SIDECAR_DIR",
        candidate.display()
    ))
}

fn drain<R: std::io::Read + Send + 'static>(tag: &'static str, stream: R){
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok){
            eprintln!("[{tag}] {line}");
        }
    });
}
