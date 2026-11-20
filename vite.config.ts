/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json";

// Tauri expects a fixed port and does not tolerate the fallback shuffle.
export default defineConfig({
    plugins: [react(), tailwindcss()],
    // The About section's version line; package.json is bumped with the sidecar's.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        watch: { ignored: ["**/src-tauri/**", "**/sidecar/**"] },
    },
    build: {
        target: "esnext",
        sourcemap: true,
    },
    test: {
        setupFiles: ["./src/test-setup.ts"],
    },
});
