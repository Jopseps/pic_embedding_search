import { useCallback, useEffect } from "react";
import { useStore } from "./lib/store";
import { FONTS, fontById, MONO_FALLBACK, modelById } from "./lib/catalog";
import { useGridLayout } from "./lib/useGridLayout";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { LibraryView } from "./components/LibraryView";
import { SettingsView } from "./components/SettingsView";
import { Lightbox } from "./components/Lightbox";

export default function App(){
    const grid = useGridLayout();
    const view = useStore((s) => s.view);
    const resolvedTheme = useStore((s) => s.resolvedTheme);
    const themePref = useStore((s) => s.settings.theme);
    const fontId = useStore((s) => s.settings.fontId);
    const uiScale = useStore((s) => s.settings.uiScale);
    const highContrast = useStore((s) => s.settings.highContrast);
    const reduceMotion = useStore((s) => s.settings.reduceMotion);
    const accentHue = useStore((s) => s.settings.accentHue);
    const tintHue = useStore((s) => s.settings.tintHue);
    const tintStrength = useStore((s) => s.settings.tintStrength);
    const selectionBorder = useStore((s) => s.settings.selectionBorder);
    const cellRadius = useStore((s) => s.settings.cellRadius);
    const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
    const reindex = useStore((s) => s.reindex);
    const activeModelName = useStore((s) => modelById(s.settings.modelId)?.name ?? s.settings.modelId);
    const isDragging = useStore((s) => s.isDraggingFile);
    const toast = useStore((s) => s.toast);
    const dragOut = useStore((s) => s.dragOut);
    const backendError = useStore((s) => s.backendError);

    const resolveTheme = useStore((s) => s.resolveTheme);
    const loadFolders = useStore((s) => s.loadFolders);
    const loadCollections = useStore((s) => s.loadCollections);
    const loadSavedSearches = useStore((s) => s.loadSavedSearches);
    const loadSettings = useStore((s) => s.loadSettings);
    const loadCounts = useStore((s) => s.loadCounts);
    const loadStorage = useStore((s) => s.loadStorage);
    const runSearch = useStore((s) => s.runSearch);
    const startEventStream = useStore((s) => s.startEventStream);
    const toggleSidebar = useStore((s) => s.toggleSidebar);
    const setDragging = useStore((s) => s.setDragging);
    const showToast = useStore((s) => s.showToast);

    // ---- boot -------------------------------------------------------------
    useEffect(() => {
        void loadFolders();
        void loadCollections();
        void loadSavedSearches();
        void loadSettings();
        void loadCounts();
        void loadStorage();
        void runSearch();
    }, [loadFolders, loadCollections, loadSavedSearches, loadSettings, loadCounts,
        loadStorage, runSearch]);

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", resolvedTheme);
    }, [resolvedTheme]);

    // Appearance and accessibility ride on the root element: two custom
    // properties every size and the font stack are written against, and two
    // attributes the token blocks in tokens.css key off. Nothing here scales
    // the document — `zoom` and `transform` would take the grid's own hit
    // testing with them, which reads content coordinates from the layout.
    useEffect(() => {
        const root = document.documentElement;
        const font = fontById(fontId) ?? FONTS[0]!;
        root.style.setProperty("--font-ui", font.stack);
        // Paths and filenames stay monospace whatever the UI font is, but they
        // follow it when it is itself monospace — two different monos on one
        // screen is what the old fixed `--font-mono` produced.
        root.style.setProperty("--font-code", font.mono ? font.stack : MONO_FALLBACK);
        root.style.setProperty("--ui-scale", String(uiScale / 100));
        root.setAttribute("data-contrast", highContrast ? "high" : "normal");
        // "system", not "full": the toggle off means follow the OS preference,
        // which the media query in tokens.css keys on.
        root.setAttribute("data-motion", reduceMotion ? "reduced" : "system");
    }, [fontId, uiScale, highContrast, reduceMotion]);

    // Colour and the grid's own shape, same idea: a handful of custom
    // properties the token blocks and the cells are written against. Every
    // theme, including both high-contrast ones, reads --accent-hue, so this is
    // one write rather than a palette per theme.
    useEffect(() => {
        const root = document.documentElement;
        root.style.setProperty("--accent-hue", String(accentHue));
        root.style.setProperty("--tint-hue", String(tintHue));
        root.style.setProperty("--tint-c", String(tintStrength / 100));
        root.style.setProperty("--sel-border", `${selectionBorder}px`);
        root.style.setProperty("--cell-radius", `${cellRadius}px`);
    }, [accentHue, tintHue, tintStrength, selectionBorder, cellRadius]);

    useEffect(() => {
        resolveTheme();
        if(themePref !== "system" || typeof window.matchMedia !== "function"){
            return;
        }
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => resolveTheme();
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, [themePref, resolveTheme]);

    // Indexing progress: the sidecar's /events stream, or a simulated ticker in
    // mock mode. The store decides which; both hand back an unsubscribe.
    useEffect(() => startEventStream(), [startEventStream]);

    // ---- keyboard ---------------------------------------------------------
    const moveFocus = useCallback(
        (key: string) => {
            const { rowMap } = grid.layout;
            const { focusedIndex, setFocusedIndex } = useStore.getState();
            if(rowMap.length === 0){
                return;
            }
            if(focusedIndex < 0){
                setFocusedIndex(0);
                grid.scrollToIndex(0);
                return;
            }
            const cur = rowMap[focusedIndex];
            if(cur === undefined){
                return;
            }
            let next = focusedIndex;
            if(key === "ArrowLeft"){
                next = Math.max(0, focusedIndex - 1);
            }else if(key === "ArrowRight"){
                next = Math.min(rowMap.length - 1, focusedIndex + 1);
            }else{
                // Vertical movement keeps the nearest column in the target row —
                // rows have different cell counts, so index arithmetic drifts.
                const targetRow = cur.row + (key === "ArrowDown" ? 1 : -1);
                let best = -1;
                let bestDist = Infinity;
                rowMap.forEach((m, i) => {
                    if(m.row !== targetRow){
                        return;
                    }
                    const d = Math.abs(m.col - cur.col);
                    if(d < bestDist){
                        bestDist = d;
                        best = i;
                    }
                });
                if(best >= 0){
                    next = best;
                }
            }
            setFocusedIndex(next);
            grid.scrollToIndex(next);
        },
        [grid],
    );

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent){
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName ?? "";
            const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
            const s = useStore.getState();

            if(e.key === "/" && !inInput){
                e.preventDefault();
                window.dispatchEvent(new Event("picsearch:focus-search"));
                return;
            }

            if(e.key === "Escape"){
                if(s.view === "settings" && s.lightboxIndex === null){
                    // Settings has nothing to clear; a stale query or selection
                    // underneath must not make Esc a no-op here.
                    s.setView("library");
                }else if(s.lightboxFullscreen){
                    // Leave fullscreen first — closing outright loses the photo
                    // the user was looking at, which is not what Esc means here.
                    s.toggleLightboxFullscreen();
                }else if(s.lightboxIndex !== null){
                    s.closeLightbox();
                }else if(s.similarTo !== null){
                    // Back to the search "find similar" replaced, not to All.
                    s.exitSimilar();
                }else if(s.query !== ""){
                    s.clearQuery();
                }else if(s.selectedIds.size > 0){
                    s.clearSelection();
                }
                return;
            }

            if(s.lightboxIndex !== null){
                if(e.key === "ArrowLeft"){
                    s.stepLightbox(-1, grid.layout.flat.length);
                }else if(e.key === "ArrowRight"){
                    s.stepLightbox(1, grid.layout.flat.length);
                }else if((e.key === "f" || e.key === "F") && !inInput){
                    e.preventDefault();
                    s.toggleLightboxFullscreen();
                }
                return;
            }

            if(inInput || s.view !== "library"){
                return;
            }

            if(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)){
                e.preventDefault();
                moveFocus(e.key);
                return;
            }
            if(e.key === " "){
                e.preventDefault();
                const photo = grid.layout.flat[s.focusedIndex];
                if(photo !== undefined){
                    s.toggleSelect(photo.id);
                }
                return;
            }
            if(e.key === "Enter" && s.focusedIndex >= 0){
                s.openLightbox(s.focusedIndex);
            }
        }

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [grid, moveFocus]);

    // ---- zoom -------------------------------------------------------------
    // Ctrl+wheel and trackpad pinch (which arrives as a wheel event with
    // `ctrlKey` set) are the webview's page-zoom gesture: left alone they scale
    // the whole app — sidebar, top bar, text and all. Zoom here means the
    // photos, so the default is blocked and the gesture is re-pointed at the
    // grid density, or at the lightbox's own image zoom when one is open.
    useEffect(() => {
        let acc = 0;

        function onWheel(e: WheelEvent){
            if(!e.ctrlKey && !e.metaKey){
                return;
            }
            // `preventDefault` only. `stopPropagation` would also kill the
            // lightbox stage listener, which sits downstream on the bubble path
            // — this one runs in the capture phase, ahead of it.
            e.preventDefault();
            const s = useStore.getState();
            if(s.lightboxIndex !== null || s.view !== "library"){
                return;
            }
            // `deltaY` is not in pixels everywhere. WebKitGTK — which is the
            // webview Tauri uses on Linux — reports deltaMode 1 (lines) with a
            // deltaY of 1–3 per notch, where Chrome reports ~100 pixels.
            // Accumulating the raw value there needs a dozen notches per step
            // and reads as "ctrl+wheel does nothing".
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
            acc += e.deltaY * unit;
            // One physical gesture must mean one density step: a notch lands
            // near 100 once normalised, a pinch arrives in single digits.
            if(Math.abs(acc) < 45){
                return;
            }
            s.stepDensity(acc < 0 ? 1 : -1);
            acc = 0;
        }

        function onZoomKey(e: KeyboardEvent){
            if(!e.ctrlKey && !e.metaKey){
                return;
            }
            if(!["+", "=", "-", "_", "0"].includes(e.key)){
                return;
            }
            const tag = (e.target as HTMLElement | null)?.tagName ?? "";
            if(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"){
                return;
            }
            e.preventDefault();
            const s = useStore.getState();
            if(s.lightboxIndex !== null || s.view !== "library"){
                return;
            }
            if(e.key === "0"){
                s.setDensity(1);
            }else if(e.key === "-" || e.key === "_"){
                s.stepDensity(-1);
            }else{
                s.stepDensity(1);
            }
        }

        window.addEventListener("wheel", onWheel, { passive: false, capture: true });
        window.addEventListener("keydown", onZoomKey, { capture: true });
        return () => {
            window.removeEventListener("wheel", onWheel, { capture: true });
            window.removeEventListener("keydown", onZoomKey, { capture: true });
        };
    }, []);

    // ---- drag & drop ------------------------------------------------------
    // A depth counter is required: dragenter/dragleave fire per descendant, so a
    // naive boolean flickers as the pointer crosses child elements.
    const dragDepth = useCallback(() => {
        const w = window as unknown as { __dragDepth?: number };
        return w;
    }, []);

    function onDragEnter(e: React.DragEvent){
        e.preventDefault();
        const w = dragDepth();
        w.__dragDepth = (w.__dragDepth ?? 0) + 1;
        setDragging(true);
    }

    function onDragLeave(e: React.DragEvent){
        e.preventDefault();
        const w = dragDepth();
        w.__dragDepth = (w.__dragDepth ?? 1) - 1;
        if((w.__dragDepth ?? 0) <= 0){
            w.__dragDepth = 0;
            setDragging(false);
        }
    }

    function onDrop(e: React.DragEvent){
        e.preventDefault();
        const w = dragDepth();
        w.__dragDepth = 0;
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if(file === undefined){
            return;
        }
        showToast(`Searching for images similar to ${file.name}…`);
    }

    return (
        <div
            className="relative flex h-screen w-full flex-col overflow-hidden bg-canvas text-fg"
            onDragEnter={onDragEnter}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <TopBar />

            {backendError !== null ? (
                <div className="flex flex-shrink-0 items-center gap-3 border-b border-edge bg-danger-muted px-4 py-2">
                    <span className="text-[calc(12.5px*var(--ui-scale))] text-fg">
                        Cannot reach the indexing service — {backendError}
                    </span>
                    <button
                        type="button"
                        onClick={() => {
                            void loadFolders();
                            void runSearch();
                        }}
                        className="cursor-pointer rounded-md border border-edge bg-raised px-3 py-1 text-[calc(12px*var(--ui-scale))] text-fg hover:bg-hover"
                    >
                        Retry
                    </button>
                </div>
            ) : null}

            {/* Informational, not a warning: the outgoing model keeps every
                vector it had, so search answers normally for the whole swap. */}
            {reindex.active ? (
                <div className="flex flex-shrink-0 items-center gap-3 border-b border-edge bg-raised px-4 py-2">
                    <span className="text-[calc(12.5px*var(--ui-scale))] text-fg-dim">
                        Re-indexing with {reindex.modelName} — {Math.round(reindex.progress)}%
                        {reindex.total > 0
                            ? ` (${reindex.current} / ${reindex.total})`
                            : ""}
                        . Still searching with {activeModelName}.
                    </span>
                    <div className="h-1 max-w-[calc(220px*var(--ui-scale))] flex-1 overflow-hidden rounded-sm bg-hover">
                        <div
                            className="h-full bg-accent transition-[width]"
                            style={{ width: `${reindex.progress}%` }}
                        />
                    </div>
                </div>
            ) : null}

            <div className="relative flex min-h-0 flex-1">
                <Sidebar />

                {sidebarCollapsed ? (
                    <button
                        type="button"
                        onClick={toggleSidebar}
                        aria-label="Expand sidebar"
                        className="absolute top-2 left-1 z-[5] flex h-[calc(22px*var(--ui-scale))] w-[calc(22px*var(--ui-scale))] cursor-pointer items-center justify-center rounded-[calc(5px*var(--ui-scale))] border border-edge bg-raised text-[calc(10px*var(--ui-scale))] text-fg-faint hover:text-fg"
                    >
                        ▶
                    </button>
                ) : null}

                {view === "library" ? <LibraryView grid={grid} /> : <SettingsView />}
            </div>

            <Lightbox flat={grid.layout.flat} />

            {isDragging ? (
                <div className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center border-[calc(3px*var(--ui-scale))] border-dashed border-accent bg-accent-muted/90">
                    <div className="text-center">
                        <div className="mb-[calc(6px*var(--ui-scale))] text-[calc(17px*var(--ui-scale))] font-semibold text-fg">
                            Drop to find similar photos
                        </div>
                        <div className="text-[calc(12.5px*var(--ui-scale))] text-fg-dim">
                            We'll search your library by visual similarity
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Carried-photo hint. Positioned rather than pinned to the cursor:
                a element that follows the pointer needs a state write per move,
                which is the one thing a drag cannot afford. */}
            {dragOut.active ? (
                <div className="pointer-events-none absolute bottom-6 left-1/2 z-[250] -translate-x-1/2 rounded-xl border border-accent bg-raised px-4 py-[calc(10px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg shadow-[var(--shadow-bar)]">
                    Carrying {dragOut.count} photo{dragOut.count === 1 ? "" : "s"} —
                    drop on a collection, or outside the window to export
                </div>
            ) : null}

            {toast !== null ? (
                <div className="absolute right-6 bottom-6 z-[300] rounded-lg border border-edge bg-raised px-4 py-[calc(10px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg shadow-[var(--shadow-pop)]">
                    {toast}
                </div>
            ) : null}
        </div>
    );
}
