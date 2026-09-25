//! Sidecar lifecycle: spawn, handshake, and — above all — kill on exit.
//!
//! The failure this file exists to prevent: an orphaned uvicorn process holding
//! 2 GB of VRAM after the app goes away. Both halves are required and neither
//! is sufficient alone.
//!
//! * **Here (Rust)**: hold the `Child`, kill it on window-destroy, on the
//!   runtime's exit event, and from a panic hook. The happy path alone is not
//!   enough.
//! * **There (Python)**: `server.py` watches the pid passed as `--parent-pid`
//!   and calls `os._exit(0)` when it disappears. That is what survives
//!   `pkill -9` on this process, which never gets to run any of the code below.
//!
//! The sidecar prints exactly one JSON line — `{"port": …, "token": …}` — before
//! it starts serving. Everything after that line is log output and is drained
//! into the boot log so a full pipe can never block the child.
//!
//! *How* the sidecar is started is a [`Launch`], decided by `runtime.rs`: `uv
//! run` against the source tree in a debug build, the managed venv's Python
//! directly in a packaged one.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How long to wait for the handshake line. The sidecar loads no model at
/// startup, so this only has to cover importing torch on a cold disk — and, in
/// a debug build, `uv run` resolving the environment first. The packaged
/// first-run install happens *before* this clock starts, with no timeout.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);

/// Read by the panic hook, which cannot borrow the managed state. One slot for
/// the server and one for whichever setup step (uv, prefetch) is running.
static CHILD_PID: AtomicU32 = AtomicU32::new(0);
pub static SETUP_PID: AtomicU32 = AtomicU32::new(0);

/// Where a line of child output goes. The boot screen shows the tail.
pub type Sink = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Handshake{
    pub port: u16,
    pub token: String,
}

/// A program, its arguments and where to run it. `--parent-pid` is appended by
/// [`Sidecar::spawn`], never by the caller, so no launch can forget it.
#[derive(Debug, Clone)]
pub struct Launch{
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub envs: Vec<(String, String)>,
}

pub struct Sidecar{
    child: Option<Child>,
    pub handshake: Handshake,
}

impl Sidecar{
    pub fn spawn(launch: &Launch, sink: Sink) -> Result<Self, String>{
        // No --model flag: the active model comes from config.toml, and passing
        // one here would silently disagree with the vectors already in the DB.
        let mut child = hidden(&launch.program)
            .args(&launch.args)
            .args(["--parent-pid", &std::process::id().to_string()])
            .envs(launch.envs.iter().map(|(k, v)| (k, v)))
            .current_dir(&launch.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", launch.program.display()))?;

        CHILD_PID.store(child.id(), Ordering::SeqCst);

        let stdout = child.stdout.take().ok_or("sidecar stdout was not piped")?;
        if let Some(stderr) = child.stderr.take(){
            drain(stderr, sink.clone());
        }

        // Read the handshake off a worker thread so a sidecar that dies before
        // printing anything cannot hang the boot.
        let (tx, rx) = mpsc::channel::<Result<Handshake, String>>();
        let after = sink.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let outcome = match reader.read_line(&mut line){
                Ok(0) => Err("the sidecar exited before printing its handshake".to_string()),
                Ok(_) => serde_json::from_str::<Handshake>(line.trim())
                    .map_err(|e| format!("unparseable handshake {line:?}: {e}")),
                Err(e) => Err(format!("could not read the handshake: {e}")),
            };
            let ok = outcome.is_ok();
            let _ = tx.send(outcome);
            // Everything after the handshake is log noise; keep draining it.
            if ok{
                drain(reader.into_inner(), after);
            }
        });

        match rx.recv_timeout(HANDSHAKE_TIMEOUT){
            Ok(Ok(handshake)) => {
                sink(format!("sidecar listening on 127.0.0.1:{}", handshake.port));
                Ok(Sidecar{ child: Some(child), handshake })
            }
            Ok(Err(e)) => {
                let _ = child.kill();
                let _ = child.wait();
                CHILD_PID.store(0, Ordering::SeqCst);
                Err(e)
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                CHILD_PID.store(0, Ordering::SeqCst);
                Err(format!("the sidecar did not hand over a port within {HANDSHAKE_TIMEOUT:?}"))
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

/// A `Command` that opens no console window. The release binary is a GUI
/// subsystem app on Windows, so every console child would otherwise get a
/// black window of its own for as long as it runs — uv for the whole install,
/// Python for the whole session.
pub fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command{
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn kill_pid(pid: u32){
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
    #[cfg(windows)]
    {
        // /T takes the tree: uv's own children go with it.
        let _ = hidden("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    }
}

/// Kills the children without touching managed state. Safe to call from a
/// panic hook, where borrowing anything is not an option.
pub fn kill_orphan(){
    for slot in [&CHILD_PID, &SETUP_PID]{
        let pid = slot.swap(0, Ordering::SeqCst);
        if pid != 0{
            kill_pid(pid);
        }
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

pub fn drain<R: std::io::Read + Send + 'static>(stream: R, sink: Sink){
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok){
            sink(line);
        }
    });
}
