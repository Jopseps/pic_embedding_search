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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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

/// Set once the app is going away for good, so a boot thread that is between
/// two steps cannot start a child nothing will ever kill.
static STOPPING: AtomicBool = AtomicBool::new(false);

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
        if stopping(){
            return Err("PicSearch is closing".into());
        }
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
        if stopping(){
            // Shutdown ran between the check above and the pid store.
            let _ = child.kill();
        }

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

    pub fn pid(&self) -> Option<u32>{
        self.child.as_ref().map(Child::id)
    }

    /// The exit status once the child has gone away on its own. Reaps it, so no
    /// zombie holds the pid, and forgets the pid so `kill_orphan` cannot hit a
    /// recycled one. `kill()` afterwards is a no-op.
    pub fn exited(&mut self) -> Option<std::process::ExitStatus>{
        let status = self.child.as_mut()?.try_wait().ok().flatten()?;
        self.child = None;
        CHILD_PID.store(0, Ordering::SeqCst);
        Some(status)
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
///
/// It also scrubs what an AppImage's `AppRun` exports into our environment:
/// `PYTHONHOME` and `PYTHONPATH` pointing into the mount (so uv's managed
/// CPython cannot find its own standard library and dies on
/// `No module named 'encodings'`), and an `LD_LIBRARY_PATH` that would make
/// Python and torch load the webview's bundled libraries instead of their own.
pub fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command{
    let mut cmd = Command::new(program);
    cmd.env_remove("PYTHONHOME").env_remove("PYTHONPATH");
    if std::env::var_os("APPIMAGE").is_some(){
        cmd.env_remove("LD_LIBRARY_PATH");
    }
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

pub fn stopping() -> bool{
    STOPPING.load(Ordering::SeqCst)
}

/// The app is exiting: refuse new children, kill the running ones.
pub fn begin_shutdown(){
    STOPPING.store(true, Ordering::SeqCst);
    kill_orphan();
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
    std::thread::spawn(move || for_each_line(stream, |line| sink(line)));
}

/// Every line of `stream`, until it really ends.
///
/// Not `BufReader::lines().map_while(Result::ok)`: `lines()` fails on a line
/// that is not valid UTF-8, `map_while` stops at the first failure, and the
/// thread then drops the pipe — so the child's next write to it errors. On a
/// Turkish Windows Python writes an em dash in the ANSI code page, which is
/// not UTF-8, and the sidecar lost its stderr seconds after starting; the model
/// load then died flushing it. Invalid bytes become U+FFFD instead.
pub fn for_each_line<R: std::io::Read>(stream: R, mut f: impl FnMut(String)){
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop{
        buf.clear();
        match reader.read_until(b'\n', &mut buf){
            Ok(0) | Err(_) => break,
            Ok(_) => f(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string()),
        }
    }
}

#[cfg(all(test, unix))]
mod tests{
    use super::*;

    const HELLO: &str = r#"echo '{"port": 4242, "token": "t0k"}'"#;

    /// `sh -c <script>`; `--parent-pid N` lands in `$0 $1` and is ignored.
    fn sh(script: String) -> Launch{
        Launch{
            program: PathBuf::from("sh"),
            args: vec!["-c".into(), script],
            cwd: std::env::temp_dir(),
            envs: Vec::new(),
        }
    }

    fn quiet() -> Sink{
        Arc::new(|_| {})
    }

    fn alive(pid: u32) -> bool{
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
    }

    #[test]
    fn hands_over_the_handshake_and_kill_stops_the_child(){
        let mut sc = Sidecar::spawn(&sh(format!("{HELLO}; exec sleep 60")), quiet()).unwrap();
        assert_eq!(sc.handshake.port, 4242);
        assert_eq!(sc.handshake.token, "t0k");
        let pid = sc.child.as_ref().unwrap().id();
        assert!(alive(pid));
        sc.kill();
        assert!(!alive(pid));
    }

    #[test]
    fn a_sidecar_that_exits_before_the_handshake_is_an_error_not_a_hang(){
        let err = Sidecar::spawn(&sh("echo boom >&2; exit 3".into()), quiet()).err().unwrap();
        assert!(err.contains("exited before"), "{err}");
    }

    #[test]
    fn a_garbled_handshake_is_an_error_and_the_child_is_killed(){
        let err = Sidecar::spawn(&sh("echo hello; exec sleep 60".into()), quiet()).err().unwrap();
        assert!(err.contains("unparseable"), "{err}");
    }

    #[test]
    fn output_that_is_not_utf8_does_not_end_the_stream(){
        let mut seen = Vec::new();
        let bytes: &[u8] = b"first\r\nbad \x97 dash\nlast";
        for_each_line(bytes, |l| seen.push(l));
        assert_eq!(seen, vec!["first".to_string(), "bad \u{FFFD} dash".to_string(), "last".to_string()]);
    }

    #[test]
    fn a_chatty_stderr_never_blocks_the_child(){
        let mark = std::env::temp_dir().join(format!("picsearch-chatty-{}", std::process::id()));
        let _ = std::fs::remove_file(&mark);
        let mut launch = sh(format!("{HELLO}; yes | head -c 3000000 >&2; touch \"$MARK\"; exec sleep 60"));
        launch.envs.push(("MARK".into(), mark.display().to_string()));
        let mut sc = Sidecar::spawn(&launch, quiet()).unwrap();
        for _ in 0..100{
            if mark.exists(){
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let finished = mark.exists();
        sc.kill();
        let _ = std::fs::remove_file(&mark);
        assert!(finished, "the child stalled on a full stderr pipe");
    }
}
