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
//! The venv is keyed on a hash of `pyproject.toml` + `uv.lock`, minus the app's
//! own `version` line in each (the project is never installed, so a version
//! bump alone changes nothing in the venv). A release that changes no
//! dependency starts straight away; one that does re-syncs, and uv only
//! touches the packages that moved.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::sidecar::{drain, hidden, stopping, Launch, Sink, SETUP_PID};

/// Oldest driver that runs the cu130 torch wheels. Anything older gets the CPU
/// build: CUDA torch on a driver it cannot use is 3 GB that falls back to the
/// CPU anyway.
const CUDA13_MIN_DRIVER: u32 = 580;

const STATE_FILE: &str = "state.json";

/// An Optimus laptop wakes its GPU for `nvidia-smi`, which takes seconds; a
/// wedged driver never answers. Past this the install stops rather than guess,
/// because the choice is permanent: CPU torch on an NVIDIA machine stays CPU.
const SMI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

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
    /// across Rust versions, unlike `DefaultHasher`. The app's own `version`
    /// line is left out (`[project]` in pyproject, the `picsearch` package in
    /// uv.lock): the venv is synced with `--no-install-project`, so a release
    /// that only bumps it changes nothing in the venv and must not re-run setup.
    /// Every other package's version stays in, or a torch upgrade would hide.
    fn fingerprint(&self) -> Result<String, String>{
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for name in ["pyproject.toml", "uv.lock"]{
            let text = std::fs::read_to_string(self.source.join(name))
                .map_err(|e| format!("could not read {name}: {e}"))?;
            // shortcut: line-based, not a toml parser; fine while both files keep their uv-written shape.
            let (mut table, mut prev) = ("", "");
            for line in text.split_inclusive('\n'){
                let t = line.trim();
                if t.starts_with('['){
                    table = t;
                }
                let own = if name == "uv.lock"{ prev == "name = \"picsearch\"" }else{ table == "[project]" };
                prev = t;
                if own && t.starts_with("version ="){
                    continue;
                }
                for b in line.bytes(){
                    hash ^= u64::from(b);
                    hash = hash.wrapping_mul(0x0100_0000_01b3);
                }
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
    pub fn install(&self, report: &(dyn Fn(Progress) + Sync), sink: Sink) -> Result<Launch, String>{
        std::fs::create_dir_all(&self.root)
            .map_err(|e| format!("could not create {}: {e}", self.root.display()))?;
        // A half-written marker from an interrupted run must not survive it.
        let _ = std::fs::remove_file(self.root.join(STATE_FILE));

        let torch = pick_torch(&sink)?;
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
            .env("UV_NO_PROGRESS", "1")
            .env("NO_COLOR", "1");
        // uv's cache, in a folder of ours that starts empty: its growth is the
        // only live sign of a multi-gigabyte download, because uv prints one
        // "Downloading torch (2.3GiB)" line per package and then nothing until
        // it is done. Deleted afterwards, since the venv does not need it.
        let cache = self.root.join("uv-cache");
        let _ = std::fs::remove_dir_all(&cache);
        uv.env("UV_CACHE_DIR", &cache);
        let announced = Arc::new(AtomicU64::new(0));
        let finished = AtomicBool::new(false);
        let counted = announced.clone();
        let outcome = std::thread::scope(|scope| {
            scope.spawn(|| watch_downloads(&cache, &announced, &finished, report));
            let result = run_streamed(
                uv,
                &sink,
                &mut |_| true,
                Some(Arc::new(move |line: &str| {
                    if let Some(bytes) = announced_download(line){
                        counted.fetch_add(bytes, Ordering::SeqCst);
                    }
                })),
            );
            finished.store(true, Ordering::SeqCst);
            result
        });
        let _ = std::fs::remove_dir_all(&cache);
        outcome?;

        // The model itself downloads in the app, behind a progress pill; this
        // is the smoke test that torch and transformers import.
        report(Progress::Step("Checking the installation".into()));
        let launch = self.launch();
        let mut prefetch = hidden(&launch.program);
        prefetch
            // The watchdog is what ends it if the app is killed mid-download.
            .args(["-m", "picsearch.prefetch", "--parent-pid", &std::process::id().to_string()])
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
        }, None)?;

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
fn pick_torch(sink: &Sink) -> Result<String, String>{
    if let Ok(forced) = std::env::var("PICSEARCH_TORCH"){
        if forced == "cpu" || forced == "cu130"{
            return Ok(forced);
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(
            hidden("nvidia-smi")
                .args(["--query-gpu=name,driver_version", "--format=csv,noheader"])
                .stdin(Stdio::null())
                .output(),
        );
    });
    let output = match rx.recv_timeout(SMI_TIMEOUT){
        Ok(output) => output,
        Err(_) => return Err(format!(
            "nvidia-smi did not answer within {SMI_TIMEOUT:?}. Retry, or start PicSearch with PICSEARCH_TORCH=cpu to skip the GPU check."
        )),
    };
    let Ok(output) = output else{
        sink("nvidia-smi not found".into());
        return Ok("cpu".into());
    };
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let Some(first) = text.lines().next().filter(|_| output.status.success()) else{
        sink("nvidia-smi found no GPU".into());
        return Ok("cpu".into());
    };
    sink(format!("GPU: {}", first.trim()));
    if driver_major(first) >= CUDA13_MIN_DRIVER{
        Ok("cu130".into())
    }else{
        sink(format!("driver is older than {CUDA13_MIN_DRIVER}, which CUDA 13 needs"));
        Ok("cpu".into())
    }
}

/// The driver's major version from an `name, driver_version` line, 0 if unreadable.
fn driver_major(line: &str) -> u32{
    let driver = line.rsplit(',').next().unwrap_or("").trim();
    driver.split('.').next().and_then(|m| m.parse::<u32>().ok()).unwrap_or(0)
}

/// Runs a setup step, feeding every line of stdout through `on_stdout` (which
/// returns whether to also log it) and every line of stderr to the log. Fails
/// with the last lines of output, so the boot screen can say *why*.
/// Called with every line a setup step writes to stderr.
type LineHook = Arc<dyn Fn(&str) + Send + Sync>;

fn run_streamed(
    mut cmd: std::process::Command,
    sink: &Sink,
    on_stdout: &mut dyn FnMut(&str) -> bool,
    on_stderr: Option<LineHook>,
) -> Result<(), String>{
    if stopping(){
        return Err("PicSearch is closing".into());
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {:?}: {e}", cmd.get_program()))?;
    SETUP_PID.store(child.id(), Ordering::SeqCst);
    if stopping(){
        let _ = child.kill();
    }

    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    if let Some(stderr) = child.stderr.take(){
        let (tail, sink) = (tail.clone(), sink.clone());
        drain(stderr, std::sync::Arc::new(move |line: String| {
            if let Some(seen) = &on_stderr{
                seen(&line);
            }
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
        crate::sidecar::for_each_line(stdout, |line| {
            if on_stdout(&line){
                sink(line);
            }
        });
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

/// The size in a line like `Downloading torch (502.1MiB)`, in bytes. uv prints
/// one per package it has to fetch, as soon as it starts, so the sum is the
/// exact download for this machine. The Python interpreter (`cpython-...`) is
/// unpacked outside the cache and is left out.
fn announced_download(line: &str) -> Option<u64>{
    let rest = line.trim().strip_prefix("Downloading ")?;
    if rest.starts_with("cpython-"){
        return None;
    }
    let size = rest.trim_end().strip_suffix(')')?.rsplit_once('(')?.1;
    let split = size.find(|c: char| c.is_alphabetic())?;
    let value: f64 = size[..split].trim().parse().ok()?;
    let unit: f64 = match &size[split..]{
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "B" => 1.0,
        _ => return None,
    };
    Some((value * unit) as u64)
}

/// How big uv's cache ends up for `announced` bytes of downloads. Wheels unpack
/// bigger than they download, and the pure-Python packages that print no
/// download line add a fixed amount. Two real installs fit it: CPU torch, 246
/// MiB announced -> 918 MiB cache; CUDA torch, 2655 MiB -> 4715 MiB.
fn expected_cache_bytes(announced: u64) -> u64{
    530 * 1024 * 1024 + announced / 10 * 16
}

/// Total size of the regular files under `root`. Symlinks are not followed.
fn dir_size(root: &Path) -> u64{
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop(){
        let Ok(entries) = std::fs::read_dir(&dir) else{
            continue;
        };
        for entry in entries.flatten(){
            let Ok(meta) = entry.metadata() else{
                continue;
            };
            if meta.is_dir(){
                stack.push(entry.path());
            }else if meta.is_file(){
                total += meta.len();
            }
        }
    }
    total
}

/// While uv runs, turns the cache's growth into download progress for the boot
/// screen: `done` of the announced `total`, never past 99% until uv exits.
fn watch_downloads(cache: &Path, announced: &AtomicU64, finished: &AtomicBool, report: &(dyn Fn(Progress) + Sync)){
    while !finished.load(Ordering::SeqCst){
        std::thread::sleep(Duration::from_millis(500));
        let total = announced.load(Ordering::SeqCst);
        if total == 0{
            continue;
        }
        let fraction = (dir_size(cache) as f64 / expected_cache_bytes(total) as f64).min(0.99);
        report(Progress::Bytes{ done: (total as f64 * fraction) as u64, total });
    }
}

#[cfg(test)]
mod tests{
    use super::*;

    #[test]
    fn uv_download_lines_are_summed_in_bytes(){
        assert_eq!(announced_download("Downloading torch (502.1MiB)"), Some((502.1 * 1024.0 * 1024.0) as u64));
        assert_eq!(announced_download("  Downloading nvidia-cublas (1.5GiB)  "), Some((1.5 * 1024.0 * 1024.0 * 1024.0) as u64));
        assert_eq!(announced_download("Downloading hf-xet (4.3KiB)"), Some((4.3 * 1024.0) as u64));
    }

    #[test]
    fn lines_that_are_not_package_downloads_are_ignored(){
        assert_eq!(announced_download("Downloading cpython-3.14.5-windows-x86_64-none (download) (34.4MiB)"), None);
        assert_eq!(announced_download(" Downloaded torch"), None);
        assert_eq!(announced_download("Downloading torch"), None);
        assert_eq!(announced_download("Resolved 83 packages in 2ms"), None);
        assert_eq!(announced_download("Downloading x (12.0 parsecs)"), None);
    }

    #[test]
    fn the_cache_estimate_matches_the_two_measured_installs(){
        let mib = 1024 * 1024;
        let within = |got: u64, want: u64| (got as f64 - want as f64).abs() / (want as f64) < 0.05;
        assert!(within(expected_cache_bytes(246 * mib), 918 * mib));
        assert!(within(expected_cache_bytes(2655 * mib), 4715 * mib));
    }

    #[test]
    fn dir_size_counts_files_in_subfolders(){
        let dir = std::env::temp_dir().join(format!("picsearch-dirsize-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("one"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("a/b/two"), vec![0u8; 250]).unwrap();
        assert_eq!(dir_size(&dir), 350);
        assert_eq!(dir_size(&dir.join("missing")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A scratch source + runtime pair under the temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch{
        fn new(name: &str) -> Self{
            let dir = std::env::temp_dir().join(format!("picsearch-test-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("source")).unwrap();
            std::fs::create_dir_all(dir.join("root")).unwrap();
            std::fs::write(dir.join("source").join("pyproject.toml"), "abc").unwrap();
            std::fs::write(dir.join("source").join("uv.lock"), "xyz").unwrap();
            Scratch(dir)
        }

        fn runtime(&self) -> Runtime{
            Runtime{ source: self.0.join("source"), root: self.0.join("root"), uv: PathBuf::from("uv") }
        }
    }

    impl Drop for Scratch{
        fn drop(&mut self){
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn fingerprint_is_fnv_over_both_files_and_moves_with_either(){
        let s = Scratch::new("fingerprint");
        let rt = s.runtime();
        assert_eq!(rt.fingerprint().unwrap(), "fbb3823fd29ec6fe");
        std::fs::write(s.0.join("source").join("uv.lock"), "xyZ").unwrap();
        assert_ne!(rt.fingerprint().unwrap(), "fbb3823fd29ec6fe");
    }

    #[test]
    fn only_the_apps_own_version_is_ignored_by_the_fingerprint(){
        let pyproject = "[project]\nname = \"picsearch\"\nversion = \"1.0.6\"\ndependencies = [\n    \"torch>=2.9\",\n]\n\n[tool.uv]\nfoo = 1\n";
        let lock = "version = 1\n\n[[package]]\nname = \"picsearch\"\nversion = \"1.0.6\"\nsource = { editable = \".\" }\n\n[[package]]\nname = \"torch\"\nversion = \"2.9.0\"\nsource = { registry = \"https://pypi.org/simple\" }\n";
        let s = Scratch::new("own-version");
        let rt = s.runtime();
        let write = |p: &str, l: &str|{
            std::fs::write(s.0.join("source").join("pyproject.toml"), p).unwrap();
            std::fs::write(s.0.join("source").join("uv.lock"), l).unwrap();
        };
        write(pyproject, lock);
        let marker = serde_json::to_string(&State{ fingerprint: rt.fingerprint().unwrap(), torch: "cpu".into() }).unwrap();
        std::fs::write(s.0.join("root").join(STATE_FILE), marker).unwrap();
        std::fs::create_dir_all(rt.python().parent().unwrap()).unwrap();
        std::fs::write(rt.python(), "").unwrap();
        assert!(rt.is_current().unwrap());

        write(&pyproject.replace("1.0.6", "1.0.7"), &lock.replace("picsearch\"\nversion = \"1.0.6", "picsearch\"\nversion = \"1.0.7"));
        assert!(rt.is_current().unwrap(), "own version bumped in both files");

        write(&pyproject.replace("torch>=2.9", "torch>=2.10"), lock);
        assert!(!rt.is_current().unwrap(), "a dependency changed");

        write(pyproject, &lock.replace("2.9.0", "2.9.1"));
        assert!(!rt.is_current().unwrap(), "torch's locked version changed");

        write(&pyproject.replace("foo = 1", "version = \"9\""), lock);
        assert!(!rt.is_current().unwrap(), "a version line outside [project] still counts");
    }

    #[test]
    fn the_venv_is_current_only_with_a_matching_marker_and_a_python(){
        let s = Scratch::new("current");
        let rt = s.runtime();
        assert!(!rt.is_current().unwrap(), "no marker");

        let marker = s.0.join("root").join(STATE_FILE);
        std::fs::write(&marker, "not json").unwrap();
        assert!(!rt.is_current().unwrap(), "corrupt marker");

        let good = serde_json::to_string(&State{ fingerprint: rt.fingerprint().unwrap(), torch: "cpu".into() }).unwrap();
        std::fs::write(&marker, &good).unwrap();
        assert!(!rt.is_current().unwrap(), "marker but no interpreter");

        std::fs::create_dir_all(rt.python().parent().unwrap()).unwrap();
        std::fs::write(rt.python(), "").unwrap();
        assert!(rt.is_current().unwrap());

        std::fs::write(s.0.join("source").join("pyproject.toml"), "changed").unwrap();
        assert!(!rt.is_current().unwrap(), "pyproject changed");
    }

    #[test]
    fn the_cuda_cut_reads_the_driver_major(){
        assert_eq!(driver_major("NVIDIA GeForce RTX 4070 Laptop GPU, 615.71.09"), 615);
        assert_eq!(driver_major("Tesla, K80, 470.82.01"), 470);
        assert!(driver_major("NVIDIA GeForce RTX 4070, 580.95") >= CUDA13_MIN_DRIVER);
        assert_eq!(driver_major("garbage"), 0);
        assert_eq!(driver_major(""), 0);
    }
}
