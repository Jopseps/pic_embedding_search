import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import { isTauri } from "./lib/tauri";
import type { SidecarHandshake } from "./lib/api";

const root = document.getElementById("root");
if(root === null){
    throw new Error("#root not found");
}
const reactRoot = ReactDOM.createRoot(root);

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
    const onReady = (handshake: SidecarHandshake) => {
        if(mounted){
            return;
        }
        mounted = true;
        void mountApp(handshake);
    };
    reactRoot.render(
        <React.StrictMode>
            <Boot onReady={onReady} />
        </React.StrictMode>,
    );
}

void boot();
