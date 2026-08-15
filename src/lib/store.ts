import { create } from "zustand";
import { api, isMockMode } from "./api";
import {
    DEFAULT_MODEL_ID,
    DEFAULT_OCR_ENGINE_ID,
    DEFAULT_OCR_LANGS,
    modelById,
} from "./catalog";
import type {
    Collection,
    DatePreset,
    Density,
    DimsFilter,
    Filters,
    GridMode,
    IndexingStatus,
    LibraryView,
    Photo,
    PhotoKind,
    ReindexStatus,
    ResolvedTheme,
    SavedSearch,
    Settings,
    StorageUsage,
    ThemePref,
    WatchedFolder,
} from "./types";

const SEARCH_DEBOUNCE_MS = 220;
const MOCK_INDEX_TICK_MS = 1400;

export type MainView = "library" | "settings";

export interface FilterSectionsOpen{
    date: boolean;
    folder: boolean;
    type: boolean;
    dims: boolean;
}

interface State{
    view: MainView;

    query: string;
    searching: boolean;
    results: Photo[];
    total: number;
    tookMs: number;
    /** Set when results came from "find similar" rather than a text query. */
    similarTo: Photo | null;

    libraryView: LibraryView | null;
    activeCollection: string | null;
    collections: Collection[];
    savedSearches: SavedSearch[];
    addingCollection: boolean;
    newCollectionName: string;

    filters: Filters;
    filtersOpen: FilterSectionsOpen;

    sidebarCollapsed: boolean;
    density: Density;
    selectedIds: Set<number>;
    focusedIndex: number;
    hoveredId: number | null;

    lightboxIndex: number | null;
    lightboxStripVisible: boolean;
    ocrExpanded: boolean;

    indexing: IndexingStatus;
    indexingPanelOpen: boolean;
    reindex: ReindexStatus;
    pendingModelId: string | null;

    settings: Settings;
    resolvedTheme: ResolvedTheme;
    folders: WatchedFolder[];
    /** False until the first folder load resolves. Without this the empty-library
     *  state flashes on every launch, before we know whether folders exist. */
    foldersLoaded: boolean;
    /** Set when a backend call fails at boot. Surfaced as a banner — otherwise
     *  a sidecar that is not up yet just shows skeletons forever. */
    backendError: string | null;
    storage: StorageUsage;
    clearCacheConfirm: boolean;

    isDraggingFile: boolean;
    toast: string | null;
}

interface Actions{
    setView(v: MainView): void;

    setQuery(q: string): void;
    clearQuery(): void;
    runSearch(): Promise<void>;
    findSimilar(photo: Photo): Promise<void>;

    setLibraryView(v: LibraryView): void;
    setActiveCollection(id: string): void;
    startAddCollection(): void;
    setNewCollectionName(n: string): void;
    commitCollection(): void;
    cancelAddCollection(): void;
    runSavedSearch(q: string): void;

    toggleFilterSection(key: keyof FilterSectionsOpen): void;
    setDatePreset(p: DatePreset): void;
    toggleFolderFilter(folder: string): void;
    toggleTypeFilter(t: PhotoKind): void;
    setDimsFilter(d: DimsFilter): void;
    clearAllFilters(): void;

    toggleSidebar(): void;
    setDensity(d: Density): void;
    setHovered(id: number | null): void;
    setFocusedIndex(i: number): void;
    toggleSelect(id: number): void;
    clearSelection(): void;

    openLightbox(i: number): void;
    closeLightbox(): void;
    stepLightbox(dir: 1 | -1, count: number): void;
    toggleLightboxStrip(): void;
    toggleOcrExpanded(): void;

    toggleIndexingPanel(): void;
    toggleIndexingPause(): void;
    startEventStream(): () => void;
    tickIndexing(): void;

    selectModel(id: string): void;
    cancelModelChange(): void;
    confirmModelChange(): void;
    setOcrEngine(id: string): void;
    toggleOcrLang(code: string): void;
    setTheme(t: ThemePref): void;
    resolveTheme(): void;

    loadFolders(): Promise<void>;
    addFolder(): Promise<void>;
    removeFolder(path: string): Promise<void>;
    toggleRecursive(path: string): Promise<void>;
    loadStorage(): Promise<void>;
    clearCache(): Promise<void>;
    cancelClearCache(): void;

    setDragging(v: boolean): void;
    showToast(msg: string): void;
    deleteSelected(): Promise<void>;
    revealSelected(): Promise<void>;
    addSelectionToCollection(): void;
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let reindexTimer: ReturnType<typeof setInterval> | undefined;
/** Guards against an older in-flight search overwriting a newer one. */
let searchSeq = 0;

const EMPTY_FILTERS: Filters = { datePreset: null, folders: [], types: [], dims: null };

function describeError(err: unknown): string{
    return err instanceof Error ? err.message : String(err);
}

export const useStore = create<State & Actions>((set, get) => ({
    view: "library",

    query: "",
    searching: false,
    results: [],
    total: 0,
    tookMs: 0,
    similarTo: null,

    libraryView: "all",
    activeCollection: null,
    collections: [
        { id: "refs", name: "Refs" },
        { id: "memes", name: "Memes" },
    ],
    savedSearches: [
        { id: "1", query: "dark code editor" },
        { id: "2", query: "receipts" },
        { id: "3", query: "masa" },
    ],
    addingCollection: false,
    newCollectionName: "",

    filters: EMPTY_FILTERS,
    filtersOpen: { date: false, folder: false, type: false, dims: false },

    sidebarCollapsed: false,
    density: 1,
    selectedIds: new Set(),
    focusedIndex: -1,
    hoveredId: null,

    lightboxIndex: null,
    lightboxStripVisible: true,
    ocrExpanded: false,

    // The fixture library ships a scan already in flight so the progress UI is
    // visible without a backend; a real sidecar reports the truth over /events.
    indexing: isMockMode
        ? {
            current: 412,
            total: 3241,
            rate: 18.4,
            etaSec: 154,
            paused: false,
            currentFile: "IMG_9931.heic",
        }
        : { current: 0, total: 0, rate: 0, etaSec: 0, paused: false, currentFile: "" },
    indexingPanelOpen: false,
    reindex: { active: false, progress: 0, modelName: "" },
    pendingModelId: null,

    settings: {
        modelId: DEFAULT_MODEL_ID,
        ocrEngineId: DEFAULT_OCR_ENGINE_ID,
        ocrLangs: [...DEFAULT_OCR_LANGS],
        theme: "dark",
        density: 1,
    },
    resolvedTheme: "dark",
    folders: [],
    foldersLoaded: false,
    backendError: null,
    storage: { thumbnailCacheGb: 0, indexGb: 0 },
    clearCacheConfirm: false,

    isDraggingFile: false,
    toast: null,

    // -----------------------------------------------------------------------

    setView(v){
        set({ view: v });
    },

    setQuery(q){
        set({ query: q, similarTo: null });
        clearTimeout(debounceTimer);
        if(q.trim() === ""){
            set({ searching: false });
            void get().runSearch();
            return;
        }
        set({ searching: true });
        debounceTimer = setTimeout(() => void get().runSearch(), SEARCH_DEBOUNCE_MS);
    },

    clearQuery(){
        clearTimeout(debounceTimer);
        set({ query: "", searching: false, similarTo: null });
        void get().runSearch();
    },

    async runSearch(){
        const s = get();
        // Search stays disabled while the library is being re-embedded — the
        // vectors in flight belong to two different models.
        if(s.reindex.active){
            set({ searching: false, results: [], total: 0 });
            return;
        }
        const seq = ++searchSeq;
        try{
            const res = await api.search({
                q: s.query,
                view: s.activeCollection === null ? s.libraryView : null,
                collection: s.activeCollection,
                filters: s.filters,
            });
            if(seq !== searchSeq){
                return;
            }
            set({
                results: res.items,
                total: res.total,
                tookMs: res.tookMs,
                searching: false,
                focusedIndex: -1,
                backendError: null,
            });
        }catch(err){
            if(seq !== searchSeq){
                return;
            }
            set({ searching: false, results: [], total: 0, backendError: describeError(err) });
        }
    },

    async findSimilar(photo){
        const seq = ++searchSeq;
        set({ searching: true, lightboxIndex: null, query: "", similarTo: photo });
        const res = await api.similar(photo.id);
        if(seq !== searchSeq){
            return;
        }
        set({
            results: res.items,
            total: res.total,
            tookMs: res.tookMs,
            searching: false,
            focusedIndex: -1,
        });
        get().showToast(`Showing images visually similar to ${photo.filename}`);
    },

    setLibraryView(v){
        set({ libraryView: v, activeCollection: null, selectedIds: new Set(), similarTo: null });
        void get().runSearch();
    },

    setActiveCollection(id){
        set({ activeCollection: id, libraryView: null, selectedIds: new Set(), similarTo: null });
        void get().runSearch();
    },

    startAddCollection(){
        set({ addingCollection: true, newCollectionName: "" });
    },

    setNewCollectionName(n){
        set({ newCollectionName: n });
    },

    commitCollection(){
        const name = get().newCollectionName.trim();
        if(name === ""){
            set({ addingCollection: false });
            return;
        }
        set((s) => ({
            collections: [...s.collections, { id: `c${Date.now()}`, name }],
            addingCollection: false,
            newCollectionName: "",
        }));
        get().showToast(`Collection "${name}" created`);
    },

    cancelAddCollection(){
        set({ addingCollection: false, newCollectionName: "" });
    },

    runSavedSearch(q){
        get().setQuery(q);
    },

    toggleFilterSection(key){
        set((s) => ({ filtersOpen: { ...s.filtersOpen, [key]: !s.filtersOpen[key] } }));
    },

    setDatePreset(p){
        set((s) => ({
            filters: { ...s.filters, datePreset: s.filters.datePreset === p ? null : p },
        }));
        void get().runSearch();
    },

    toggleFolderFilter(folder){
        set((s) => {
            const has = s.filters.folders.includes(folder);
            return {
                filters: {
                    ...s.filters,
                    folders: has
                        ? s.filters.folders.filter((f) => f !== folder)
                        : [...s.filters.folders, folder],
                },
            };
        });
        void get().runSearch();
    },

    toggleTypeFilter(t){
        set((s) => {
            const has = s.filters.types.includes(t);
            return {
                filters: {
                    ...s.filters,
                    types: has ? s.filters.types.filter((x) => x !== t) : [...s.filters.types, t],
                },
            };
        });
        void get().runSearch();
    },

    setDimsFilter(d){
        set((s) => ({ filters: { ...s.filters, dims: s.filters.dims === d ? null : d } }));
        void get().runSearch();
    },

    clearAllFilters(){
        set({ filters: { datePreset: null, folders: [], types: [], dims: null } });
        void get().runSearch();
    },

    toggleSidebar(){
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
    },

    setDensity(d){
        set({ density: d });
    },

    setHovered(id){
        set({ hoveredId: id });
    },

    setFocusedIndex(i){
        set({ focusedIndex: i });
    },

    toggleSelect(id){
        set((s) => {
            const next = new Set(s.selectedIds);
            if(next.has(id)){
                next.delete(id);
            }else{
                next.add(id);
            }
            return { selectedIds: next };
        });
    },

    clearSelection(){
        set({ selectedIds: new Set() });
    },

    openLightbox(i){
        set({ lightboxIndex: i, ocrExpanded: false });
    },

    closeLightbox(){
        set({ lightboxIndex: null });
    },

    stepLightbox(dir, count){
        set((s) => {
            if(s.lightboxIndex === null || count === 0){
                return {};
            }
            return {
                lightboxIndex: (s.lightboxIndex + dir + count) % count,
                ocrExpanded: false,
            };
        });
    },

    toggleLightboxStrip(){
        set((s) => ({ lightboxStripVisible: !s.lightboxStripVisible }));
    },

    toggleOcrExpanded(){
        set((s) => ({ ocrExpanded: !s.ocrExpanded }));
    },

    toggleIndexingPanel(){
        set((s) => ({ indexingPanelOpen: !s.indexingPanelOpen }));
    },

    toggleIndexingPause(){
        set((s) => ({ indexing: { ...s.indexing, paused: !s.indexing.paused } }));
    },

    /**
     * Live indexing progress. With a sidecar this is its `/events` SSE stream;
     * in mock mode it is the simulated ticker below, so the progress UI stays
     * exercisable without Python. Returns an unsubscribe function.
     */
    startEventStream(){
        if(isMockMode){
            const id = setInterval(() => get().tickIndexing(), MOCK_INDEX_TICK_MS);
            return () => clearInterval(id);
        }
        return api.subscribeEvents((event) => {
            if(event.type === "index"){
                set({
                    indexing: {
                        current: event.current,
                        total: event.total,
                        rate: event.rate,
                        etaSec: event.etaSec,
                        paused: event.paused,
                        currentFile: event.currentFile,
                    },
                });
            }else if(event.type === "reindex"){
                set({
                    reindex: {
                        active: event.active,
                        progress: event.progress,
                        modelName: event.modelName,
                    },
                });
            }else if(event.type === "scan-complete"){
                // New rows exist now, so the visible results are stale.
                if(event.ingested > 0 || event.removed > 0){
                    void get().loadFolders();
                    void get().loadStorage();
                    void get().runSearch();
                }
            }else if(event.type === "error"){
                set({ backendError: event.message });
            }
        });
    },

    /** Mock-mode only — see startEventStream. */
    tickIndexing(){
        set((s) => {
            if(s.indexing.paused || s.reindex.active || s.indexing.current >= s.indexing.total){
                return {};
            }
            const inc = 3 + Math.floor(Math.abs(Math.sin(s.indexing.current)) * 9);
            const current = Math.min(s.indexing.total, s.indexing.current + inc);
            const rate = 9 + Math.abs(Math.sin(current * 0.13)) * 14;
            const files = [
                "IMG_9931.heic",
                "Screenshot 2026-03-14.png",
                "IMG_2044.jpg",
                "Screenshot 2026-03-13.png",
                "IMG_7710.jpg",
            ];
            return {
                indexing: {
                    ...s.indexing,
                    current,
                    rate: Math.round(rate * 10) / 10,
                    etaSec: Math.round((s.indexing.total - current) / rate),
                    currentFile: files[current % files.length] as string,
                },
            };
        });
    },

    selectModel(id){
        if(id === get().settings.modelId){
            set({ pendingModelId: null });
            return;
        }
        set({ pendingModelId: id });
    },

    cancelModelChange(){
        set({ pendingModelId: null });
    },

    /**
     * Switching models invalidates every stored vector — different space,
     * different dims. Search is disabled until coverage is back to 100%.
     * Old rows are never deleted, so switching back is instant.
     */
    confirmModelChange(){
        const pending = get().pendingModelId;
        if(pending === null){
            return;
        }
        const model = modelById(pending);
        set({
            reindex: { active: true, progress: 0, modelName: model?.name ?? pending },
            results: [],
            total: 0,
        });
        clearInterval(reindexTimer);
        reindexTimer = setInterval(() => {
            const cur = get().reindex;
            const next = Math.min(100, cur.progress + 4 + Math.random() * 3);
            if(next >= 100){
                clearInterval(reindexTimer);
                set((s) => ({
                    reindex: { active: false, progress: 0, modelName: "" },
                    settings: { ...s.settings, modelId: pending },
                    pendingModelId: null,
                }));
                get().showToast("Re-indexing complete");
                void get().runSearch();
                return;
            }
            set({ reindex: { ...cur, progress: next } });
        }, 220);
    },

    setOcrEngine(id){
        set((s) => ({ settings: { ...s.settings, ocrEngineId: id } }));
    },

    toggleOcrLang(code){
        set((s) => {
            const has = s.settings.ocrLangs.includes(code);
            const langs = has
                ? s.settings.ocrLangs.filter((c) => c !== code)
                : [...s.settings.ocrLangs, code];
            return { settings: { ...s.settings, ocrLangs: langs } };
        });
    },

    setTheme(t){
        set((s) => ({ settings: { ...s.settings, theme: t } }));
        get().resolveTheme();
    },

    resolveTheme(){
        const pref = get().settings.theme;
        if(pref !== "system"){
            set({ resolvedTheme: pref });
            return;
        }
        const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
        set({ resolvedTheme: dark ? "dark" : "light" });
    },

    async loadFolders(){
        try{
            set({ folders: await api.listFolders(), foldersLoaded: true, backendError: null });
        }catch(err){
            // Still flip foldersLoaded, or gridMode() pins to "loading" forever.
            set({ foldersLoaded: true, backendError: describeError(err) });
        }
    },

    async addFolder(){
        const added = await api.addFolder();
        if(added === null){
            get().showToast("Folder picker requires the desktop shell");
            return;
        }
        await get().loadFolders();
        get().showToast(`Watching ${added.path}`);
    },

    async removeFolder(path){
        await api.removeFolder(path);
        await get().loadFolders();
        get().showToast("Folder removed");
    },

    async toggleRecursive(path){
        const folder = get().folders.find((f) => f.path === path);
        if(folder === undefined){
            return;
        }
        await api.setFolderRecursive(path, !folder.recursive);
        await get().loadFolders();
    },

    async loadStorage(){
        try{
            set({ storage: await api.storage() });
        }catch(err){
            set({ backendError: describeError(err) });
        }
    },

    async clearCache(){
        if(!get().clearCacheConfirm){
            set({ clearCacheConfirm: true });
            return;
        }
        await api.clearThumbnailCache();
        set({ clearCacheConfirm: false });
        await get().loadStorage();
        get().showToast("Thumbnail cache cleared");
    },

    cancelClearCache(){
        set({ clearCacheConfirm: false });
    },

    setDragging(v){
        set({ isDraggingFile: v });
    },

    showToast(msg){
        clearTimeout(toastTimer);
        set({ toast: msg });
        toastTimer = setTimeout(() => set({ toast: null }), 2400);
    },

    async deleteSelected(){
        const ids = [...get().selectedIds];
        if(ids.length === 0){
            return;
        }
        await api.deletePhotos(ids);
        set({ selectedIds: new Set() });
        await get().runSearch();
        get().showToast(`${ids.length} item${ids.length === 1 ? "" : "s"} removed from index`);
    },

    async revealSelected(){
        const ids = [...get().selectedIds];
        await api.revealInFiles(ids);
        get().showToast("Revealing in file manager…");
    },

    addSelectionToCollection(){
        const n = get().selectedIds.size;
        get().showToast(`${n} item${n === 1 ? "" : "s"} added to collection`);
    },
}));

/** Which of the six grid states the main area should render. */
export function gridMode(s: State): GridMode{
    // Boot: show skeletons rather than guessing at an empty library.
    if(s.searching || !s.foldersLoaded){
        return "loading";
    }
    if(s.folders.length === 0 && s.query.trim() === "" && s.results.length === 0){
        return "emptyLibrary";
    }
    const isSearch = s.query.trim() !== "" || s.similarTo !== null;
    if(isSearch && s.results.length === 0){
        return "emptySearch";
    }
    if(s.selectedIds.size > 0){
        return "selection";
    }
    return isSearch ? "results" : "idle";
}
