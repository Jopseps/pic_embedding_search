#!/usr/bin/env node
/**
 * Puts a pinned `uv` binary where Tauri's `externalBin` expects it:
 * `src-tauri/binaries/picsearch-uv-<target triple>[.exe]`.
 *
 * The packaged app runs this uv on first launch to build its Python
 * environment, so the user never installs uv themselves. It is renamed to
 * `picsearch-uv` because Tauri drops sidecars next to the main executable —
 * `/usr/bin` for a .deb — and a bare `uv` would collide with the distro's own.
 *
 * Linux gets the musl build: it is static, so one binary runs on every glibc
 * an AppImage might land on.
 *
 *   node scripts/fetch-uv.mjs                 # for this machine
 *   node scripts/fetch-uv.mjs <rust triple>   # for a cross target
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UV_VERSION = "0.11.19";

// Rust target triple (what Tauri names the file after) -> uv release asset.
const ASSETS = {
    "x86_64-unknown-linux-gnu": "uv-x86_64-unknown-linux-musl.tar.gz",
    "aarch64-unknown-linux-gnu": "uv-aarch64-unknown-linux-musl.tar.gz",
    "x86_64-pc-windows-msvc": "uv-x86_64-pc-windows-msvc.zip",
    "aarch64-pc-windows-msvc": "uv-aarch64-pc-windows-msvc.zip",
    "x86_64-apple-darwin": "uv-x86_64-apple-darwin.tar.gz",
    "aarch64-apple-darwin": "uv-aarch64-apple-darwin.tar.gz",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function hostTriple(){
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.startsWith("host:"));
    if(line === undefined){
        throw new Error("rustc -vV printed no host triple");
    }
    return line.slice("host:".length).trim();
}

function findFile(dir, name){
    for(const entry of readdirSync(dir)){
        const path = join(dir, entry);
        if(statSync(path).isDirectory()){
            const hit = findFile(path, name);
            if(hit !== null){
                return hit;
            }
        }else if(entry === name){
            return path;
        }
    }
    return null;
}

async function main(){
    const triple = process.argv[2] ?? hostTriple();
    const asset = ASSETS[triple];
    if(asset === undefined){
        throw new Error(`no uv build mapped for ${triple}; add it to ASSETS`);
    }
    const windows = triple.includes("windows");
    const exe = windows ? ".exe" : "";
    const outDir = join(root, "src-tauri", "binaries");
    const out = join(outDir, `picsearch-uv-${triple}${exe}`);
    const stamp = `${out}.version`;

    if(existsSync(out) && existsSync(stamp) && readStamp(stamp) === UV_VERSION){
        console.log(`uv ${UV_VERSION} already at ${out}`);
        return;
    }

    const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
    console.log(`fetching ${url}`);
    const res = await fetch(url);
    if(!res.ok){
        throw new Error(`${url}: HTTP ${res.status}`);
    }
    const work = mkdtempSync(join(tmpdir(), "picsearch-uv-"));
    try{
        const archive = join(work, asset);
        writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
        // bsdtar ships with Windows 10+ and reads zip as well as tar.gz. Named
        // by full path there: on CI runners Git's GNU tar comes first on PATH,
        // cannot read zip, and takes `C:\…` for a remote host.
        const tar = process.platform === "win32"
            ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
            : "tar";
        execFileSync(tar, ["-xf", archive, "-C", work], { stdio: "inherit" });
        const binary = findFile(work, `uv${exe}`);
        if(binary === null){
            throw new Error(`uv${exe} not found inside ${asset}`);
        }
        mkdirSync(outDir, { recursive: true });
        copyFileSync(binary, out);
        chmodSync(out, 0o755);
        writeFileSync(stamp, UV_VERSION);
        console.log(`uv ${UV_VERSION} -> ${out}`);
    }finally{
        rmSync(work, { recursive: true, force: true });
    }
}

function readStamp(path){
    try{
        return readFileSync(path, "utf8").trim();
    }catch{
        return "";
    }
}

main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
});
