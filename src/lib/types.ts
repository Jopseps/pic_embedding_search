/**
 * Wire types. These mirror the `/search` response shape frozen in
 * ARCHITECTURE.md — the mock adapter and the real sidecar both satisfy them, so
 * swapping one for the other is a one-line change in api.ts.
 */

export interface Photo{
    id: number;
    path: string;
    filename: string;
    folder: string;
    /** Populated at index time. The justified-rows layout needs these before
     *  any image loads, so they are never read off the thumbnail. */
    width: number;
    height: number;
    mime: string;
    /** Naive local wall-clock ISO (`2026-05-30T21:36:45`) — `new Date()` reads
     *  it as local, which is what it is. null only when nothing yielded a date. */
    takenAt: string | null;
    /** Where `takenAt` came from. "mtime" is a guess — the lightbox says
     *  "Modified" for it rather than "Taken". */
    dateSource: DateSource | null;
    isScreenshot: boolean;
    /** null until OCR lands (build step 8); false is a real answer, null is "unknown". */
    hasOcr: boolean;
    ocrText: string | null;
    /** FTS5 highlight fragment, null for vector-only hits. */
    snippet: string | null;
    /** RRF fusion score — ~0.016 for a rank-1 hit, not a cosine. Absent when browsing. */
    score?: number;
    /** In a pHash near-duplicate group of two or more. Never a cosine result —
     *  see `dupes.py` for why those are different questions. */
    isDupe: boolean;
    /** Collection **ids**, not names, so a rename cannot drop membership. */
    collections: string[];
}

export interface SearchResponse{
    items: Photo[];
    total: number;
    /** Server-reported query time in milliseconds. */
    tookMs: number;
    cursor: string | null;
}

export type LibraryView = "all" | "recent" | "dupes";

/** `DELETE /images`: how many files went to the trash, and the ids that could not. */
export interface DeleteResult{
    removed: number;
    failed: number[];
}

export interface Filters{
    datePreset: DatePreset | null;
    /** Inclusive `YYYY-MM-DD` bounds; either end may be open. Exclusive with
     *  `datePreset` — setting one clears the other. */
    dateFrom: string | null;
    dateTo: string | null;
    folders: string[];
    types: PhotoKind[];
    dims: DimsFilter | null;
}

export type DatePreset = "today" | "week" | "month" | "year";
export type DateSource = "exif" | "filename" | "mtime";
/** The browse orders. A query adds "relevance", which is never persisted. */
export type SortKey = "date-desc" | "date-asc" | "name-asc" | "name-desc" | "size-desc" | "size-asc";
export type SearchSort = SortKey | "relevance";
export type GroupBy = "day" | "month" | "year";
export type PhotoKind = "Photo" | "Screenshot";
export type DimsFilter = "large" | "small";

export interface SearchQuery{
    q: string;
    view: LibraryView | null;
    collection: string | null;
    filters: Filters;
    sort?: SearchSort;
    limit?: number;
    cursor?: string | null;
}

/** `GET /timeline`: photos per month, in the order the grid lists them, for
 *  the whole result — including the pages not loaded yet. Empty unless the
 *  sort is by date. */
export interface Timeline{
    buckets: { month: string; count: number }[];
    undated: number;
}

export interface WatchedFolder{
    path: string;
    count: number;
    recursive: boolean;
}

export interface EmbeddingModel{
    id: string;
    name: string;
    desc: string;
    /** Multilingual models are the only ones that answer Turkish queries.
     *  See CLAUDE.md — do not offer an English-only model as the default. */
    multilingual: boolean;
    dim: number;
}

export interface OcrEngine{
    id: string;
    label: string;
    desc: string;
}

export interface OcrLanguage{
    code: string;
    label: string;
}

export interface IndexingStatus{
    current: number;
    total: number;
    /** Images per second. */
    rate: number;
    etaSec: number;
    paused: boolean;
    currentFile: string;
}

export interface ReindexStatus{
    active: boolean;
    /** 0–100. */
    progress: number;
    /** Display name of the model being embedded, resolved from the catalog. */
    modelName: string;
    /** Images embedded so far, and how many need it. Measured, not estimated. */
    current: number;
    total: number;
    /** Images per second, from the batches that have actually landed. */
    rate: number;
    etaSec: number;
}

/**
 * Sidebar counts, over the whole library.
 *
 * These used to be read off the last search response, so "All" showed however
 * many results the current query returned and "Duplicates" counted only the
 * loaded window. Both lied the moment anyone typed.
 */
export interface LibraryCounts{
    library: number;
    recent: number;
    dupes: number;
    /** Collection id → member count. */
    collections: Record<string, number>;
}

export interface StorageUsage{
    /** Gigabytes. */
    thumbnailCacheGb: number;
    indexGb: number;
}

/** What OCR is actually running, and what to install when that is less than
 *  what Settings asked for. `hint` is shown verbatim. */
export interface OcrStatus{
    engine: string | null;
    langs: string | null;
    hint: string | null;
}

export interface Collection{
    id: string;
    name: string;
}

/**
 * The whole search, not just the words. `filters` and `view` ride along so
 * running a saved search restores what was on screen when it was saved.
 */
export interface SavedSearch{
    id: string;
    query: string;
    view: LibraryView | null;
    collection: string | null;
    filters: Filters;
}

export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
/** Index into GRID_ROW_HEIGHTS. */
export type Density = 0 | 1 | 2;
/** Percent. One of `UI_SCALES` — presets, not a slider, so every layout the
 *  app can be in has been looked at. */
export type UiScale = number;

export interface EditorFont{
    id: string;
    label: string;
    /** Written to `--font-ui`. The first family is the one being offered; the
     *  rest are the fallback chain when it is not installed. */
    stack: string;
    /** Monospace fonts drive the `font-mono` utilities too — paths and
     *  filenames must not fall back to a *different* mono than the UI. A
     *  proportional choice leaves them on the system monospace. */
    mono: boolean;
    desc: string;
}

export interface Settings{
    /** The model **answering searches right now**. During a swap this is still
     *  the outgoing one — it only moves when the incoming model can answer. */
    modelId: string;
    ocrEngineId: string;
    ocrLangs: string[];
    theme: ThemePref;
    density: Density;
    /** Id in `FONTS`. Nothing is bundled: the font has to be installed on the
     *  machine, and the picker says so when it is not. */
    fontId: string;
    uiScale: UiScale;
    reduceMotion: boolean;
    highContrast: boolean;

    // ---- colour ----------------------------------------------------------
    /** Accent hue in OKLCH degrees, 0–360. Only the *hue* is a preference: the
     *  lightness and chroma of `--accent` / `--accent-muted` / `--accent-text`
     *  stay per-theme, which is what keeps a custom accent legible in light,
     *  dark and high contrast without four sets of numbers to pick. */
    accentHue: number;
    /** Hue of the greys. The surfaces, the border and the text carry a trace of
     *  chroma — 0.002–0.005 — and this is the direction it points in. */
    tintHue: number;
    /** How much of that trace to keep, as a percent. 100 is what the app
     *  shipped with, 0 is a pure neutral grey, 300 is an openly tinted UI. */
    tintStrength: number;

    // ---- grid ------------------------------------------------------------
    /** Frame drawn around a selected cell, px at 100% UI scale. Capped at the
     *  grid gutter: wider than that and two adjacent selected cells merge into
     *  one accent field with photos floating in it. */
    selectionBorder: number;
    /** Thumbnail corner radius, px at 100% UI scale. 0 is square. */
    cellRadius: number;

    // ---- gestures --------------------------------------------------------
    /** How long a press on a photo has to last before it selects instead of
     *  opening. */
    holdMs: number;
    /** Movement past this many pixels is a drag, not a click. */
    dragSlop: number;

    // ---- search ----------------------------------------------------------
    /** Rows fetched per query. */
    pageSize: number;
    /** Idle time after the last keystroke before the query is sent. */
    searchDebounceMs: number;
    /** Balance between the two ranked legs of the hybrid search, 0–100. 50
     *  weights them equally, which is exactly the unweighted RRF the sidecar
     *  has always run; 100 is OCR text only, 0 is visual only. This weights
     *  *ranks*, never scores — cosine and BM25 still share no scale. */
    textWeight: number;

    // ---- order -----------------------------------------------------------
    /** The browse order. A query starts at relevance whatever this says. */
    sort: SortKey;
    /** Date headers group by this while the sort is by date. */
    groupBy: GroupBy;
    /** How many of the best matches a query keeps when it is re-sorted by
     *  date, name or size. Every image is ranked, so without a cut the
     *  "sorted results" would be the whole library. */
    sortedSearchKeep: number;
}

/** `GET/PUT /settings`. `pendingModelId` is the swap in flight, if any. */
export interface SettingsResponse extends Settings{
    pendingModelId: string | null;
    pendingCoverage: { done: number; total: number };
}

/**
 * Server-sent events from the sidecar's `/events` stream. The index and
 * reindex payloads are the wire form of `IndexingStatus` / `ReindexStatus`, so
 * the store can apply them without translation.
 */
export type SidecarEvent =
    | ({ type: "index"; running: boolean } & IndexingStatus)
    | ({ type: "reindex" } & ReindexStatus)
    | {
        type: "scan-complete";
        scanned: number;
        ingested: number;
        skipped: number;
        embedded: number;
        /** Screenshots read by OCR. A backfill emits this with nothing else. */
        ocred: number;
        removed: number;
        errors: number;
    }
    /** The swap completed and the active model moved. */
    | { type: "model-changed"; modelId: string }
    /** Every row's date was re-derived under new rules; the order moved. */
    | { type: "dates-refreshed"; count: number }
    /** Raised by the client, not the sidecar: the stream dropped and came back. */
    | { type: "reconnected" }
    | { type: "error"; message: string };

/**
 * Which of the five grid states the main area is in.
 *
 * There is no "selection" state: a selection changes the chrome, never what the
 * grid lays out. See `gridMode` in store.ts for what that cost.
 */
export type GridMode =
    | "idle"
    | "results"
    | "loading"
    | "emptySearch"
    | "emptyLibrary";
