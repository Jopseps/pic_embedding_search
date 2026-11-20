import { create } from "zustand";
import { api, isMockMode } from "./api";
import { RateTracker, type Transfer } from "./transfer";
import {
    resolveLanguage,
    setCurrentLanguage,
    systemLanguage,
    t,
    type Lang,
} from "./i18n";
import {
    DEFAULT_ACCENT_HUE,
    DEFAULT_CELL_RADIUS,
    DEFAULT_DRAG_SLOP,
    DEFAULT_FONT_ID,
    DEFAULT_HOLD_MS,
    DEFAULT_LANGUAGE,
    DEFAULT_MODEL_ID,
    DEFAULT_OCR_ENGINE_ID,
    DEFAULT_OCR_LANGS,
    DEFAULT_PAGE_SIZE,
    DEFAULT_SEARCH_DEBOUNCE_MS,
    DEFAULT_SELECTION_BORDER,
    DEFAULT_GROUP_BY,
    DEFAULT_SORT,
    DEFAULT_MATCH_MODE,
    DEFAULT_MATCH_STRICTNESS,
    DEFAULT_SORTED_SEARCH_KEEP,
    DEFAULT_CHECK_UPDATES_ON_STARTUP,
    MAX_RECENT_SEARCHES,
    DEFAULT_TEXT_WEIGHT,
    DEFAULT_TINT_HUE,
    DEFAULT_TINT_STRENGTH,
    DEFAULT_UI_SCALE,
    isDateSort,
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
    LibraryCounts,
    LanguagePref,
    LibraryView,
    Photo,
    PhotoKind,
    ModelDownload,
    ModelStatus,
    FontDownload,
    FontStatus,
    ReindexStatus,
    ResolvedTheme,
    SavedSearch,
    SearchQuery,
    SearchResponse,
    SearchSort,
    Settings,
    OcrStatus,
    StorageUsage,
    ThemePref,
    Timeline,
    UiScale,
    UpdateState,
    WatchedFolder,
} from "./types";

const MOCK_INDEX_TICK_MS = 1400;

export const SIDEBAR_MIN_W = 180;
export const SIDEBAR_MAX_W = 480;
export const SIDEBAR_DEFAULT_W = 240;
/** Drag narrower than this and the sidebar collapses instead of shrinking —
 *  below it the counts and chips stop fitting and the panel is just noise. */
export const SIDEBAR_SNAP_W = 140;
const SIDEBAR_WIDTH_KEY = "picsearch.sidebarWidth";

export function clampSidebarWidth(w: number): number{
    return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(w)));
}

function loadSidebarWidth(): number{
    try{
        const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
        if(raw === null){
            return SIDEBAR_DEFAULT_W;
        }
        const n = Number(raw);
        return Number.isFinite(n) ? clampSidebarWidth(n) : SIDEBAR_DEFAULT_W;
    }catch{
        // Private mode, or no DOM under vitest. A default width is not worth
        // failing store construction over.
        return SIDEBAR_DEFAULT_W;
    }
}

export type MainView = "library" | "settings";

/** The search that was showing when "find similar" took over. */
export interface SimilarOrigin{
    query: string;
    searchSort: SearchSort;
    filters: Filters;
    libraryView: LibraryView | null;
    activeCollection: string | null;
    focusedIndex: number;
}

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
    /** Next page of the current search, or null when everything is loaded. */
    cursor: string | null;
    /** Matches the strictness cutoff is holding back from this search. */
    weak: number;
    /** `searchKey` of the search "show less relevant" was pressed on. Compared,
     *  never reset: a new query changes the key and the cutoff is back. */
    weakKey: string | null;
    /** A next page is in flight. Never `searching`: that flips the grid to
     *  skeletons, which mid-scroll would blank everything already on screen. */
    loadingMore: boolean;
    /** The order a *query* is shown in. Session-only: relevance until the user
     *  picks something else, and back to relevance when the query clears.
     *  Browsing uses the persisted `settings.sort`. */
    searchSort: SearchSort;
    /** Photos per month over the whole result, for the scrubber. Null unless
     *  the grid is sorted by date. */
    timeline: Timeline | null;
    /** Set when results came from "find similar" rather than a text query. */
    similarTo: Photo | null;
    /** What was on screen before "find similar" replaced it, so Esc can put it
     *  back. Null when not in similar-mode. */
    beforeSimilar: SimilarOrigin | null;

    libraryView: LibraryView | null;
    activeCollection: string | null;
    collections: Collection[];
    savedSearches: SavedSearch[];
    addingCollection: boolean;
    newCollectionName: string;
    /** The "Add to collection" dropdown in the selection bar. */
    collectionMenuOpen: boolean;
    /** Collection whose delete button is armed. One click arms, the next
     *  confirms — losing a collection loses which photos were in it. */
    pendingCollectionDelete: string | null;

    filters: Filters;
    filtersOpen: FilterSectionsOpen;

    sidebarCollapsed: boolean;
    /** Dragged width of the sidebar. Frontend-only preference: it describes this
     *  window, not the library, so it lives in localStorage rather than in the
     *  sidecar's config.toml alongside `density`. */
    sidebarWidth: number;
    density: Density;
    selectedIds: Set<number>;
    /** Where a Shift-range starts. Set by every gesture that picks a single
     *  photo, so Shift always extends from the last thing touched. */
    anchorId: number | null;
    /** A drag carrying photos: onto a sidebar collection, or out to the OS. */
    dragOut: { active: boolean; count: number; overCollection: string | null };
    focusedIndex: number;
    hoveredId: number | null;

    lightboxIndex: number | null;
    lightboxStripVisible: boolean;
    /** F: image only, no chrome. Lives here rather than in the component so the
     *  global Escape handler can exit it before closing the lightbox. */
    lightboxFullscreen: boolean;
    ocrExpanded: boolean;

    indexing: IndexingStatus;
    indexingPanelOpen: boolean;
    reindex: ReindexStatus;
    /** The model the user picked but has not confirmed yet — it drives the
     *  "re-index required" card, and is cleared the moment the swap starts. */
    pendingModelId: string | null;
    /** Every model's files on disk, by id. Empty until the Settings page asks. */
    models: Record<string, ModelStatus>;
    /** The download in flight, with the speed measured so far. */
    modelDownload: (ModelDownload & { transfer: Transfer | null }) | null;
    /** The model whose "delete its files?" card is open. */
    deletingModelId: string | null;
    /** Installable UI fonts, by id. Empty until the Settings page asks. */
    fonts: Record<string, FontStatus>;
    /** The font install in flight, with its speed, like `modelDownload`. */
    fontDownload: (FontDownload & { transfer: Transfer | null }) | null;
    /** Where the update check stands. Only a click or the startup toggle moves it off `idle`. */
    update: UpdateState;
    /** A Settings section to open on, set by the TopBar's update pill and
     *  cleared by `SettingsView` the moment it has switched to it. */
    settingsSection: string | null;
    /** Library-wide counts for the sidebar. Never derived from the current
     *  search, which is what made "All" show the result count instead. */
    counts: LibraryCounts;

    settings: Settings;
    resolvedTheme: ResolvedTheme;
    /** The language on screen: the setting resolved against the system's. */
    lang: Lang;
    folders: WatchedFolder[];
    /** False until the first folder load resolves. Without this the empty-library
     *  state flashes on every launch, before we know whether folders exist. */
    foldersLoaded: boolean;
    /** Set when a backend call fails at boot. Surfaced as a banner — otherwise
     *  a sidecar that is not up yet just shows skeletons forever. */
    backendError: string | null;
    storage: StorageUsage;
    /** Null until Settings asks. Carries the install hint for tesseract. */
    ocrStatus: OcrStatus | null;
    clearCacheConfirm: boolean;
    /** The "Move to trash" dialog is open for the current selection. */
    deleteConfirm: boolean;
    /** Watched folder whose removal is waiting for a second click. */
    removeFolderConfirm: string | null;

    isDraggingFile: boolean;
    toast: string | null;
}

interface Actions{
    setView(v: MainView): void;

    setQuery(q: string): void;
    /** Put a search at the top of the recent list (case-insensitive, no duplicates). */
    rememberSearch(q: string): void;
    forgetSearch(q: string): void;
    clearRecentSearches(): void;
    clearQuery(): void;
    /** `keepLoaded` re-fetches as many rows as are loaded, for refreshes the
     *  user did not ask for — a rescan must not cut a deep scroll to page one. */
    runSearch(opts?: { keepLoaded?: boolean }): Promise<void>;
    /** Append the next page. No-op while one is in flight or none is left. */
    loadMore(): Promise<void>;
    /** Lift the strictness cutoff for the search on screen. */
    showWeakMatches(): void;
    /** Load pages until row `index` exists — a scrubber jump far down. */
    loadThrough(index: number): Promise<void>;
    loadTimeline(): Promise<void>;
    /** Persisted when browsing; session-only while a query is active. */
    setSort(sort: SearchSort): void;
    findSimilar(photo: Photo): Promise<void>;
    /** Find similar for an image file that is not in the library. */
    findSimilarToFile(path: string): Promise<void>;
    /** A drop from the OS: the first file becomes the subject. */
    dropFiles(paths: string[]): Promise<void>;
    exitSimilar(): void;

    setLibraryView(v: LibraryView): void;
    setActiveCollection(id: string): void;
    startAddCollection(): void;
    setNewCollectionName(n: string): void;
    commitCollection(): Promise<void>;
    cancelAddCollection(): void;
    loadCollections(): Promise<void>;
    deleteCollection(id: string): Promise<void>;
    cancelDeleteCollection(): void;
    loadSavedSearches(): Promise<void>;
    runSavedSearch(s: SavedSearch): void;
    saveCurrentSearch(): Promise<void>;
    deleteSavedSearch(id: string): Promise<void>;

    toggleFilterSection(key: keyof FilterSectionsOpen): void;
    setDatePreset(p: DatePreset): void;
    /** Either end may be null (open). Clears the preset. */
    setDateRange(from: string | null, to: string | null): void;
    toggleFolderFilter(folder: string): void;
    toggleTypeFilter(t: PhotoKind): void;
    setDimsFilter(d: DimsFilter): void;
    clearAllFilters(): void;

    toggleSidebar(): void;
    setSidebarCollapsed(v: boolean): void;
    /** `persist` is false for the frames of a drag — writing localStorage once
     *  per pointermove is a sync write per frame for a value only the release
     *  makes final. */
    setSidebarWidth(w: number, persist?: boolean): void;
    setDensity(d: Density): void;
    stepDensity(dir: 1 | -1): void;
    setHovered(id: number | null): void;
    setFocusedIndex(i: number): void;
    toggleSelect(id: number): void;
    /** Batch add or remove, for a paint sweep. */
    paintSelection(ids: readonly number[], mode: "add" | "remove"): void;
    /** Wholesale replacement, for a Shift-range that must shrink as well as
     *  grow while the pointer moves. */
    setSelection(ids: readonly number[]): void;
    setAnchor(id: number | null): void;
    startDragOut(count: number): void;
    setDragOverCollection(id: string | null): void;
    endDragOut(): void;
    clearSelection(): void;

    openLightbox(i: number): void;
    closeLightbox(): void;
    stepLightbox(dir: 1 | -1, count: number): void;
    toggleLightboxStrip(): void;
    toggleLightboxFullscreen(): void;
    toggleOcrExpanded(): void;

    toggleIndexingPanel(): void;
    toggleIndexingPause(): Promise<void>;
    startEventStream(): () => void;
    tickIndexing(): void;

    selectModel(id: string): void;
    cancelModelChange(): void;
    confirmModelChange(): Promise<void>;
    loadModels(): Promise<void>;
    downloadModel(id: string): Promise<void>;
    askDeleteModel(id: string): void;
    cancelDeleteModel(): void;
    confirmDeleteModel(): Promise<void>;
    loadFonts(): Promise<void>;
    installFont(id: string): Promise<void>;
    removeFont(id: string): Promise<void>;
    checkForUpdates(): Promise<void>;
    openReleasePage(): Promise<void>;
    openSettingsSection(id: string): void;
    clearSettingsSection(): void;
    loadSettings(): Promise<void>;
    persistSettings(patch: Partial<Settings>): Promise<void>;
    loadCounts(): Promise<void>;
    setOcrEngine(id: string): void;
    toggleOcrLang(code: string): void;
    setTheme(t: ThemePref): void;
    resolveTheme(): void;
    setLanguage(pref: LanguagePref): void;
    resolveLanguage(): void;
    setFont(id: string): void;
    setUiScale(scale: UiScale): void;
    setReduceMotion(on: boolean): void;
    setHighContrast(on: boolean): void;
    /** Every preference whose whole job is "write it and persist it" — the
     *  colours, the grid shape, the gesture timings, the search knobs. Model,
     *  OCR, theme and density keep their own setters because each of them has
     *  real work to do besides; the rest would be nine copies of two lines,
     *  which is nine chances to persist one of them and forget the next. */
    setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;

    loadFolders(): Promise<void>;
    addFolder(): Promise<void>;
    requestRemoveFolder(path: string): void;
    cancelRemoveFolder(): void;
    removeFolder(path: string): Promise<void>;
    toggleRecursive(path: string): Promise<void>;
    loadStorage(): Promise<void>;
    loadOcrStatus(): Promise<void>;
    refreshOcr(): Promise<void>;
    clearCache(): Promise<void>;
    cancelClearCache(): void;

    setDragging(v: boolean): void;
    showToast(msg: string): void;
    requestDelete(): void;
    cancelDelete(): void;
    /** The confirmed half: moves the selection to the trash. */
    deleteSelected(): Promise<void>;
    revealSelected(): Promise<void>;
    toggleCollectionMenu(): void;
    addSelectionToCollection(id: string): Promise<void>;
    /** The drop target half: a drag carries its own ids, which are not always
     *  the selection — dropping one unselected photo must not move the rest. */
    addPhotosToCollection(id: string, ids: readonly number[]): Promise<void>;
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Preference writes waiting to go to disk, and the timer that flushes them.
 *  See `setSetting`: a slider drag is one PUT, not one per pixel. */
let settingsTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSettings: Partial<Settings> = {};
const SETTINGS_FLUSH_MS = 250;
/** Guards against an older in-flight search overwriting a newer one. */
let searchSeq = 0;

const EMPTY_FILTERS: Filters = {
    datePreset: null, dateFrom: null, dateTo: null, folders: [], types: [], dims: null,
};
/** `limit` is capped here by the sidecar; asking for more is asking for this. */
const MAX_PAGE = 1000;

export function describeError(err: unknown): string{
    return err instanceof Error ? err.message : String(err);
}

/** The sidecar's own sentence, for errors that are meant to be read: its 4xx
 *  bodies are `{"detail": "..."}` behind a `sidecar 415:` prefix. */
function describeDetail(err: unknown): string{
    const m = /^sidecar \d+: (.*)$/s.exec(describeError(err));
    if(m !== null){
        try{
            const detail = (JSON.parse(m[1]!) as { detail?: unknown }).detail;
            if(typeof detail === "string"){
                return detail;
            }
        }catch{
            // Not JSON: fall through to the whole message.
        }
    }
    return describeError(err);
}

/** `Photo.id` of the stand-in for an image dropped from outside the library. */
export const EXTERNAL_ID = -1;

/** The subject of a find-similar that is a file on disk rather than a row. It
 *  rides in `similarTo` so every "similar mode" check keeps working unchanged. */
function externalPhoto(path: string): Photo{
    const name = path.split(/[\\/]/).pop() || path;
    return {
        id: EXTERNAL_ID, path, filename: name,
        folder: path.slice(0, path.length - name.length).replace(/[\\/]$/, ""),
        width: 0, height: 0, mime: "", takenAt: null, dateSource: null,
        isScreenshot: false, hasOcr: false, ocrText: null, snippet: null,
        isDupe: false, collections: [],
    };
}

function fetchSimilar(photo: Photo, filters: Filters): Promise<SearchResponse>{
    return photo.id === EXTERNAL_ID
        ? api.similarToFile(photo.path, filters)
        : api.similar(photo.id, filters);
}

let mockReindexTimer: ReturnType<typeof setInterval> | undefined;
/** Speed and time left for the model download on screen. */
const modelRate = new RateTracker();
/** Mock mode only: stands in for the sidecar's `model-download` events. */
let mockDownloadTimer: ReturnType<typeof setInterval> | undefined;
/** Its own tracker, so a font install never resets the model download's speed. */
const fontRate = new RateTracker();
let mockFontTimer: ReturnType<typeof setInterval> | undefined;

/** Mock mode only: stands in for the sidecar's `font-download` events. */
function simulateFontInstall(
    set: (partial: Partial<State & Actions>) => void,
    get: () => State & Actions,
    fontId: string,
){
    clearInterval(mockFontTimer);
    const total = 260 * 1024;
    let done = 0;
    fontRate.reset();
    mockFontTimer = setInterval(() => {
        done = Math.min(total, done + total / 12);
        if(done >= total){
            clearInterval(mockFontTimer);
            fontRate.reset();
            set({ fontDownload: null });
            void get().loadFonts();
            return;
        }
        set({ fontDownload: { fontId, done, total, state: "downloading", transfer: fontRate.push(done, total) } });
    }, 150);
}

/**
 * Mock-mode stand-in for the sidecar's `reindex` / `model-changed` events.
 *
 * Only ever called when `isMockMode`. It ends the same way the real path does —
 * `settings.modelId` moves, `reindex.active` clears, one search re-runs — so
 * the model-swap flow is exercisable in a browser with no Python at all.
 */
function simulateReindex(
    set: (partial: Partial<State & Actions> | ((s: State & Actions) => Partial<State & Actions>)) => void,
    get: () => State & Actions,
    modelId: string,
){
    clearInterval(mockReindexTimer);
    const total = Math.max(1, get().counts.library);
    mockReindexTimer = setInterval(() => {
        const cur = get().reindex;
        if(!cur.active){
            clearInterval(mockReindexTimer);   // cancelled from elsewhere
            return;
        }
        const next = Math.min(100, cur.progress + 7);
        if(next >= 100){
            clearInterval(mockReindexTimer);
            set((s) => ({
                reindex: { ...s.reindex, active: false, progress: 0 },
                settings: { ...s.settings, modelId },
            }));
            get().showToast(t("toast.nowSearching", { model: modelById(modelId)?.name ?? modelId }));
            void get().runSearch();
            return;
        }
        set({
            reindex: {
                ...cur,
                progress: next,
                current: Math.round(total * next / 100),
                total,
                rate: 24,
                etaSec: Math.round(total * (100 - next) / 100 / 24),
            },
        });
    }, 200);
}

function simulateDownload(
    set: (partial: Partial<State & Actions> | ((s: State & Actions) => Partial<State & Actions>)) => void,
    get: () => State & Actions,
    modelId: string,
){
    clearInterval(mockDownloadTimer);
    const total = 1.6 * 1024 ** 3;
    let done = 0;
    modelRate.reset();
    mockDownloadTimer = setInterval(() => {
        done = Math.min(total, done + total / 25);
        if(done >= total){
            clearInterval(mockDownloadTimer);
            modelRate.reset();
            set({ modelDownload: null });
            void get().loadModels();
            return;
        }
        set({
            modelDownload: {
                modelId, done, total, state: "downloading", transfer: modelRate.push(done, total),
            },
        });
    }, 200);
}

export const useStore = create<State & Actions>((set, get) => ({
    view: "library",

    query: "",
    searching: false,
    results: [],
    total: 0,
    tookMs: 0,
    cursor: null,
    weak: 0,
    weakKey: null,
    loadingMore: false,
    searchSort: "relevance",
    timeline: null,
    similarTo: null,
    beforeSimilar: null,

    libraryView: "all",
    activeCollection: null,
    // Both come from the backend at boot. `MockApi` still seeds the fixture
    // ones, so a browser run has collections with real members in them.
    collections: [],
    savedSearches: [],
    addingCollection: false,
    newCollectionName: "",
    collectionMenuOpen: false,
    pendingCollectionDelete: null,

    filters: EMPTY_FILTERS,
    filtersOpen: { date: false, folder: false, type: false, dims: false },

    sidebarCollapsed: false,
    sidebarWidth: loadSidebarWidth(),
    density: 1,
    selectedIds: new Set(),
    anchorId: null,
    dragOut: { active: false, count: 0, overCollection: null },
    focusedIndex: -1,
    hoveredId: null,

    lightboxIndex: null,
    lightboxStripVisible: true,
    lightboxFullscreen: false,
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
            running: true,
        }
        : { current: 0, total: 0, rate: 0, etaSec: 0, paused: false, currentFile: "", running: false },
    indexingPanelOpen: false,
    reindex: { active: false, progress: 0, modelName: "", current: 0, total: 0, rate: 0, etaSec: 0 },
    pendingModelId: null,
    models: {},
    modelDownload: null,
    deletingModelId: null,
    fonts: {},
    fontDownload: null,
    update: { kind: "idle" },
    settingsSection: null,
    counts: { library: 0, recent: 0, dupes: 0, collections: {} },

    settings: {
        modelId: DEFAULT_MODEL_ID,
        ocrEngineId: DEFAULT_OCR_ENGINE_ID,
        ocrLangs: [...DEFAULT_OCR_LANGS],
        theme: "dark",
        language: DEFAULT_LANGUAGE,
        density: 1,
        fontId: DEFAULT_FONT_ID,
        uiScale: DEFAULT_UI_SCALE,
        reduceMotion: false,
        highContrast: false,
        accentHue: DEFAULT_ACCENT_HUE,
        tintHue: DEFAULT_TINT_HUE,
        tintStrength: DEFAULT_TINT_STRENGTH,
        selectionBorder: DEFAULT_SELECTION_BORDER,
        cellRadius: DEFAULT_CELL_RADIUS,
        holdMs: DEFAULT_HOLD_MS,
        dragSlop: DEFAULT_DRAG_SLOP,
        pageSize: DEFAULT_PAGE_SIZE,
        searchDebounceMs: DEFAULT_SEARCH_DEBOUNCE_MS,
        textWeight: DEFAULT_TEXT_WEIGHT,
        matchMode: DEFAULT_MATCH_MODE,
        matchStrictness: DEFAULT_MATCH_STRICTNESS,
        sort: DEFAULT_SORT,
        groupBy: DEFAULT_GROUP_BY,
        sortedSearchKeep: DEFAULT_SORTED_SEARCH_KEEP,
        recentSearches: [],
        checkUpdatesOnStartup: DEFAULT_CHECK_UPDATES_ON_STARTUP,
    },
    resolvedTheme: "dark",
    lang: resolveLanguage("auto", systemLanguage()),
    folders: [],
    foldersLoaded: false,
    backendError: null,
    storage: { thumbnailCacheGb: 0, indexGb: 0 },
    ocrStatus: null,
    clearCacheConfirm: false,
    deleteConfirm: false,
    removeFolderConfirm: null,

    isDraggingFile: false,
    toast: null,

    // -----------------------------------------------------------------------

    setView(v){
        set({ view: v });
    },

    rememberSearch(q){
        const text = q.trim();
        if(text.length < 2){
            return;
        }
        const rest = get().settings.recentSearches.filter((r) => r.toLowerCase() !== text.toLowerCase());
        get().setSetting("recentSearches", [text, ...rest].slice(0, MAX_RECENT_SEARCHES));
    },

    forgetSearch(q){
        get().setSetting("recentSearches", get().settings.recentSearches.filter((r) => r !== q));
    },

    clearRecentSearches(){
        get().setSetting("recentSearches", []);
    },

    setQuery(q){
        // The search box is in the top bar of Settings too: typing there has to
        // show the results, not change a list nobody can see.
        set({ query: q, similarTo: null });
        if(q.trim() !== ""){
            set({ view: "library" });
        }
        clearTimeout(debounceTimer);
        if(q.trim() === ""){
            set({ searching: false, searchSort: "relevance" });
            void get().runSearch();
            return;
        }
        set({ searching: true });
        debounceTimer = setTimeout(
            () => void get().runSearch(),
            get().settings.searchDebounceMs,
        );
    },

    clearQuery(){
        clearTimeout(debounceTimer);
        set({ query: "", searching: false, similarTo: null, searchSort: "relevance" });
        void get().runSearch();
    },

    async runSearch(opts){
        const s = get();
        // A re-index no longer blocks this. The outgoing model keeps every
        // vector it had until the incoming one reaches full coverage, so
        // search answers normally for the whole swap — see `confirmModelChange`.
        const seq = ++searchSeq;
        const keep = opts?.keepLoaded === true;
        const limit = keep
            ? Math.min(MAX_PAGE, Math.max(s.settings.pageSize, s.results.length))
            : s.settings.pageSize;
        void get().loadTimeline();
        try{
            // "Find similar" is not a /search query: re-running it as one (a
            // rescan) would swap the neighbours for the whole
            // library under a header that still says "Visually similar".
            const res = s.similarTo !== null
                ? await fetchSimilar(s.similarTo, s.filters)
                : await api.search({ ...currentQuery(s), limit });
            if(seq !== searchSeq){
                return;
            }
            set({
                ...reanchor(get(), res.items, keep),
                results: res.items,
                total: res.total,
                tookMs: res.tookMs,
                cursor: res.cursor,
                weak: res.weak ?? 0,
                loadingMore: false,
                searching: false,
                backendError: null,
            });
        }catch(err){
            if(seq !== searchSeq){
                return;
            }
            // A refresh nobody asked for must not blank a grid the user is
            // looking at because the sidecar blipped once.
            set(keep
                ? { searching: false, loadingMore: false, backendError: describeError(err) }
                : {
                    ...reanchor(get(), [], false),
                    searching: false, loadingMore: false, results: [], total: 0, cursor: null, weak: 0,
                    backendError: describeError(err),
                });
        }
    },

    async loadMore(){
        await fetchMore(get().settings.pageSize);
    },

    showWeakMatches(){
        set({ weakKey: searchKey(get()) });
        // keepLoaded: the strong matches stay put and the rest arrive below them.
        void get().runSearch({ keepLoaded: true });
    },

    async loadThrough(index){
        // One request per missing stretch rather than page after page: a jump
        // to the far end of a large library is otherwise dozens of round trips.
        while(get().results.length <= index && get().cursor !== null){
            const loaded = get().results.length;
            const want = Math.min(MAX_PAGE, Math.max(get().settings.pageSize, index + 1 - loaded));
            if(!await fetchMore(want)){
                return;
            }
        }
    },

    async loadTimeline(){
        const s = get();
        if(!sectionsByDate(s)){
            set({ timeline: null });
            return;
        }
        const seq = searchSeq;
        try{
            const timeline = await api.timeline(currentQuery(s));
            if(seq === searchSeq){
                set({ timeline });
            }
        }catch{
            // Advisory: without it the scrubber hides, and the grid still works.
            if(seq === searchSeq){
                set({ timeline: null });
            }
        }
    },

    setSort(sort){
        const s = get();
        if(s.query.trim() !== ""){
            set({ searchSort: sort, searching: true });
        }else if(sort !== "relevance"){
            // Routed through `setSetting` so it persists like every other
            // preference; the search re-runs here, not in the flush, so the
            // grid does not wait out the write debounce.
            get().setSetting("sort", sort);
            set({ searching: true });
        }else{
            return;
        }
        void get().runSearch();
    },

    async findSimilar(photo){
        const seq = ++searchSeq;
        // A pending keystroke would otherwise fire a search into similar-mode.
        clearTimeout(debounceTimer);
        const s = get();
        set({
            searching: true,
            lightboxIndex: null,
            query: "",
            similarTo: photo,
            selectedIds: new Set(),
            // Everything "find similar" is about to overwrite. Leaving it
            // unsaved is why Esc used to dump you into the All tab having
            // silently thrown away the search you came from.
            beforeSimilar: s.similarTo !== null ? s.beforeSimilar : {
                query: s.query,
                searchSort: s.searchSort,
                filters: s.filters,
                libraryView: s.libraryView,
                activeCollection: s.activeCollection,
                focusedIndex: s.focusedIndex,
            },
        });
        let res: SearchResponse;
        try{
            res = await fetchSimilar(photo, s.filters);
        }catch(err){
            if(seq === searchSeq){
                // Back to what was on screen, or the skeletons never go away.
                set({
                    searching: false, query: s.query, similarTo: s.similarTo,
                    beforeSimilar: s.beforeSimilar,
                });
                get().showToast(describeDetail(err));
            }
            return;
        }
        if(seq !== searchSeq){
            return;
        }
        set({
            results: res.items,
            total: res.total,
            tookMs: res.tookMs,
            cursor: null,
            weak: 0,
            loadingMore: false,
            timeline: null,
            searching: false,
            focusedIndex: -1,
        });
        get().showToast(t("toast.similarTo", { name: photo.filename }));
    },

    async findSimilarToFile(path){
        await get().findSimilar(externalPhoto(path));
    },

    async dropFiles(paths){
        set({ isDraggingFile: false });
        const first = paths[0];
        if(first === undefined){
            return;
        }
        await get().findSimilarToFile(first);
        if(paths.length > 1){
            get().showToast(t("toast.usingFile", { name: externalPhoto(first).filename, n: paths.length - 1, other: paths.length - 1 }));
        }
    },

    /**
     * Leave similar-mode and put back exactly what was on screen before it —
     * query, filters, view, collection and the cell that had focus. Falling
     * back to the All tab loses a search the user may have spent real effort on.
     */
    exitSimilar(){
        const origin = get().beforeSimilar;
        set({
            similarTo: null,
            beforeSimilar: null,
            query: origin?.query ?? "",
            searchSort: origin?.searchSort ?? "relevance",
            filters: origin?.filters ?? EMPTY_FILTERS,
            libraryView: origin?.libraryView ?? "all",
            activeCollection: origin?.activeCollection ?? null,
            focusedIndex: origin?.focusedIndex ?? -1,
            searching: true,
        });
        void get().runSearch();
    },

    setLibraryView(v){
        set({ view: "library", libraryView: v, activeCollection: null, selectedIds: new Set(), similarTo: null });
        void get().runSearch();
    },

    setActiveCollection(id){
        set({ view: "library", activeCollection: id, libraryView: null, selectedIds: new Set(), similarTo: null });
        void get().runSearch();
    },

    startAddCollection(){
        set({ addingCollection: true, newCollectionName: "" });
    },

    setNewCollectionName(n){
        set({ newCollectionName: n });
    },

    async commitCollection(){
        const name = get().newCollectionName.trim();
        if(name === ""){
            set({ addingCollection: false });
            return;
        }
        // Both entry points share this: the sidebar's inline input and the
        // selection menu's. Only the second one implies the selection goes in.
        const fromMenu = get().collectionMenuOpen;
        set({ addingCollection: false, newCollectionName: "" });
        try{
            const made = await api.createCollection(name);
            await get().loadCollections();
            // Creating one from inside the selection menu is a request to put
            // the selection in it — otherwise the user names a collection and
            // nothing visibly happens. From the sidebar it is not: naming a
            // collection there asks for an empty one.
            const ids = fromMenu ? [...get().selectedIds] : [];
            if(ids.length > 0){
                await api.addToCollection(made.id, ids);
                set({ collectionMenuOpen: false, selectedIds: new Set() });
                await get().loadCounts();
                await get().runSearch({ keepLoaded: true });
                get().showToast(t("toast.addedToCollection", { n: ids.length, name }));
                return;
            }
            get().showToast(t("toast.collectionCreated", { name }));
        }catch(err){
            get().showToast(describeError(err));
        }
    },

    cancelAddCollection(){
        set({ addingCollection: false, newCollectionName: "" });
    },

    async loadCollections(){
        try{
            set({ collections: await api.listCollections() });
        }catch(err){
            set({ backendError: describeError(err) });
        }
    },

    async deleteCollection(id){
        // Same arm-then-confirm shape as the thumbnail cache. The collection is
        // trivial to recreate; which photos were in it is not.
        if(get().pendingCollectionDelete !== id){
            set({ pendingCollectionDelete: id });
            return;
        }
        set({ pendingCollectionDelete: null });
        try{
            await api.deleteCollection(id);
        }catch(err){
            get().showToast(describeError(err));
            return;
        }
        // Looking at it when it goes is the case worth handling: fall back to
        // the library rather than leaving a view that can never load.
        if(get().activeCollection === id){
            set({ activeCollection: null, libraryView: "all" });
        }
        await get().loadCollections();
        await get().loadCounts();
        await get().runSearch();
        get().showToast(t("toast.collectionDeleted"));
    },

    cancelDeleteCollection(){
        set({ pendingCollectionDelete: null });
    },

    async loadSavedSearches(){
        try{
            set({ savedSearches: await api.listSavedSearches() });
        }catch(err){
            set({ backendError: describeError(err) });
        }
    },

    runSavedSearch(saved){
        // A saved search restores the whole state it was saved from, not just
        // the words — otherwise it silently runs against whatever filters
        // happen to be set and returns something the user did not save.
        clearTimeout(debounceTimer);
        set({
            query: saved.query,
            filters: saved.filters,
            view: "library",
            libraryView: saved.collection === null ? (saved.view ?? "all") : null,
            activeCollection: saved.collection,
            similarTo: null,
            selectedIds: new Set(),
            searching: true,
        });
        void get().runSearch();
    },

    async saveCurrentSearch(){
        const s = get();
        const query = s.query.trim();
        if(query === ""){
            get().showToast(t("toast.nothingToSave"));
            return;
        }
        try{
            await api.saveSearch({
                q: query,
                view: s.activeCollection === null ? s.libraryView : null,
                collection: s.activeCollection,
                filters: s.filters,
            });
            await get().loadSavedSearches();
            get().showToast(t("toast.saved", { query }));
        }catch(err){
            get().showToast(describeError(err));
        }
    },

    async deleteSavedSearch(id){
        try{
            await api.deleteSavedSearch(id);
        }catch(err){
            get().showToast(describeError(err));
            return;
        }
        await get().loadSavedSearches();
    },

    toggleFilterSection(key){
        set((s) => ({ filtersOpen: { ...s.filtersOpen, [key]: !s.filtersOpen[key] } }));
    },

    setDatePreset(p){
        // A preset and a custom range are two answers to one question; the
        // one just picked wins.
        set((s) => ({
            filters: {
                ...s.filters,
                datePreset: s.filters.datePreset === p ? null : p,
                dateFrom: null,
                dateTo: null,
            },
        }));
        void get().runSearch();
    },

    setDateRange(from, to){
        const f = get().filters;
        if(f.dateFrom === from && f.dateTo === to){
            return;
        }
        set((s) => ({
            filters: {
                ...s.filters,
                dateFrom: from,
                dateTo: to,
                datePreset: from === null && to === null ? s.filters.datePreset : null,
            },
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
        set({ filters: EMPTY_FILTERS });
        void get().runSearch();
    },

    toggleSidebar(){
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
    },

    setSidebarCollapsed(v){
        set({ sidebarCollapsed: v });
    },

    setSidebarWidth(w, persist = true){
        const width = clampSidebarWidth(w);
        set({ sidebarWidth: width });
        if(!persist){
            return;
        }
        try{
            window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
        }catch{
            // Non-fatal: the width still applies for this session.
        }
    },

    setDensity(d){
        set({ density: d });
        // Coalesced like every other preference: Ctrl+wheel steps this once per
        // notch, and each uncoalesced write is a read-modify-write of config.toml.
        get().setSetting("density", d);
    },

    stepDensity(dir){
        // Zooming in means bigger photos, which is a *higher* density index —
        // GRID_ROW_HEIGHTS is ordered smallest row first.
        const next = Math.min(2, Math.max(0, get().density + dir)) as Density;
        if(next !== get().density){
            get().setDensity(next);
        }
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
            // Every single-photo pick moves the anchor: Shift extends from the
            // last thing touched, which is the only reading that matches what
            // the hand just did.
            const rest = { anchorId: id };
            // Deselecting the last one unmounts the bar; the menu goes with it.
            return next.size === 0
                ? { ...rest, selectedIds: next, collectionMenuOpen: false, addingCollection: false }
                : { ...rest, selectedIds: next };
        });
    },

    paintSelection(ids, mode){
        if(ids.length === 0){
            return;
        }
        set((s) => {
            // A sweep re-crosses the same photos constantly; handing every cell
            // a new Set when nothing changed re-renders the visible window on
            // every pointermove.
            const changed = ids.some((id) => s.selectedIds.has(id) === (mode === "remove"));
            if(!changed){
                return {};
            }
            const next = new Set(s.selectedIds);
            for(const id of ids){
                if(mode === "add"){
                    next.add(id);
                }else{
                    next.delete(id);
                }
            }
            return next.size === 0
                ? { selectedIds: next, collectionMenuOpen: false, addingCollection: false }
                : { selectedIds: next };
        });
    },

    setSelection(ids){
        set((s) => {
            if(s.selectedIds.size === ids.length && ids.every((id) => s.selectedIds.has(id))){
                return {};
            }
            const next = new Set(ids);
            return next.size === 0
                ? { selectedIds: next, collectionMenuOpen: false, addingCollection: false }
                : { selectedIds: next };
        });
    },

    setAnchor(id){
        set({ anchorId: id });
    },

    startDragOut(count){
        set({ dragOut: { active: true, count, overCollection: null } });
    },

    setDragOverCollection(id){
        set((s) => (s.dragOut.overCollection === id
            ? {}
            : { dragOut: { ...s.dragOut, overCollection: id } }));
    },

    endDragOut(){
        set({ dragOut: { active: false, count: 0, overCollection: null } });
    },

    clearSelection(){
        // The menu hangs off the selection bar, which unmounts at zero — leaving
        // the flag set means it reappears already open on the next selection.
        set({
            selectedIds: new Set(),
            anchorId: null,
            collectionMenuOpen: false,
            addingCollection: false,
        });
    },

    openLightbox(i){
        set({ lightboxIndex: i, ocrExpanded: false });
    },

    closeLightbox(){
        set({ lightboxIndex: null, lightboxFullscreen: false });
    },

    stepLightbox(dir, count){
        const cur = get();
        // Past the last *loaded* photo is not the end while pages remain:
        // wrapping to the first would skip everything not fetched yet.
        if(dir === 1 && cur.lightboxIndex === count - 1 && cur.cursor !== null){
            const from = cur.lightboxIndex;
            void get().loadMore().then(() => {
                if(get().lightboxIndex === from && get().results.length > count){
                    set({ lightboxIndex: from + 1, ocrExpanded: false });
                }
            });
            return;
        }
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

    toggleLightboxFullscreen(){
        set((s) => ({ lightboxFullscreen: !s.lightboxFullscreen }));
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

    async toggleIndexingPause(){
        const next = !get().indexing.paused;
        set((s) => ({ indexing: { ...s.indexing, paused: next } }));
        try{
            await api.setIndexingPaused(next);
        }catch(err){
            set((s) => ({ indexing: { ...s.indexing, paused: !next } }));
            get().showToast(describeError(err));
        }
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
                        running: event.running,
                    },
                });
            }else if(event.type === "reindex"){
                set({
                    reindex: {
                        active: event.active,
                        progress: event.progress,
                        // The sidecar sends the model *id*; the panel shows a
                        // name a human recognises.
                        modelName: modelById(event.modelName)?.name ?? event.modelName,
                        current: event.current,
                        total: event.total,
                        rate: event.rate,
                        etaSec: event.etaSec,
                    },
                });
            }else if(event.type === "model-download"){
                if(event.state === "downloading"){
                    const transfer = event.total > 0 ? modelRate.push(event.done, event.total) : null;
                    set({ modelDownload: { ...event, transfer } });
                }else{
                    modelRate.reset();
                    set({ modelDownload: null });
                    void get().loadModels();
                    if(event.state === "error"){
                        // A swap that was waiting on these files will not happen.
                        set((s) => ({ pendingModelId: null, reindex: { ...s.reindex, active: false } }));
                        get().showToast(t("toast.downloadFailed", { message: event.message ?? t("toast.unknownError") }));
                    }
                }
            }else if(event.type === "font-download"){
                if(event.state === "downloading"){
                    set({ fontDownload: { ...event, transfer: fontRate.push(event.done, event.total) } });
                }else{
                    fontRate.reset();
                    set({ fontDownload: null });
                    void get().loadFonts();
                    if(event.state === "error"){
                        get().showToast(t("toast.fontInstallFailed", { message: event.message ?? t("toast.unknownError") }));
                    }
                }
            }else if(event.type === "model-deleted"){
                void get().loadModels();
            }else if(event.type === "model-changed"){
                // The swap finished: the incoming model is now the one
                // answering queries, so the visible results came from the old
                // vector space and have to be re-run.
                set((s) => ({
                    settings: { ...s.settings, modelId: event.modelId },
                    pendingModelId: null,
                    reindex: { ...s.reindex, active: false, progress: 0 },
                }));
                get().showToast(t("toast.nowSearching", { model: modelById(event.modelId)?.name ?? event.modelId }));
                void get().loadModels();
                void get().runSearch();
            }else if(event.type === "dates-refreshed"){
                // Dates were re-derived under new rules: the order, the month
                // headers and the "Recent" count all moved.
                void get().loadCounts();
                void get().runSearch({ keepLoaded: true });
            }else if(event.type === "scan-complete"){
                // New rows exist now, so the visible results are stale. `ocred`
                // counts too: an OCR backfill changes hasOcr and the snippets
                // without ingesting anything, and it is the only thing a
                // settings-driven engine swap emits.
                if(event.ingested > 0 || event.removed > 0 || event.ocred > 0){
                    void get().loadFolders();
                    void get().loadStorage();
                    void get().loadCounts();
                    void get().runSearch({ keepLoaded: true });
                }
            }else if(event.type === "reconnected"){
                // Whatever the sidecar announced while the stream was down is
                // gone, so ask for the state instead of waiting to be told.
                void get().loadFolders();
                void get().loadStorage();
                void get().loadCounts();
                void get().runSearch({ keepLoaded: true });
            }else if(event.type === "error"){
                // An ingest failure is not "cannot reach the service": the
                // banner says that and stays until a request succeeds.
                get().showToast(t("toast.indexingError", { message: event.message }));
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
                    running: current < s.indexing.total,
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
     * Switching models needs every image re-embedded — different space,
     * different dims, incompatible vectors.
     *
     * **Search is not disabled.** The outgoing model's rows are never deleted,
     * so it goes on answering queries for the whole run; the sidecar flips the
     * active model only once the incoming one has full coverage, and sends
     * `model-changed` when it does.
     */
    async confirmModelChange(){
        const pending = get().pendingModelId;
        if(pending === null){
            return;
        }
        const model = modelById(pending);
        set({
            pendingModelId: null,
            // Optimistic, so the panel appears before the first batch lands.
            reindex: {
                active: true, progress: 0, modelName: model?.name ?? pending,
                current: 0, total: get().counts.library, rate: 0, etaSec: 0,
            },
        });
        try{
            await api.putSettings({ modelId: pending });
        }catch(err){
            set((s) => ({ reindex: { ...s.reindex, active: false } }));
            get().showToast(describeError(err));
            return;
        }
        if(isMockMode){
            // With a sidecar, `model-changed` off /events ends the swap. In a
            // browser there is no sidecar and nothing else would ever clear
            // `reindex.active` — the banner would sit at 0% forever, and
            // `tickIndexing` bails while it is set, so indexing would freeze
            // too. CLAUDE.md requires this flow to be exercisable without
            // Python, so mock mode simulates the backfill it cannot run.
            simulateReindex(set, get, pending);
        }
    },

    async loadModels(){
        try{
            const res = await api.models();
            set({
                models: Object.fromEntries(res.models.map((m) => [m.id, m])),
                // A sidecar that restarted mid-download resumes it; show it.
                modelDownload: res.download !== null && res.download.state === "downloading"
                    ? { ...res.download, transfer: get().modelDownload?.transfer ?? null }
                    : null,
            });
        }catch(err){
            set({ backendError: describeError(err) });
        }
    },

    async downloadModel(id){
        if(get().modelDownload !== null){
            return;
        }
        try{
            await api.downloadModel(id);
        }catch(err){
            get().showToast(describeDetail(err));
            return;
        }
        if(isMockMode){
            simulateDownload(set, get, id);
            return;
        }
        // Progress arrives as `model-download` events; this makes the card
        // switch to its bar before the first one.
        set({ modelDownload: { modelId: id, done: 0, total: 0, state: "downloading", transfer: null } });
    },

    askDeleteModel(id){
        set({ deletingModelId: id });
    },

    cancelDeleteModel(){
        set({ deletingModelId: null });
    },

    async confirmDeleteModel(){
        const id = get().deletingModelId;
        if(id === null){
            return;
        }
        set({ deletingModelId: null });
        try{
            await api.deleteModel(id);
        }catch(err){
            get().showToast(describeDetail(err));
        }
        await get().loadModels();
    },

    async loadFonts(){
        try{
            const res = await api.fonts();
            set({
                fonts: Object.fromEntries(res.fonts.map((f) => [f.id, f])),
                fontDownload: res.download !== null && res.download.state === "downloading"
                    ? { ...res.download, transfer: get().fontDownload?.transfer ?? null }
                    : null,
            });
        }catch(err){
            set({ backendError: describeError(err) });
        }
    },

    async installFont(id){
        if(get().fontDownload !== null){
            return;
        }
        try{
            if(!(await api.installFont(id))){
                await get().loadFonts();
                return;
            }
        }catch(err){
            get().showToast(describeDetail(err));
            return;
        }
        if(isMockMode){
            simulateFontInstall(set, get, id);
            return;
        }
        set({ fontDownload: { fontId: id, done: 0, total: 0, state: "downloading", transfer: null } });
    },

    async removeFont(id){
        try{
            await api.removeFont(id);
        }catch(err){
            get().showToast(describeDetail(err));
        }
        await get().loadFonts();
    },

    async checkForUpdates(){
        if(get().update.kind === "checking"){
            return;
        }
        set({ update: { kind: "checking" } });
        try{
            const res = await api.checkForUpdates();
            set({
                update: !res.ok || res.latest === null
                    ? { kind: "failed" }
                    : res.available
                        ? { kind: "available", latest: res.latest, current: res.current }
                        : { kind: "upToDate" },
            });
        }catch{
            set({ update: { kind: "failed" } });
        }
    },

    async openReleasePage(){
        try{
            await api.openReleasePage();
        }catch(err){
            get().showToast(describeDetail(err));
        }
    },

    openSettingsSection(id){
        set({ view: "settings", settingsSection: id });
    },

    clearSettingsSection(){
        set({ settingsSection: null });
    },

    /**
     * Settings live in `~/.config/pic-search/config.toml`, not in this store.
     * `modelId` is the model **answering searches**, which during a swap is
     * still the outgoing one — so a reload mid-swap shows the truth rather
     * than a model that cannot answer yet.
     */
    async loadSettings(){
        try{
            const s = await api.getSettings();
            const { pendingModelId: _p, pendingCoverage: cov, ...settings } = s;
            // Merged over the defaults rather than replacing them: a
            // config.toml written by an older build has no appearance keys, and
            // `uiScale: undefined` reaches CSS as `calc(1px * undefined)`.
            const before = get();
            set((st) => ({
                settings: { ...st.settings, ...settings },
                density: settings.density ?? st.density,
            }));
            get().resolveTheme();
            get().resolveLanguage();
            if(get().settings.checkUpdatesOnStartup){
                void get().checkForUpdates();
            }
            // The boot search ran before this landed, with the default order.
            // A saved "Name A–Z" has to show as that, not as newest-first.
            if(before.query.trim() === "" && before.settings.sort !== get().settings.sort){
                void get().runSearch();
            }
            if(s.pendingModelId !== null){
                // A swap the sidecar resumed on its own after a restart.
                set({
                    reindex: {
                        active: true,
                        progress: cov.total > 0 ? Math.round(100 * cov.done / cov.total) : 0,
                        modelName: modelById(s.pendingModelId)?.name ?? s.pendingModelId,
                        current: cov.done, total: cov.total, rate: 0, etaSec: 0,
                    },
                });
            }
        }catch(err){
            set({ backendError: describeError(err) });
        }
    },

    async persistSettings(patch){
        try{
            await api.putSettings(patch);
        }catch(err){
            get().showToast(describeError(err));
        }
    },

    async loadCounts(){
        try{
            set({ counts: await api.counts() });
        }catch(err){
            set({ backendError: describeError(err) });
        }
    },

    setOcrEngine(id){
        set((s) => ({ settings: { ...s.settings, ocrEngineId: id } }));
        // After the PUT lands, not alongside it: the sidecar re-resolves the
        // engine while handling it, and the hint is about the new one.
        void get().persistSettings({ ocrEngineId: id }).then(() => get().loadOcrStatus());
    },

    toggleOcrLang(code){
        set((s) => {
            const has = s.settings.ocrLangs.includes(code);
            const langs = has
                ? s.settings.ocrLangs.filter((c) => c !== code)
                : [...s.settings.ocrLangs, code];
            return { settings: { ...s.settings, ocrLangs: langs } };
        });
        void get().persistSettings({ ocrLangs: get().settings.ocrLangs }).then(() => get().loadOcrStatus());
    },

    setTheme(t){
        set((s) => ({ settings: { ...s.settings, theme: t } }));
        get().resolveTheme();
        void get().persistSettings({ theme: t });
    },

    setLanguage(pref){
        set((s) => ({ settings: { ...s.settings, language: pref } }));
        get().resolveLanguage();
        void get().persistSettings({ language: pref });
    },

    /** The setting against the system's language. Also moves what the global
     *  `t()` answers in, which toasts and other non-React code read. */
    resolveLanguage(){
        const lang = resolveLanguage(get().settings.language, systemLanguage());
        setCurrentLanguage(lang);
        // Screen readers pick the pronunciation rules from this, and Turkish
        // casing (i to İ) depends on it too.
        if(typeof document !== "undefined"){
            document.documentElement.setAttribute("lang", lang);
        }
        set({ lang });
    },

    setFont(id){
        set((s) => ({ settings: { ...s.settings, fontId: id } }));
        void get().persistSettings({ fontId: id });
    },

    setUiScale(scale){
        set((s) => ({ settings: { ...s.settings, uiScale: scale } }));
        void get().persistSettings({ uiScale: scale });
    },

    setReduceMotion(on){
        set((s) => ({ settings: { ...s.settings, reduceMotion: on } }));
        void get().persistSettings({ reduceMotion: on });
    },

    setHighContrast(on){
        set((s) => ({ settings: { ...s.settings, highContrast: on } }));
        void get().persistSettings({ highContrast: on });
    },

    setSetting(key, value){
        // The store moves now — a slider has to preview live — and the write
        // to disk is coalesced. A drag emits an input event per pixel, and
        // every one of those would otherwise be a PUT that re-reads and
        // rewrites config.toml, with FastAPI running them concurrently in its
        // threadpool: a read-modify-write race against itself, a few hundred
        // times per drag. Two settings written in one tick (a tint preset sets
        // a hue and a strength) collapse into one PUT for the same reason.
        set((s) => ({ settings: { ...s.settings, [key]: value } }));
        pendingSettings = { ...pendingSettings, [key]: value };
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(() => {
            const patch = pendingSettings;
            pendingSettings = {};
            void get().persistSettings(patch);
            // The page size and the fusion weighting change what a query
            // returns, so the results on screen are stale the moment either
            // lands. Re-run once, at the end of the drag — a search per slider
            // step would embed the query on the GPU thirty times.
            if("pageSize" in patch || "textWeight" in patch || "sortedSearchKeep" in patch || "matchMode" in patch || "matchStrictness" in patch){
                void get().runSearch();
            }
        }, SETTINGS_FLUSH_MS);
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
        let added;
        try{
            added = await api.addFolder();
        }catch(err){
            get().showToast(describeError(err));
            return;
        }
        if(added === null){
            // Outside the browser a null is the user cancelling the picker.
            if(isMockMode){
                get().showToast(t("toast.pickerNeedsShell"));
            }
            return;
        }
        await get().loadFolders();
        get().showToast(t("toast.watching", { path: added.path }));
    },

    requestRemoveFolder(path){
        set({ removeFolderConfirm: path });
    },

    cancelRemoveFolder(){
        set({ removeFolderConfirm: null });
    },

    async removeFolder(path){
        set({ removeFolderConfirm: null });
        try{
            await api.removeFolder(path);
        }catch(err){
            get().showToast(describeError(err));
            return;
        }
        await get().loadFolders();
        void get().loadCounts();
        void get().loadStorage();
        // The folder's photos left the library: results, counts and the timeline
        // (which `runSearch` reloads) all moved.
        await get().runSearch({ keepLoaded: true });
        get().showToast(t("toast.folderRemoved"));
    },

    async toggleRecursive(path){
        const folder = get().folders.find((f) => f.path === path);
        if(folder === undefined){
            return;
        }
        try{
            await api.setFolderRecursive(path, !folder.recursive);
        }catch(err){
            get().showToast(describeError(err));
            return;
        }
        await get().loadFolders();
    },

    async loadStorage(){
        try{
            set({ storage: await api.storage() });
        }catch(err){
            set({ backendError: describeError(err) });
        }
    },

    async loadOcrStatus(){
        try{
            set({ ocrStatus: await api.ocrStatus() });
        }catch{
            // Advisory only. Settings simply shows no hint.
        }
    },

    async refreshOcr(){
        try{
            set({ ocrStatus: await api.refreshOcr() });
        }catch(err){
            get().showToast(describeError(err));
        }
    },

    async clearCache(){
        if(!get().clearCacheConfirm){
            set({ clearCacheConfirm: true });
            return;
        }
        set({ clearCacheConfirm: false });
        try{
            await api.clearThumbnailCache();
        }catch(err){
            get().showToast(describeError(err));
            return;
        }
        await get().loadStorage();
        get().showToast(t("toast.thumbsCleared"));
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

    requestDelete(){
        if(get().selectedIds.size > 0){
            set({ deleteConfirm: true });
        }
    },

    cancelDelete(){
        set({ deleteConfirm: false });
    },

    async deleteSelected(){
        const ids = [...get().selectedIds];
        set({ deleteConfirm: false });
        if(ids.length === 0){
            return;
        }
        let res;
        try{
            res = await api.deletePhotos(ids);
        }catch(err){
            // The selection stays, so the user can retry.
            get().showToast(describeError(err));
            return;
        }
        // Exactly the ones the trash refused stay selected.
        const failed = new Set(res.failed);
        set({
            selectedIds: new Set(ids.filter((id) => failed.has(id))),
            collectionMenuOpen: false,
        });
        await get().loadCounts();
        // Deleting around row 400 must not collapse the grid to page one.
        await get().runSearch({ keepLoaded: true });
        const moved = t("toast.trashed", { n: res.removed });
        get().showToast(
            failed.size > 0 ? t("toast.trashedPartial", { moved, failed: failed.size }) : moved,
        );
    },

    async revealSelected(){
        const ids = [...get().selectedIds];
        try{
            await api.revealInFiles(ids);
        }catch(err){
            get().showToast(describeError(err));
            return;
        }
        get().showToast(t("toast.revealing"));
    },

    toggleCollectionMenu(){
        set((s) => ({
            collectionMenuOpen: !s.collectionMenuOpen,
            addingCollection: false,
            newCollectionName: "",
        }));
    },

    async addSelectionToCollection(id){
        await get().addPhotosToCollection(id, [...get().selectedIds]);
    },

    async addPhotosToCollection(id, ids){
        const name = get().collections.find((c) => c.id === id)?.name ?? "collection";
        if(ids.length === 0){
            set({ collectionMenuOpen: false });
            return;
        }
        try{
            await api.addToCollection(id, [...ids]);
        }catch(err){
            get().showToast(describeError(err));
            return;
        }finally{
            set({ collectionMenuOpen: false });
        }
        // Only the photos that went in leave the selection: filing one photo
        // from the lightbox must not drop the forty others the user picked.
        const moved = new Set(ids);
        set((st) => {
            const left = [...st.selectedIds].filter((i) => !moved.has(i));
            return left.length === st.selectedIds.size ? {} : { selectedIds: new Set(left) };
        });
        // The rows carry `collections`, so the grid is stale until it refetches.
        await get().loadCounts();
        await get().runSearch({ keepLoaded: true });
        get().showToast(t("toast.itemsAdded", { n: ids.length, name }));
    },
}));

/**
 * Which of the five grid states the main area should render.
 *
 * A selection is deliberately **not** one of them. It used to be, and nothing
 * ever consumed it while three things silently broke on the first hold: the
 * mode is a dependency of the layout, so selecting a photo rebuilt the sections
 * (month headers gone, sticky label gone) and reset the scroll to the top; and
 * during a search it made the header read "All photos" with the result count
 * removed. Selection is chrome — the selection bar, the checkmarks — never
 * layout.
 */
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
    return isSearch ? "results" : "idle";
}

/**
 * What the user asked for, as one comparable string — query, view, collection,
 * similar-to and every filter.
 *
 * The grid resets its scroll when *this* changes, never when `results` changes
 * identity. `runSearch` re-runs on a watcher `scan-complete`, on a model swap
 * landing and after a collection edit, and each one hands back a fresh array
 * for a query nobody retyped: keyed on the array, a background rescan yanked a
 * user who was halfway down their library back to the top.
 */
export function searchKey(s: State): string{
    const f = s.filters;
    return [
        s.query.trim(),
        s.libraryView ?? "",
        s.activeCollection ?? "",
        // The path too: two dropped files are both id -1.
        s.similarTo === null ? "" : `${s.similarTo.id}:${s.similarTo.path}`,
        // A new order is a different question: the top of the list is
        // somewhere else entirely.
        activeSort(s),
        f.datePreset ?? "",
        f.dateFrom ?? "",
        f.dateTo ?? "",
        f.dims ?? "",
        f.types.join("+"),
        f.folders.join("+"),
        // NUL between the fields, not a space: the query is free text and
        // could otherwise spell the next field's value and collide with it.
    ].join("\u0000");
}

/** The order on screen: the session's query sort while one is typed, the
 *  persisted browse sort otherwise. "find similar" is always by similarity. */
export function activeSort(s: State): SearchSort{
    if(s.similarTo !== null){
        return "relevance";
    }
    return s.query.trim() !== "" ? s.searchSort : s.settings.sort;
}

/** Date headers, the pinned label and the scrubber exist exactly when the
 *  order is by date. One predicate, so the three can never disagree. */
export function sectionsByDate(s: State): boolean{
    return isDateSort(activeSort(s));
}

/** The request `runSearch`, `loadMore` and the timeline all send. */
function currentQuery(s: State): SearchQuery{
    return {
        q: s.query,
        view: s.activeCollection === null ? s.libraryView : null,
        collection: s.activeCollection,
        filters: s.filters,
        sort: activeSort(s),
        limit: s.settings.pageSize,
        weak: s.weakKey !== null && s.weakKey === searchKey(s),
    };
}

/**
 * Where the open photo and the focused cell sit in a fresh result.
 *
 * A refresh inserts and removes rows, so an index into the old list would show
 * a different photo — or, past the end, leave the lightbox "open" but rendering
 * nothing, with the grid's keys dead until Esc. Both are re-found by id. Index
 * order here is `layout.flat` order, which equals `results` order outside the
 * loading skeletons.
 */
function reanchor(cur: State, items: readonly Photo[], keepFocus: boolean){
    const find = (i: number | null): number => {
        const id = i === null ? undefined : cur.results[i]?.id;
        return id === undefined ? -1 : items.findIndex((p) => p.id === id);
    };
    let lightboxIndex = cur.lightboxIndex;
    if(lightboxIndex !== null){
        const moved = find(lightboxIndex);
        if(moved >= 0){
            lightboxIndex = moved;
        }else if(cur.results[lightboxIndex] === undefined || items.length === 0){
            lightboxIndex = null;
        }else{
            // The photo itself is gone: show whatever now sits in its place.
            lightboxIndex = Math.min(lightboxIndex, items.length - 1);
        }
    }
    return {
        lightboxIndex,
        lightboxFullscreen: lightboxIndex === null ? false : cur.lightboxFullscreen,
        focusedIndex: keepFocus ? find(cur.focusedIndex) : -1,
    };
}

/** Append up to `limit` more rows. False when nothing was appended — stale,
 *  in flight, exhausted or failed — so a loop over it always terminates. */
async function fetchMore(limit: number): Promise<boolean>{
    const s = useStore.getState();
    if(s.cursor === null || s.loadingMore || s.searching || s.similarTo !== null){
        return false;
    }
    // Shares the search's sequence without advancing it: a page that lands
    // after the user asked something new belongs to the old question.
    const seq = searchSeq;
    useStore.setState({ loadingMore: true });
    try{
        const res = await api.search({ ...currentQuery(s), limit, cursor: s.cursor });
        if(seq !== searchSeq){
            return false;
        }
        const cur = useStore.getState();
        // Offset paging shifts when the watcher inserts a row mid-scroll, so a
        // page can repeat the tail of the last one. A duplicate id would be two
        // cells for one photo, and two cells with one React key.
        const seen = new Set(cur.results.map((p) => p.id));
        const fresh = res.items.filter((p) => !seen.has(p.id));
        useStore.setState({
            results: fresh.length > 0 ? [...cur.results, ...fresh] : cur.results,
            total: res.total,
            cursor: res.cursor,
            loadingMore: false,
        });
        return fresh.length > 0 || res.cursor !== null;
    }catch(err){
        if(seq === searchSeq){
            // The cursor goes with the failure. Left in place, the load-more
            // effect sees `loadingMore` fall, fires again, fails again — with
            // the sidecar gone that is a request storm pinned to a CPU core.
            // The next `runSearch` brings the cursor back.
            useStore.setState({ loadingMore: false, cursor: null, backendError: describeError(err) });
        }
        return false;
    }
}
