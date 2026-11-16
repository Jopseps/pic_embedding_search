import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import { backendStatus, isTauri } from "./lib/tauri";
import type { SidecarHandshake } from "./lib/api";

const WATCH_MS = 2000;

const root = document.getElementById("root");
if(root === null){
    throw new Error("#root not found");
}
const reactRoot = ReactDOM.createRoot(root);

/**
 * The webview's own page zoom must never fire — on the boot screen either,
 * which is on screen before `App` (and its density handlers) exists. Zoom means
 * the photos; scaling the whole window is the Interface size setting. App
 * re-points these same chords at the grid. Plain DOM, no store: Boot is not
 * allowed to import it.
 */
function blockPageZoom(){
    const swallow = (e: Event) => e.preventDefault();
    window.addEventListener("wheel", (e) => {
        if(e.ctrlKey || e.metaKey){
            swallow(e);
        }
    }, { passive: false, capture: true });
    window.addEventListener("keydown", (e) => {
        if((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)){
            swallow(e);
        }
    }, { capture: true });
}
blockPageZoom();

/**
 * The handshake has to land on `window` *before* anything imports `api.ts`:
 * that module picks its adapter once, at import time, from
 * `window.__PICSEARCH__`. Hence the dynamic import of `App` below — a static
 * one would resolve the api module first and pin the app to mock data.
 */
async function mountApp(handshake: SidecarHandshake | null){
    if(handshake !== null){
        (window as unknown as { __PICSEARCH__?: unknown }).__PICSEARCH__ = handshake;
    }
    const { default: App } = await import("./App");
    reactRoot.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
}

/**
 * The desktop shell boots the sidecar in the background — a packaged first
 * run installs Python and torch before it can — so it shows `Boot` until the
 * handshake arrives. The browser dev server has no shell and no sidecar, and
 * runs straight on the fixture library.
 */
async function boot(){
    if(!isTauri()){
        await mountApp(null);
        return;
    }
    const { Boot } = await import("./Boot");
    let mounted = false;
    const showBoot = () => {
        reactRoot.render(
            <React.StrictMode>
                <Boot onReady={onReady} />
            </React.StrictMode>,
        );
    };
    /**
     * After the app is up, a slow poll notices the sidecar dying (the shell
     * moves the phase off `ready`) and brings the boot screen back with Retry.
     */
    const watchBackend = () => {
        const timer = window.setInterval(() => {
            backendStatus().then((status) => {
                if(status.phase !== "ready"){
                    window.clearInterval(timer);
                    showBoot();
                }
            }).catch(() => {});
        }, WATCH_MS);
    };
    const onReady = (handshake: SidecarHandshake) => {
        if(mounted){
            // A restart after a death: api.ts read the old port and token when
            // it was imported, so only a reload picks up the new ones.
            window.location.reload();
            return;
        }
        mounted = true;
        void mountApp(handshake).then(watchBackend);
    };
    showBoot();
}

void boot();
