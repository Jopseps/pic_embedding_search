import { useCallback, useEffect } from "react";
import { useStore } from "./lib/store";
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
    const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
    const reindex = useStore((s) => s.reindex);
    const isDragging = useStore((s) => s.isDraggingFile);
    const toast = useStore((s) => s.toast);
    const backendError = useStore((s) => s.backendError);

    const resolveTheme = useStore((s) => s.resolveTheme);
    const loadFolders = useStore((s) => s.loadFolders);
    const loadCollections = useStore((s) => s.loadCollections);
    const loadSavedSearches = useStore((s) => s.loadSavedSearches);
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
        void loadStorage();
        void runSearch();
    }, [loadFolders, loadCollections, loadSavedSearches, loadStorage, runSearch]);

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", resolvedTheme);
    }, [resolvedTheme]);

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
                if(s.lightboxIndex !== null){
                    s.closeLightbox();
                }else if(s.query !== ""){
                    s.clearQuery();
                }else if(s.selectedIds.size > 0){
                    s.clearSelection();
                }else if(s.view === "settings"){
                    s.setView("library");
                }
                return;
            }

            if(s.lightboxIndex !== null){
                if(e.key === "ArrowLeft"){
                    s.stepLightbox(-1, grid.layout.flat.length);
                }else if(e.key === "ArrowRight"){
                    s.stepLightbox(1, grid.layout.flat.length);
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
                    <span className="text-[12.5px] text-fg">
                        Cannot reach the indexing service — {backendError}
                    </span>
                    <button
                        type="button"
                        onClick={() => {
                            void loadFolders();
                            void runSearch();
                        }}
                        className="cursor-pointer rounded-md border border-edge bg-raised px-3 py-1 text-[12px] text-fg hover:bg-hover"
                    >
                        Retry
                    </button>
                </div>
            ) : null}

            {reindex.active ? (
                <div className="flex flex-shrink-0 items-center gap-3 border-b border-edge bg-danger-muted px-4 py-2">
                    <span className="text-[12.5px] text-fg">
                        Search unavailable while re-indexing — {Math.round(reindex.progress)}% complete
                    </span>
                    <div className="h-1 max-w-[220px] flex-1 overflow-hidden rounded-sm bg-hover">
                        <div
                            className="h-full bg-danger transition-[width]"
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
                        className="absolute top-2 left-1 z-[5] flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[5px] border border-edge bg-raised text-[10px] text-fg-faint hover:text-fg"
                    >
                        ▶
                    </button>
                ) : null}

                {view === "library" ? <LibraryView grid={grid} /> : <SettingsView />}
            </div>

            <Lightbox flat={grid.layout.flat} />

            {isDragging ? (
                <div className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center border-[3px] border-dashed border-accent bg-accent-muted/90">
                    <div className="text-center">
                        <div className="mb-[6px] text-[17px] font-semibold text-fg">
                            Drop to find similar photos
                        </div>
                        <div className="text-[12.5px] text-fg-dim">
                            We'll search your library by visual similarity
                        </div>
                    </div>
                </div>
            ) : null}

            {toast !== null ? (
                <div className="absolute right-6 bottom-6 z-[300] rounded-lg border border-edge bg-raised px-4 py-[10px] text-[12.5px] text-fg shadow-[var(--shadow-pop)]">
                    {toast}
                </div>
            ) : null}
        </div>
    );
}
