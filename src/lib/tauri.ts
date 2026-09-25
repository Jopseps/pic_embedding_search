/**
 * The only place that touches the Tauri APIs.
 *
 * Every import is dynamic: the same bundle runs in a plain browser (`npm run
 * dev`) and under jsdom in the tests, where `@tauri-apps/*` has no host to talk
 * to. Static imports would break both.
 */

import type { SidecarHandshake } from "./api";

export function isTauri(): boolean{
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Where the Rust shell is in bringing the sidecar up. Mirrors `backend.rs`. */
export type BackendPhase =
    | { phase: "checking" }
    | { phase: "installing"; step: string; done: number; total: number }
    | { phase: "starting" }
    | { phase: "ready"; handshake: SidecarHandshake }
    | { phase: "failed"; message: string };

export type BackendStatus = BackendPhase & {
    /** This launch ran the first-run install, or an update of it. */
    installed: boolean;
    notes: string[];
    log: string[];
};

async function invoke<T>(cmd: string): Promise<T>{
    const core = await import("@tauri-apps/api/core");
    return await core.invoke<T>(cmd);
}

/** Polled by the boot screen until the phase is `ready` or `failed`. */
export function backendStatus(): Promise<BackendStatus>{
    return invoke<BackendStatus>("backend_status");
}

/** Boots again after a failure. A no-op while one is running. */
export function backendRetry(): Promise<void>{
    return invoke<void>("backend_retry");
}

/** Deletes the managed Python environment and installs it from scratch. */
export function backendReset(): Promise<void>{
    return invoke<void>("backend_reset");
}

/**
 * Hands `paths` to the OS as a file drag already in progress.
 *
 * Called the moment the pointer leaves the window during an in-app drag, which
 * is the only point where the two halves can be told apart: inside the window
 * the drop targets are ours (a sidebar collection), outside it they belong to
 * whatever the compositor says is under the cursor.
 *
 * A no-op in the browser dev server, where there is no OS drag to start, and
 * silent on failure — a drag that the compositor refuses is not an error worth
 * a toast, and on Wayland it may simply not be offered.
 */
export async function startFileDrag(paths: readonly string[]): Promise<void>{
    if(!isTauri() || paths.length === 0){
        return;
    }
    try{
        const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
        // The preview image is required and must be a path on disk. The first
        // dragged photo is the only image we are certain exists there — the
        // thumbnails live in the cache dir, which the frontend only ever sees
        // through the sidecar's HTTP URLs.
        await startDrag({ item: [...paths], icon: paths[0]! });
    }catch{
        // Nothing to recover: the pointer is already gone.
    }
}

/** Native directory picker. Null when cancelled, or outside the desktop app. */
export async function pickFolder(): Promise<string | null>{
    if(!isTauri()){
        return null;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({
        directory: true,
        multiple: false,
        title: "Choose a folder to watch",
    });
    return typeof chosen === "string" ? chosen : null;
}
