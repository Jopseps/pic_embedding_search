//! The boot state machine the frontend polls: install → start → ready.
//!
//! All of it runs on a worker thread spawned from `setup()`, so the window is
//! on screen from the first frame. Before this, the sidecar was started in
//! `main()` ahead of the Tauri builder: no window until the handshake, and a
//! first run that downloads 3 GB of torch would have been a blank desktop for
//! ten minutes and then a timeout.
//!
//! The frontend polls `backend_status` rather than listening for events, so a
//! page that mounts late — or reloads — can never miss the one event that said
//! "ready".

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::runtime::{self, Plan, Progress};
use crate::sidecar::{Handshake, Sidecar, Sink};

const LOG_LINES: usize = 200;

/// How often the monitor asks whether the sidecar is still there.
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(1);

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase{
    Checking,
    #[serde(rename_all = "camelCase")]
    Installing{ step: String, done: u64, total: u64 },
    Starting,
    Ready{ handshake: Handshake },
    Failed{ message: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status{
    #[serde(flatten)]
    phase: Phase,
    /// This launch ran the first-run install (or an update of it).
    installed: bool,
    /// Things worth telling the user that are not errors: which torch build
    /// was picked, that tesseract is missing and how to get it.
    notes: Vec<String>,
    log: Vec<String>,
}

struct Inner{
    phase: Phase,
    installed: bool,
    notes: Vec<String>,
    log: VecDeque<String>,
    /// A boot thread is running. Retry and reset are refused meanwhile.
    busy: bool,
    sidecar: Option<Sidecar>,
}

#[derive(Clone)]
pub struct Backend{
    inner: Arc<Mutex<Inner>>,
}

impl Backend{
    pub fn new() -> Self{
        Backend{
            inner: Arc::new(Mutex::new(Inner{
                phase: Phase::Checking,
                installed: false,
                notes: Vec::new(),
                log: VecDeque::new(),
                busy: false,
                sidecar: None,
            })),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T{
        let mut guard = match self.inner.lock(){
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut guard)
    }

    fn set(&self, phase: Phase){
        self.with(|s| s.phase = phase);
    }

    fn sink(&self) -> Sink{
        let me = self.clone();
        Arc::new(move |line: String| {
            eprintln!("[sidecar] {line}");
            me.with(|s| {
                s.log.push_back(line);
                while s.log.len() > LOG_LINES{
                    s.log.pop_front();
                }
            });
        })
    }

    pub fn status(&self) -> Status{
        self.with(|s| Status{
            phase: s.phase.clone(),
            installed: s.installed,
            notes: s.notes.clone(),
            log: s.log.iter().cloned().collect(),
        })
    }

    /// Starts a boot on its own thread. A no-op while one is running or once
    /// the sidecar is up, so a double-clicked Retry cannot spawn two.
    pub fn boot(&self, app: AppHandle){
        let go = self.with(|s| {
            if s.busy || s.sidecar.is_some(){
                return false;
            }
            s.busy = true;
            s.phase = Phase::Checking;
            s.notes.clear();
            true
        });
        if !go{
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let outcome = me.run(&app);
            me.finish(outcome);
        });
    }

    /// Ends a boot: the sidecar becomes the live one and gets a monitor, or the
    /// failure becomes the phase.
    fn finish(&self, outcome: Result<Sidecar, String>){
        let pid = self.with(|s| {
            s.busy = false;
            match outcome{
                Ok(sidecar) => {
                    let pid = sidecar.pid();
                    s.phase = Phase::Ready{ handshake: sidecar.handshake.clone() };
                    s.sidecar = Some(sidecar);
                    pid
                }
                Err(message) => {
                    eprintln!("sidecar unavailable: {message}");
                    s.phase = Phase::Failed{ message };
                    None
                }
            }
        });
        if let Some(pid) = pid{
            self.watch(pid);
        }
    }

    /// Notices a sidecar that dies on its own after a good start, so the
    /// frontend (which keeps polling `backend_status`) can offer a restart.
    /// Every intentional stop (`kill`) takes the sidecar out of the state under
    /// the same lock, and the pid check keeps a monitor from judging a newer
    /// sidecar, so only a real death reaches the `Failed` branch.
    fn watch(&self, pid: u32){
        let me = self.clone();
        std::thread::spawn(move || loop{
            std::thread::sleep(WATCH_EVERY);
            let done = me.with(|s| {
                let Some(sidecar) = s.sidecar.as_mut().filter(|sc| sc.pid() == Some(pid)) else{
                    return true;
                };
                let Some(status) = sidecar.exited() else{
                    return false;
                };
                s.sidecar = None;
                let line = format!("the sidecar exited on its own: {status}");
                eprintln!("{line}");
                s.log.push_back(line);
                s.phase = Phase::Failed{
                    message: format!("The search backend stopped unexpectedly ({status}). The log below has its last output."),
                };
                true
            });
            if done{
                return;
            }
        });
    }

    fn run(&self, app: &AppHandle) -> Result<Sidecar, String>{
        let sink = self.sink();
        let launch = match runtime::plan(app)?{
            Plan::Ready(launch) => launch,
            Plan::Install(rt) => {
                self.with(|s| s.installed = true);
                sink(format!("setting up the Python environment in {}", rt.root.display()));
                let report = |p: Progress| match p{
                    Progress::Step(step) => self.set(Phase::Installing{ step, done: 0, total: 0 }),
                    Progress::Bytes{ done, total } => self.with(|s| {
                        if let Phase::Installing{ done: d, total: t, .. } = &mut s.phase{
                            *d = done;
                            *t = total;
                        }
                    }),
                    Progress::Note(note) => self.with(|s| s.notes.push(note)),
                };
                rt.install(&report, sink.clone())?
            }
        };
        self.set(Phase::Starting);
        Sidecar::spawn(&launch, sink)
    }

    /// Deletes the managed environment and installs it again from scratch.
    /// The one repair a user can do without a terminal. Model weights live in
    /// the shared HF cache and survive it.
    pub fn reset(&self, app: AppHandle) -> Result<(), String>{
        if self.with(|s| s.busy){
            return Err("setup is still running".into());
        }
        self.kill();
        let root = runtime::runtime_root()?;
        if root.exists(){
            std::fs::remove_dir_all(&root)
                .map_err(|e| format!("could not delete {}: {e}", root.display()))?;
        }
        self.boot(app);
        Ok(())
    }

    /// The app is exiting: like `kill`, and nothing may be started afterwards.
    pub fn shutdown(&self){
        crate::sidecar::begin_shutdown();
        self.kill();
    }

    pub fn kill(&self){
        self.with(|s| {
            if let Some(mut sc) = s.sidecar.take(){
                sc.kill();
            }
        });
        crate::sidecar::kill_orphan();
    }
}

#[tauri::command]
pub fn backend_status(state: tauri::State<'_, Backend>) -> Status{
    state.status()
}

#[tauri::command]
pub fn backend_retry(app: AppHandle){
    app.state::<Backend>().boot(app.clone());
}

#[tauri::command]
pub fn backend_reset(app: AppHandle) -> Result<(), String>{
    app.state::<Backend>().reset(app.clone())
}

#[cfg(all(test, unix))]
mod tests{
    use super::*;
    use crate::sidecar::Launch;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    const HELLO: &str = r#"echo '{"port": 4242, "token": "t0k"}'"#;

    fn backend_with(script: &str) -> Backend{
        let backend = Backend::new();
        let launch = Launch{
            program: PathBuf::from("sh"),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::temp_dir(),
            envs: Vec::new(),
        };
        backend.finish(Sidecar::spawn(&launch, backend.sink()));
        backend
    }

    fn failed(backend: &Backend) -> Option<String>{
        match backend.status().phase{
            Phase::Failed{ message } => Some(message),
            _ => None,
        }
    }

    #[test]
    fn a_sidecar_that_dies_after_a_good_start_turns_the_phase_to_failed(){
        let backend = backend_with(&format!("{HELLO}; echo last words >&2; sleep 1; exit 7"));
        assert!(matches!(backend.status().phase, Phase::Ready{ .. }));
        let deadline = Instant::now() + Duration::from_secs(10);
        while failed(&backend).is_none() && Instant::now() < deadline{
            std::thread::sleep(Duration::from_millis(100));
        }
        let message = failed(&backend).expect("the death was never noticed");
        assert!(message.contains("stopped unexpectedly"), "{message}");
        assert!(backend.with(|s| s.sidecar.is_none()), "a retry must be allowed to boot");
    }

    #[test]
    fn a_live_sidecar_stays_ready_and_an_intentional_kill_is_not_a_death(){
        let backend = backend_with(&format!("{HELLO}; exec sleep 60"));
        std::thread::sleep(WATCH_EVERY * 2 + Duration::from_millis(500));
        assert!(matches!(backend.status().phase, Phase::Ready{ .. }));
        backend.kill();
        std::thread::sleep(WATCH_EVERY * 2 + Duration::from_millis(500));
        assert!(failed(&backend).is_none(), "an intentional kill was reported as a crash");
    }
}
