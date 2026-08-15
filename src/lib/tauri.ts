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

/**
 * Asks the Rust shell for the sidecar's `{port, token}`. Returns null outside
 * the desktop app; throws only if the shell answered with an error, which means
 * the sidecar failed to start and the caller should fall back to mock data.
 */
export async function sidecarHandshake(): Promise<SidecarHandshake | null>{
    if(!isTauri()){
        return null;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<SidecarHandshake>("sidecar_handshake");
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
