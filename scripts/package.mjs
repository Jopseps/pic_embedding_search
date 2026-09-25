#!/usr/bin/env node
/**
 * `npm run package` — the release build, on this machine.
 *
 * Fetches the pinned uv, then runs `tauri build` with the bundle overlay
 * (`tauri.bundle.conf.json`: the uv sidecar binary and the Python source as
 * resources). Extra arguments go straight to `tauri build`:
 *
 *   npm run package -- --bundles deb
 *
 * On Arch it builds the .deb only, which the PKGBUILD repackages. An AppImage
 * built there fails inside linuxdeploy — Arch's gdk-pixbuf no longer has the
 * loader directory its gtk plugin copies — and would link against a glibc
 * newer than most distros ship even if it did not. CI builds the AppImage on
 * Ubuntu 22.04 instead.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extra = process.argv.slice(2);

function run(cmd, args){
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

run(process.execPath, [join(root, "scripts", "fetch-uv.mjs")]);

const args = ["tauri", "build", "--config", join("src-tauri", "tauri.bundle.conf.json")];
if(!extra.includes("--bundles") && process.platform === "linux" && existsSync("/etc/arch-release")){
    console.log("Arch detected: building the .deb only (AppImages come from CI, see scripts/package.mjs)");
    args.push("--bundles", "deb");
}
run("npx", [...args, ...extra]);
