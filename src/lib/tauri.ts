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
    // Armed before the await: the pointer is already outside, and the drag can
    // come straight back in while the plugin is still starting.
    outboundUntil = Date.now() + OUTBOUND_MAX_MS;
    try{
        const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
        // The preview image is required and must be a path on disk. The first
        // dragged photo is the only image we are certain exists there — the
        // thumbnails live in the cache dir, which the frontend only ever sees
        // through the sidecar's HTTP URLs.
        await startDrag({ item: [...paths], icon: paths[0]! }, () => {
            outboundUntil = Date.now() + OUTBOUND_GRACE_MS;
        });
    }catch{
        // Nothing to recover: the pointer is already gone.
        outboundUntil = Date.now() + OUTBOUND_GRACE_MS;
    }
}

/** Until when an OS drag that this app started may still be in flight. */
let outboundUntil = 0;
// The plugin reports the end of a drag through its callback, but it may never
// do so (a compositor that refuses the drag), so the flag also expires on its own.
const OUTBOUND_MAX_MS = 60_000;
// A drop on our own window can be delivered just after the callback.
const OUTBOUND_GRACE_MS = 800;

/** True while a drag the app itself started (a photo carried out of the grid) is
 *  in progress or has only just ended. */
export function ownDragInFlight(): boolean{
    return Date.now() < outboundUntil;
}

export interface FileDropHandlers{
    enter(): void;
    leave(): void;
    drop(paths: string[]): void;
}

/**
 * Files dragged in from another app, with their real paths.
 *
 * With `dragDropEnabled` the webview hands the drop to Tauri, so HTML5 drop
 * events never fire in the desktop shell and this is the only way to get a path.
 * A photo dragged out of the grid and back over the window arrives here too —
 * it is the app's own drag, so it is dropped on the floor and the overlay is
 * cleared instead. `over` fires per pointer move and is ignored.
 *
 * Outside the desktop shell there is nothing to listen to and the returned
 * function does nothing.
 */
export async function listenFileDrop(h: FileDropHandlers): Promise<() => void>{
    if(!isTauri()){
        return () => {};
    }
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if(p.type === "over"){
            return;
        }
        if(ownDragInFlight()){
            h.leave();
        }else if(p.type === "enter"){
            h.enter();
        }else if(p.type === "drop"){
            h.drop(p.paths);
        }else{
            h.leave();
        }
    });
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
