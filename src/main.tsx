import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import { sidecarHandshake } from "./lib/tauri";

const root = document.getElementById("root");
if(root === null){
    throw new Error("#root not found");
}

/**
 * The handshake has to land on `window` *before* anything imports `api.ts`:
 * that module picks its adapter once, at import time, from
 * `window.__PICSEARCH__`. Hence the dynamic import of `App` below — a static
 * one would resolve the api module first and pin the app to mock data.
 */
async function boot(){
    try{
        const handshake = await sidecarHandshake();
        if(handshake !== null){
            (window as unknown as { __PICSEARCH__?: unknown }).__PICSEARCH__ = handshake;
        }
    }catch(err){
        // Not fatal: resolveApi() falls back to the fixture library, and the
        // app is still usable while the sidecar is fixed.
        console.error("sidecar unavailable, running on mock data:", err);
    }

    const { default: App } = await import("./App");
    ReactDOM.createRoot(root as HTMLElement).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
}

void boot();
