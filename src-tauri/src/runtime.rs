//! Where the Python sidecar comes from, and building it on first run.
//!
//! Two shapes, picked at compile time:
//!
//! * **Debug build** (`npm run tauri dev`): `uv run python -m picsearch.server`
//!   in the checkout's `sidecar/`, against its own `.venv`. Nothing to install,
//!   nothing to wait for — the fast loop stays exactly what it was.
//! * **Release build** (the packages): the sidecar *source* ships as a bundle
//!   resource, a `uv` binary ships next to the executable, and the first launch
//!   builds a venv in the user's data dir. torch is ~3 GB, so freezing it into
//!   the package was never on the table (see ARCHITECTURE.md).
//!
//! The resource dir is read-only, and inside an AppImage it is a different
//! `/tmp/.mount_*` path on every launch. So nothing is ever installed *from*
//! it: `uv sync --no-install-project` puts only the dependencies in the venv,
//! and the server runs with its cwd in the resource dir, where `python -m`
//! finds the `picsearch` package on `sys.path` without an install. An editable
//! install would record this launch's mount path and break on the next one.
//!
//! The venv is keyed on a hash of `pyproject.toml` + `uv.lock`. A release that
//! changes neither starts straight away; one that changes either re-syncs, and
//! uv only touches the packages that moved.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::sidecar::{drain, hidden, Launch, Sink, SETUP_PID};

/// Oldest driver that runs the cu130 torch wheels. Anything older gets the CPU
/// build: CUDA torch on a driver it cannot use is 3 GB that falls back to the
/// CPU anyway.
const CUDA13_MIN_DRIVER: u32 = 580;

const STATE_FILE: &str = "state.json";

/// What the boot screen is told while the install runs.
pub enum Progress{
    Step(String),
    Bytes{ done: u64, total: u64 },
    Note(String),
}

pub enum Plan{
    /// Launch as is.
    Ready(Launch),
    /// Install first, then launch.
    Install(Runtime),
}

#[derive(Serialize, Deserialize)]
struct State{
    fingerprint: String,
    torch: String,
}

pub struct Runtime{
    /// The read-only sidecar source: `picsearch/`, `pyproject.toml`, `uv.lock`.
    source: PathBuf,
    /// Writable, ours: `venv/`, `python/` (uv-managed interpreters), `state.json`.
    pub root: PathBuf,
    uv: PathBuf,
}

/// Decides how this launch starts the sidecar.
pub fn plan(app: &AppHandle) -> Result<Plan, String>{
    if let Ok(dir) = std::env::var("PICSEARCH_SIDECAR_DIR"){
        return Ok(Plan::Ready(dev_launch(PathBuf::from(dir))));
    }
    // PICSEARCH_PACKAGED=1 runs the release path from a debug build, which is
    // the only way to exercise the installer without cutting a bundle.
    if cfg!(debug_assertions) && std::env::var("PICSEARCH_PACKAGED").is_err(){
        return dev_plan();
    }
    let runtime = Runtime::locate(app)?;
    if runtime.is_current()?{
        Ok(Plan::Ready(runtime.launch()))
    }else{
        Ok(Plan::Install(runtime))
    }
}

#[cfg(debug_assertions)]
fn dev_plan() -> Result<Plan, String>{
    // Only compiled into debug builds: a release binary built in CI would
    // otherwise carry the runner's checkout path around forever.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest
        .parent()
        .ok_or("could not resolve the project root")?
        .join("sidecar");
    if candidate.is_dir(){
        return Ok(Plan::Ready(dev_launch(candidate)));
    }
    Err(format!(
        "no sidecar directory at {} — set PICSEARCH_SIDECAR_DIR",
        candidate.display()
    ))
}

#[cfg(not(debug_assertions))]
fn dev_plan() -> Result<Plan, String>{
    unreachable!("the dev plan exists only in debug builds")
}

fn dev_launch(dir: PathBuf) -> Launch{
    Launch{
        program: PathBuf::from("uv"),
        args: ["run", "python", "-m", "picsearch.server", "--scan-on-start"].map(String::from).to_vec(),
        cwd: dir,
        envs: Vec::new(),
    }
}

impl Runtime{
    fn locate(app: &AppHandle) -> Result<Self, String>{
        let source = match std::env::var("PICSEARCH_SIDECAR_SOURCE"){
            Ok(dir) => PathBuf::from(dir),
            Err(_) => app
                .path()
                .resource_dir()
                .map_err(|e| format!("no resource dir: {e}"))?
                .join("sidecar"),
        };
        if !source.join("picsearch").is_dir(){
            return Err(format!("the sidecar source is missing from {}", source.display()));
        }
        Ok(Runtime{ source, root: runtime_root()?, uv: find_uv() })
    }

    fn venv(&self) -> PathBuf{
        self.root.join("venv")
    }

    fn python(&self) -> PathBuf{
        if cfg!(windows){
            self.venv().join("Scripts").join("python.exe")
        }else{
            self.venv().join("bin").join("python")
        }
    }

    fn launch(&self) -> Launch{
        Launch{
            program: self.python(),
            args: ["-m", "picsearch.server", "--scan-on-start"].map(String::from).to_vec(),
            cwd: self.source.clone(),
            // ~/.local/lib/python3.x/site-packages must not leak into a venv
            // whose whole point is that it is exactly the lockfile.
            envs: vec![("PYTHONNOUSERSITE".into(), "1".into())],
        }
    }

    /// FNV-1a over the two files that decide what the venv contains. Stable
    /// across Rust versions, unlike `DefaultHasher`.
    fn fingerprint(&self) -> Result<String, String>{
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for name in ["pyproject.toml", "uv.lock"]{
            let bytes = std::fs::read(self.source.join(name))
                .map_err(|e| format!("could not read {name}: {e}"))?;
            for b in bytes{
                hash ^= u64::from(b);
                hash = hash.wrapping_mul(0x0100_0000_01b3);
            }
        }
        Ok(format!("{hash:016x}"))
    }

    fn is_current(&self) -> Result<bool, String>{
        let Ok(text) = std::fs::read_to_string(self.root.join(STATE_FILE)) else{
            return Ok(false);
        };
        let Ok(state) = serde_json::from_str::<State>(&text) else{
            return Ok(false);
        };
        Ok(state.fingerprint == self.fingerprint()? && self.python().is_file())
    }

    /// Builds (or updates) the venv and fetches the model weights. Blocks for
    /// as long as the downloads take; the caller runs it on its own thread.
    pub fn install(&self, report: &dyn Fn(Progress), sink: Sink) -> Result<Launch, String>{
        std::fs::create_dir_all(&self.root)
            .map_err(|e| format!("could not create {}: {e}", self.root.display()))?;
        // A half-written marker from an interrupted run must not survive it.
        let _ = std::fs::remove_file(self.root.join(STATE_FILE));

        let torch = pick_torch(&sink);
        report(Progress::Note(match torch.as_str(){
            "cu130" => "NVIDIA GPU found — installing CUDA PyTorch (about 3 GB)".to_string(),
            _ => "No usable NVIDIA GPU — installing CPU PyTorch (about 200 MB). Indexing is slower without a GPU.".to_string(),
        }));

        report(Progress::Step("Installing Python and packages".into()));
        let mut uv = hidden(&self.uv);
        uv.args(["sync", "--frozen", "--no-install-project", "--no-default-groups", "--group", &torch])
            .arg("--project")
            .arg(&self.source)
            .env("UV_PROJECT_ENVIRONMENT", self.venv())
            // Our own interpreter, not /usr/bin/python3: a distro upgrade of the
            // system Python would otherwise break the venv under the user's feet.
            .env("UV_PYTHON_INSTALL_DIR", self.root.join("python"))
            .env("UV_PYTHON_PREFERENCE", "only-managed")
            .env("UV_NO_PROGRESS", "1");
        run_streamed(uv, &sink, &mut |_| true)?;

        report(Progress::Step("Downloading the search model".into()));
        let launch = self.launch();
        let mut prefetch = hidden(&launch.program);
        prefetch
            .args(["-m", "picsearch.prefetch"])
            .current_dir(&launch.cwd)
            .envs(launch.envs.iter().map(|(k, v)| (k, v)))
            // tqdm redraws with `\r`, which a line reader sees as one endless
            // line. prefetch reports its own progress instead.
            .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
            .env("TQDM_DISABLE", "1");
        run_streamed(prefetch, &sink, &mut |line| {
            if let Some(rest) = line.strip_prefix("PROGRESS "){
                let mut parts = rest.split_whitespace().map(|n| n.parse::<u64>().unwrap_or(0));
                let done = parts.next().unwrap_or(0);
                let total = parts.next().unwrap_or(0);
                report(Progress::Bytes{ done, total });
                return false;
            }
            if let Some(note) = line.strip_prefix("NOTE "){
                report(Progress::Note(note.to_string()));
            }
            true
        })?;

        let state = State{ fingerprint: self.fingerprint()?, torch };
        let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
        std::fs::write(self.root.join(STATE_FILE), text)
            .map_err(|e| format!("could not write the setup marker: {e}"))?;
        Ok(launch)
    }
}

/// `<data dir>/pic-search/runtime` — next to the sidecar's own `index.db` on
/// Linux, so one folder holds everything the app wrote. Keyed on the sidecar's
/// app name rather than the bundle identifier, so renaming the app never
/// orphans an environment.
pub fn runtime_root() -> Result<PathBuf, String>{
    if let Ok(dir) = std::env::var("PICSEARCH_RUNTIME_DIR"){
        return Ok(PathBuf::from(dir));
    }
    let base = if cfg!(windows){
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    }else{
        std::env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join(".local/share")))
    };
    base.map(|b| b.join("pic-search").join("runtime"))
        .ok_or_else(|| "could not find a data directory for the Python environment".to_string())
}

/// The bundled uv sits next to our executable (Tauri's `externalBin`), named
/// `picsearch-uv` so a .deb never collides with a distro's own `/usr/bin/uv`.
/// Falls back to a `uv` on PATH for a build that did not bundle one.
fn find_uv() -> PathBuf{
    let name = if cfg!(windows){ "picsearch-uv.exe" }else{ "picsearch-uv" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)){
        let bundled = dir.join(name);
        if bundled.is_file(){
            return bundled;
        }
    }
    PathBuf::from("uv")
}

/// `cu130` when an NVIDIA driver new enough for it answers, `cpu` otherwise.
/// `PICSEARCH_TORCH` overrides either way.
fn pick_torch(sink: &Sink) -> String{
    if let Ok(forced) = std::env::var("PICSEARCH_TORCH"){
        if forced == "cpu" || forced == "cu130"{
            return forced;
        }
    }
    let output = hidden("nvidia-smi")
        .args(["--query-gpu=name,driver_version", "--format=csv,noheader"])
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else{
        sink("nvidia-smi not found".into());
        return "cpu".into();
    };
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let Some(first) = text.lines().next().filter(|_| output.status.success()) else{
        sink("nvidia-smi found no GPU".into());
        return "cpu".into();
    };
    sink(format!("GPU: {}", first.trim()));
    let driver = first.rsplit(',').next().unwrap_or("").trim();
    let major = driver.split('.').next().and_then(|m| m.parse::<u32>().ok()).unwrap_or(0);
    if major >= CUDA13_MIN_DRIVER{
        "cu130".into()
    }else{
        sink(format!("driver {driver} is older than {CUDA13_MIN_DRIVER}, which CUDA 13 needs"));
        "cpu".into()
    }
}

/// Runs a setup step, feeding every line of stdout through `on_stdout` (which
/// returns whether to also log it) and every line of stderr to the log. Fails
/// with the last lines of output, so the boot screen can say *why*.
fn run_streamed(mut cmd: std::process::Command, sink: &Sink, on_stdout: &mut dyn FnMut(&str) -> bool) -> Result<(), String>{
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {:?}: {e}", cmd.get_program()))?;
    SETUP_PID.store(child.id(), Ordering::SeqCst);

    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    if let Some(stderr) = child.stderr.take(){
        let (tail, sink) = (tail.clone(), sink.clone());
        drain(stderr, std::sync::Arc::new(move |line: String| {
            if let Ok(mut t) = tail.lock(){
                t.push(line.clone());
                let len = t.len();
                if len > 12{
                    t.drain(..len - 12);
                }
            }
            sink(line);
        }));
    }
    if let Some(stdout) = child.stdout.take(){
        for line in BufReader::new(stdout).lines().map_while(Result::ok){
            if on_stdout(&line){
                sink(line);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string());
    SETUP_PID.store(0, Ordering::SeqCst);
    let status = status?;
    if status.success(){
        return Ok(());
    }
    // stderr drains on its own thread; give it a moment to catch up.
    std::thread::sleep(std::time::Duration::from_millis(100));
    let why = tail.lock().map(|t| t.join("\n")).unwrap_or_default();
    Err(format!("{:?} exited with {status}\n{why}", cmd.get_program()))
}
