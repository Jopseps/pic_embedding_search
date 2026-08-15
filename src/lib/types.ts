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
    takenAt: string | null;
    isScreenshot: boolean;
    /** null until OCR lands (build step 8); false is a real answer, null is "unknown". */
    hasOcr: boolean;
    ocrText: string | null;
    /** FTS5 highlight fragment, null for vector-only hits. */
    snippet: string | null;
    /** RRF fusion score — ~0.016 for a rank-1 hit, not a cosine. Absent when browsing. */
    score?: number;
    isDupe: boolean;
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

export interface Filters{
    datePreset: DatePreset | null;
    folders: string[];
    types: PhotoKind[];
    dims: DimsFilter | null;
}

export type DatePreset = "today" | "week" | "month" | "year";
export type PhotoKind = "Photo" | "Screenshot";
export type DimsFilter = "large" | "small";

export interface SearchQuery{
    q: string;
    view: LibraryView | null;
    collection: string | null;
    filters: Filters;
    limit?: number;
    cursor?: string | null;
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
    modelName: string;
}

export interface StorageUsage{
    /** Gigabytes. */
    thumbnailCacheGb: number;
    indexGb: number;
}

export interface Collection{
    id: string;
    name: string;
}

export interface SavedSearch{
    id: string;
    query: string;
}

export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
/** Index into GRID_ROW_HEIGHTS. */
export type Density = 0 | 1 | 2;

export interface Settings{
    modelId: string;
    ocrEngineId: string;
    ocrLangs: string[];
    theme: ThemePref;
    density: Density;
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
    | { type: "error"; message: string };

/** Which of the six grid states the main area is in. */
export type GridMode =
    | "idle"
    | "results"
    | "loading"
    | "emptySearch"
    | "emptyLibrary"
    | "selection";
