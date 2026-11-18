import type {
    Collection,
    DeleteResult,
    Filters,
    LibraryCounts,
    Photo,
    SavedSearch,
    ModelsResponse,
    SearchQuery,
    SearchResponse,
    SearchSort,
    Settings,
    SettingsResponse,
    SidecarEvent,
    OcrStatus,
    StorageUsage,
    Timeline,
    WatchedFolder,
} from "./types";
import { buildMockLibrary, type MockPhoto } from "./mockData";
import {
    DEFAULT_ACCENT_HUE,
    DEFAULT_CELL_RADIUS,
    DEFAULT_DRAG_SLOP,
    DEFAULT_FONT_ID,
    DEFAULT_HOLD_MS,
    DEFAULT_MODEL_ID,
    DEFAULT_OCR_ENGINE_ID,
    DEFAULT_OCR_LANGS,
    DEFAULT_PAGE_SIZE,
    DEFAULT_SEARCH_DEBOUNCE_MS,
    DEFAULT_SELECTION_BORDER,
    DEFAULT_GROUP_BY,
    DEFAULT_SORT,
    DEFAULT_MATCH_STRICTNESS,
    DEFAULT_SORTED_SEARCH_KEEP,
    DEFAULT_TEXT_WEIGHT,
    DEFAULT_TINT_HUE,
    DEFAULT_TINT_STRENGTH,
    DEFAULT_UI_SCALE,
    EMBEDDING_MODELS,
} from "./catalog";
import { pickFolder } from "./tauri";

/**
 * The single seam between UI and backend.
 *
 * `MockApi` runs today with the fixture library so the whole interface is
 * exercisable without Python. `HttpApi` is the real one — it talks to the
 * FastAPI sidecar on 127.0.0.1 with the token handshake described in
 * CLAUDE.md. Swapping them is the one-line change in `resolveApi()`.
 */
export interface PhotoSearchApi{
    search(query: SearchQuery): Promise<SearchResponse>;
    /** Photos per month for the same query, over every page. */
    timeline(query: SearchQuery): Promise<Timeline>;
    /** Neighbours of an indexed photo, narrowed by the same filters a search takes. */
    similar(id: number, filters: Filters): Promise<SearchResponse>;
    /** Neighbours of an image file outside the library, by its path on disk.
     *  The file is read, never added. Rejects with the sidecar's message when
     *  it is not an image. */
    similarToFile(path: string, filters: Filters): Promise<SearchResponse>;
    thumbUrl(id: number, size: 256 | 512): string | null;
    fileUrl(id: number): string | null;
    listFolders(): Promise<WatchedFolder[]>;
    addFolder(): Promise<WatchedFolder | null>;
    /** Stops watching and drops the folder's photos from the library. Files stay on disk. */
    removeFolder(path: string): Promise<void>;
    setFolderRecursive(path: string, recursive: boolean): Promise<void>;
    counts(): Promise<LibraryCounts>;
    getSettings(): Promise<SettingsResponse>;
    /** Partial update. A new `modelId` starts a background swap; it does not
     *  take effect until the incoming model can answer a query. */
    putSettings(patch: Partial<Settings>): Promise<SettingsResponse>;
    /** What is on disk for every model, and the download in flight. */
    models(): Promise<ModelsResponse>;
    /** Starts a download; progress arrives as `model-download` events. */
    downloadModel(id: string): Promise<void>;
    /** Deletes the model's files. Its index data stays. Rejects for the active model. */
    deleteModel(id: string): Promise<void>;
    listCollections(): Promise<Collection[]>;
    createCollection(name: string): Promise<Collection>;
    deleteCollection(id: string): Promise<void>;
    addToCollection(id: string, imageIds: number[]): Promise<void>;
    removeFromCollection(id: string, imageIds: number[]): Promise<void>;
    listSavedSearches(): Promise<SavedSearch[]>;
    saveSearch(query: SearchQuery): Promise<SavedSearch>;
    deleteSavedSearch(id: string): Promise<void>;
    storage(): Promise<StorageUsage>;
    ocrStatus(): Promise<OcrStatus>;
    clearThumbnailCache(): Promise<void>;
    revealInFiles(ids: number[]): Promise<void>;
    openExternally(id: number): Promise<void>;
    /** Moves the files to the system trash, then drops them from the library. */
    deletePhotos(ids: number[]): Promise<DeleteResult>;
    /** Session-only: work stops between files and resumes where it stopped. */
    setIndexingPaused(paused: boolean): Promise<void>;
    /** Live indexing progress. Returns an unsubscribe function. */
    subscribeEvents(handler: (event: SidecarEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function matches(item: MockPhoto, query: string): boolean{
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if(words.length === 0){
        return true;
    }
    const hay = [
        item.tags.join(" "),
        item.filename,
        item.ocrText ?? "",
    ].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
}

const NO_FILTERS: Filters = {
    datePreset: null, dateFrom: null, dateTo: null, folders: [], types: [], dims: null,
};

const DAY_MS = 86_400_000;
const DATE_PRESET_DAYS: Record<string, number> = {
    today: 1,
    week: 7,
    month: 30,
    year: 365,
};

/** How many mock rows count as strong matches for a query. */
const MOCK_STRONG = 12;

function applyScope(items: MockPhoto[], query: SearchQuery): MockPhoto[]{
    let out = items;

    if(query.collection !== null){
        out = out.filter((it) => it.collections.includes(query.collection as string));
    }else if(query.view === "recent"){
        const cutoff = Date.now() - 7 * DAY_MS;
        out = out.filter((it) => it.takenMs >= cutoff);
    }else if(query.view === "dupes"){
        out = out.filter((it) => it.isDupe);
    }

    const f = query.filters;
    if(f.folders.length > 0){
        out = out.filter((it) => f.folders.includes(it.folder));
    }
    if(f.types.length > 0){
        out = out.filter((it) => f.types.includes(it.isScreenshot ? "Screenshot" : "Photo"));
    }
    if(f.datePreset !== null){
        const days = DATE_PRESET_DAYS[f.datePreset];
        if(days !== undefined){
            const cutoff = Date.now() - days * DAY_MS;
            out = out.filter((it) => it.takenMs >= cutoff);
        }
    }
    // Inclusive days, compared on the naive local string like the sidecar's SQL.
    if(f.dateFrom !== null){
        const from = f.dateFrom;
        out = out.filter((it) => it.takenAt !== null && it.takenAt >= from);
    }
    if(f.dateTo !== null){
        const to = `${f.dateTo}T99`;
        out = out.filter((it) => it.takenAt !== null && it.takenAt < to);
    }
    if(f.dims === "large"){
        out = out.filter((it) => Math.max(it.width, it.height) >= 2500);
    }else if(f.dims === "small"){
        out = out.filter((it) => Math.max(it.width, it.height) < 2500);
    }

    return out;
}

function strip(item: MockPhoto): Photo{
    const { tags: _tags, takenMs: _takenMs, sizeBytes: _sizeBytes, ...rest } = item;
    return rest;
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The sidecar's `SORT_SQL`: undated last either way, id breaks every tie. */
function compareBy(sort: Exclude<SearchSort, "relevance">): (a: MockPhoto, b: MockPhoto) => number{
    const dir = sort.endsWith("-asc") ? 1 : -1;
    return (a, b) => {
        let d = 0;
        if(sort.startsWith("date")){
            if((a.takenAt === null) !== (b.takenAt === null)){
                return a.takenAt === null ? 1 : -1;
            }
            d = (a.takenAt ?? "").localeCompare(b.takenAt ?? "");
        }else if(sort.startsWith("name")){
            d = nameCollator.compare(a.filename, b.filename);
        }else{
            d = a.sizeBytes - b.sizeBytes;
        }
        return (d === 0 ? a.id - b.id : d) * dir;
    };
}

/** The sort that applies: relevance only exists with a query. */
function effectiveSort(query: SearchQuery): SearchSort{
    const q = query.q.trim();
    if(query.sort === undefined || (query.sort === "relevance" && q === "")){
        return q === "" ? DEFAULT_SORT : "relevance";
    }
    return query.sort;
}

export class MockApi implements PhotoSearchApi{
    private items = buildMockLibrary();
    private folders: WatchedFolder[] = [
        { path: "~/Pictures", count: 1842, recursive: true },
        { path: "~/Pictures/Screenshots", count: 967, recursive: true },
        { path: "~/Downloads/Screenshots", count: 432, recursive: false },
    ];
    private cacheGb = 1.4;
    // Ids match the ones `mockData.ts` stamps onto `Photo.collections`, so the
    // fixture library starts with two collections that actually have members.
    private collections: Collection[] = [
        { id: "refs", name: "Refs" },
        { id: "memes", name: "Memes" },
    ];
    private saved: SavedSearch[] = [
        { id: "s1", query: "dark code editor", view: null, collection: null, filters: NO_FILTERS },
        { id: "s2", query: "receipts", view: null, collection: null, filters: NO_FILTERS },
        { id: "s3", query: "masa", view: null, collection: null, filters: NO_FILTERS },
    ];
    private nextCollectionId = 1;
    private nextSavedId = 4;
    private settings: Settings = {
        modelId: DEFAULT_MODEL_ID,
        ocrEngineId: DEFAULT_OCR_ENGINE_ID,
        ocrLangs: [...DEFAULT_OCR_LANGS],
        theme: "dark",
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
        matchStrictness: DEFAULT_MATCH_STRICTNESS,
        sort: DEFAULT_SORT,
        groupBy: DEFAULT_GROUP_BY,
        sortedSearchKeep: DEFAULT_SORTED_SEARCH_KEEP,
    };

    /** The ordered result, before paging — `search` and `timeline` share it. */
    private ordered(query: SearchQuery): { it: MockPhoto; score?: number }[]{
        let scoped = applyScope(this.items, query);
        const q = query.q.trim();
        if(q !== ""){
            scoped = scoped.filter((it) => matches(it, q));
        }
        // Stand-in for the RRF score the sidecar returns.
        let rows = scoped.map((it, i) => (
            q === "" ? { it } : { it, score: Math.max(0.05, 0.92 - i * 0.004) }
        ));
        const sort = effectiveSort(query);
        if(sort !== "relevance"){
            // A re-sorted query keeps its best matches only, like the sidecar.
            if(q !== ""){
                rows = rows.slice(0, this.settings.sortedSearchKeep);
            }
            const cmp = compareBy(sort);
            rows.sort((a, b) => cmp(a.it, b.it));
        }
        return rows;
    }

    async search(query: SearchQuery): Promise<SearchResponse>{
        const started = performance.now();
        let all = this.ordered(query).map(({ it, score }) => (
            score === undefined ? strip(it) : { ...strip(it), score }
        ));
        // Stand-in for the sidecar's cutoff: the first MOCK_STRONG rows are the
        // matches, the rest wait behind "show less relevant".
        let weak = 0;
        if(query.q.trim() !== "" && this.settings.matchStrictness > 0 && query.weak !== true){
            weak = Math.max(0, all.length - MOCK_STRONG);
            all = all.slice(0, MOCK_STRONG);
        }

        // Paged like the sidecar pages, rather than always handing back the
        // whole fixture library: the page-size setting has to be visible in
        // mock mode too, or it reads as broken in the build most UI work
        // happens in.
        const offset = Number(query.cursor ?? 0) || 0;
        const limit = query.limit ?? DEFAULT_PAGE_SIZE;
        const items = all.slice(offset, offset + limit);
        const consumed = offset + items.length;

        return {
            items,
            total: all.length,
            tookMs: Math.round(performance.now() - started) + 8,
            cursor: consumed < all.length ? String(consumed) : null,
            weak,
        };
    }

    async timeline(query: SearchQuery): Promise<Timeline>{
        const sort = effectiveSort(query);
        if(sort !== "date-desc" && sort !== "date-asc"){
            return { buckets: [], undated: 0 };
        }
        const buckets: { month: string; count: number }[] = [];
        let undated = 0;
        for(const { it } of this.ordered(query)){
            if(it.takenAt === null){
                undated++;
                continue;
            }
            const month = it.takenAt.slice(0, 7);
            const last = buckets[buckets.length - 1];
            if(last !== undefined && last.month === month){
                last.count++;
            }else{
                buckets.push({ month, count: 1 });
            }
        }
        return { buckets, undated };
    }

    private neighbours(target: MockPhoto | undefined, filters: Filters): SearchResponse{
        const started = performance.now();
        if(target === undefined){
            return { items: [], total: 0, tookMs: 0, cursor: null };
        }
        const pool = applyScope(
            this.items.filter((it) => it.id !== target.id),
            { q: "", view: null, collection: null, filters },
        );
        const scored = pool
            .map((it) => {
                const shared = it.tags.filter((t) => target.tags.includes(t)).length;
                const aspectDelta = Math.abs(it.width / it.height - target.width / target.height);
                return { it, s: shared * 2 - aspectDelta };
            })
            .sort((a, b) => b.s - a.s)
            .slice(0, 60);

        return {
            items: scored.map(({ it, s }) => ({ ...strip(it), score: s })),
            total: scored.length,
            tookMs: Math.round(performance.now() - started) + 6,
            cursor: null,
        };
    }

    async similar(id: number, filters: Filters): Promise<SearchResponse>{
        return this.neighbours(this.items.find((it) => it.id === id), filters);
    }

    /** There are no bytes to read in a browser, so any image name resolves to a
     *  fixed stand-in photo; a non-image is refused the way the sidecar refuses it. */
    async similarToFile(path: string, filters: Filters): Promise<SearchResponse>{
        if(!/\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i.test(path)){
            throw new Error("sidecar 415: not a supported image");
        }
        return this.neighbours(this.items[path.length % this.items.length], filters);
    }

    /** No real bytes in mock mode — cells fall back to their placeholder fill. */
    thumbUrl(): string | null{
        return null;
    }

    fileUrl(): string | null{
        return null;
    }

    async listFolders(): Promise<WatchedFolder[]>{
        return this.folders;
    }

    async addFolder(): Promise<WatchedFolder | null>{
        return null;
    }

    async removeFolder(path: string): Promise<void>{
        this.folders = this.folders.filter((f) => f.path !== path);
        // Photos a remaining folder still covers stay, like the sidecar's rule.
        const covered = (it: MockPhoto) => this.folders.some((f) => (
            it.folder === f.path || (f.recursive && it.folder.startsWith(`${f.path}/`))
        ));
        const under = (it: MockPhoto) => it.folder === path || it.folder.startsWith(`${path}/`);
        this.items = this.items.filter((it) => !under(it) || covered(it));
    }

    async setFolderRecursive(path: string, recursive: boolean): Promise<void>{
        this.folders = this.folders.map((f) => f.path === path ? { ...f, recursive } : f);
    }

    async counts(): Promise<LibraryCounts>{
        const week = Date.now() - 7 * DAY_MS;
        const members: Record<string, number> = {};
        for(const c of this.collections){
            members[c.id] = this.items.filter((it) => it.collections.includes(c.id)).length;
        }
        return {
            library: this.items.length,
            recent: this.items.filter((it) => it.takenMs >= week).length,
            dupes: this.items.filter((it) => it.isDupe).length,
            collections: members,
        };
    }

    async getSettings(): Promise<SettingsResponse>{
        return { ...this.settings, pendingModelId: null, pendingCoverage: { done: 0, total: 0 } };
    }

    async putSettings(patch: Partial<Settings>): Promise<SettingsResponse>{
        // A swap is instant here: there is no GPU and no coverage to reach.
        this.settings = { ...this.settings, ...patch };
        return this.getSettings();
    }

    /** Model ids on "disk" in the mock, and how big they are. */
    private modelFiles = new Map<string, number>([
        ["siglip2-base-patch16-224", 0.5 * 1024 ** 3],
        ["siglip2-so400m-patch14-384", 3.4 * 1024 ** 3],
    ]);

    async models(): Promise<ModelsResponse>{
        return {
            models: EMBEDDING_MODELS.map((m) => ({
                id: m.id,
                downloaded: this.modelFiles.has(m.id),
                sizeBytes: this.modelFiles.get(m.id) ?? 0,
                active: m.id === this.settings.modelId,
                pending: false,
            })),
            download: null,
        };
    }

    async downloadModel(id: string): Promise<void>{
        this.modelFiles.set(id, 1.6 * 1024 ** 3);
    }

    async deleteModel(id: string): Promise<void>{
        if(id === this.settings.modelId){
            throw new Error("sidecar 409: this model is in use; switch to another first");
        }
        this.modelFiles.delete(id);
    }

    async listCollections(): Promise<Collection[]>{
        return this.collections;
    }

    async createCollection(name: string): Promise<Collection>{
        const existing = this.collections.find((c) => c.name === name);
        if(existing !== undefined){
            return existing;   // the sidecar's name column is UNIQUE too
        }
        const made = { id: `c${this.nextCollectionId++}`, name };
        this.collections = [...this.collections, made];
        return made;
    }

    async deleteCollection(id: string): Promise<void>{
        this.collections = this.collections.filter((c) => c.id !== id);
        this.items = this.items.map((it) => (
            it.collections.includes(id)
                ? { ...it, collections: it.collections.filter((c) => c !== id) }
                : it
        ));
    }

    async addToCollection(id: string, imageIds: number[]): Promise<void>{
        const add = new Set(imageIds);
        this.items = this.items.map((it) => (
            add.has(it.id) && !it.collections.includes(id)
                ? { ...it, collections: [...it.collections, id] }
                : it
        ));
    }

    async removeFromCollection(id: string, imageIds: number[]): Promise<void>{
        const drop = new Set(imageIds);
        this.items = this.items.map((it) => (
            drop.has(it.id)
                ? { ...it, collections: it.collections.filter((c) => c !== id) }
                : it
        ));
    }

    async listSavedSearches(): Promise<SavedSearch[]>{
        return this.saved;
    }

    async saveSearch(query: SearchQuery): Promise<SavedSearch>{
        const made: SavedSearch = {
            id: `s${this.nextSavedId++}`,
            query: query.q,
            view: query.view,
            collection: query.collection,
            filters: query.filters,
        };
        this.saved = [...this.saved, made];
        return made;
    }

    async deleteSavedSearch(id: string): Promise<void>{
        this.saved = this.saved.filter((s) => s.id !== id);
    }

    async storage(): Promise<StorageUsage>{
        return { thumbnailCacheGb: this.cacheGb, indexGb: 0.34 };
    }

    async ocrStatus(): Promise<OcrStatus>{
        return { engine: this.settings.ocrEngineId, langs: "eng+tur", hint: null };
    }

    async clearThumbnailCache(): Promise<void>{
        this.cacheGb = 0;
    }

    async revealInFiles(): Promise<void>{}
    async openExternally(): Promise<void>{}

    async deletePhotos(ids: number[]): Promise<DeleteResult>{
        const drop = new Set(ids);
        const removed = this.items.filter((it) => drop.has(it.id)).length;
        this.items = this.items.filter((it) => !drop.has(it.id));
        return { removed, failed: [] };
    }

    /** The store simulates progress in mock mode and owns the flag. */
    async setIndexingPaused(): Promise<void>{}

    /** No sidecar, no events — the store simulates progress in mock mode. */
    subscribeEvents(): () => void{
        return () => {};
    }
}

// ---------------------------------------------------------------------------
// HTTP adapter (real sidecar)
// ---------------------------------------------------------------------------

/** `SearchQuery` as `/search` and `/timeline` query parameters. */
function queryParams(query: SearchQuery): URLSearchParams{
    const p = new URLSearchParams();
    p.set("q", query.q);
    if(query.view !== null){
        p.set("view", query.view);
    }
    if(query.collection !== null){
        p.set("collection", query.collection);
    }
    if(query.filters.datePreset !== null){
        p.set("date", query.filters.datePreset);
    }
    if(query.filters.dateFrom !== null){
        p.set("from", query.filters.dateFrom);
    }
    if(query.filters.dateTo !== null){
        p.set("to", query.filters.dateTo);
    }
    if(query.filters.dims !== null){
        p.set("dims", query.filters.dims);
    }
    for(const f of query.filters.folders){
        p.append("folder", f);
    }
    for(const t of query.filters.types){
        p.append("type", t);
    }
    if(query.sort !== undefined){
        p.set("sort", query.sort);
    }
    if(query.limit !== undefined){
        p.set("limit", String(query.limit));
    }
    if(query.cursor != null){
        p.set("cursor", query.cursor);
    }
    if(query.weak === true){
        p.set("weak", "true");
    }
    return p;
}

/** `Filters` as the body of the similar lookups — filters only: the view and the
 *  collection do not scope "find similar". */
function filterBody(f: Filters){
    return {
        date: f.datePreset,
        dateFrom: f.dateFrom,
        dateTo: f.dateTo,
        dims: f.dims,
        folders: f.folders,
        types: f.types,
    };
}

const EVENTS_RETRY_MIN_MS = 1000;
const EVENTS_RETRY_MAX_MS = 15000;

export interface SidecarHandshake{
    port: number;
    token: string;
}

export class HttpApi implements PhotoSearchApi{
    private base: string;

    constructor(private handshake: SidecarHandshake){
        this.base = `http://127.0.0.1:${handshake.port}`;
    }

    private async req<T>(path: string, init?: RequestInit): Promise<T>{
        const res = await fetch(`${this.base}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                "X-PicSearch-Token": this.handshake.token,
                ...(init?.headers ?? {}),
            },
        });
        if(!res.ok){
            throw new Error(`sidecar ${res.status}: ${await res.text()}`);
        }
        return res.json() as Promise<T>;
    }

    search(query: SearchQuery): Promise<SearchResponse>{
        return this.req<SearchResponse>(`/search?${queryParams(query).toString()}`);
    }

    timeline(query: SearchQuery): Promise<Timeline>{
        const p = queryParams(query);
        p.delete("limit");
        p.delete("cursor");
        return this.req<Timeline>(`/timeline?${p.toString()}`);
    }

    similar(id: number, filters: Filters): Promise<SearchResponse>{
        return this.req<SearchResponse>("/search/similar", {
            method: "POST",
            body: JSON.stringify({ image_id: id, ...filterBody(filters) }),
        });
    }

    similarToFile(path: string, filters: Filters): Promise<SearchResponse>{
        return this.req<SearchResponse>("/search/similar-file", {
            method: "POST",
            body: JSON.stringify({ path, ...filterBody(filters) }),
        });
    }

    // Token rides in the query string here: <img src> cannot set headers.
    thumbUrl(id: number, size: 256 | 512): string{
        return `${this.base}/thumb/${id}?size=${size}&t=${encodeURIComponent(this.handshake.token)}`;
    }

    fileUrl(id: number): string{
        return `${this.base}/file/${id}?t=${encodeURIComponent(this.handshake.token)}`;
    }

    listFolders(): Promise<WatchedFolder[]>{
        return this.req<WatchedFolder[]>("/folders");
    }

    /**
     * The native picker runs here rather than in a component: `api` is the only
     * seam to the outside world, and the sidecar has no business opening
     * windows. Null means the user cancelled.
     */
    async addFolder(): Promise<WatchedFolder | null>{
        const path = await pickFolder();
        if(path === null){
            return null;
        }
        return this.req<WatchedFolder | null>("/folders", {
            method: "POST",
            body: JSON.stringify({ path, recursive: true }),
        });
    }

    async removeFolder(path: string): Promise<void>{
        await this.req(`/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    }

    async setFolderRecursive(path: string, recursive: boolean): Promise<void>{
        await this.req("/folders", {
            method: "PATCH",
            body: JSON.stringify({ path, recursive }),
        });
    }

    counts(): Promise<LibraryCounts>{
        return this.req<LibraryCounts>("/counts");
    }

    getSettings(): Promise<SettingsResponse>{
        return this.req<SettingsResponse>("/settings");
    }

    putSettings(patch: Partial<Settings>): Promise<SettingsResponse>{
        return this.req<SettingsResponse>("/settings", {
            method: "PUT",
            body: JSON.stringify(patch),
        });
    }

    models(): Promise<ModelsResponse>{
        return this.req<ModelsResponse>("/models");
    }

    async downloadModel(id: string): Promise<void>{
        await this.req<unknown>(`/models/${encodeURIComponent(id)}/download`, { method: "POST" });
    }

    async deleteModel(id: string): Promise<void>{
        await this.req<unknown>(`/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    listCollections(): Promise<Collection[]>{
        return this.req<Collection[]>("/collections");
    }

    createCollection(name: string): Promise<Collection>{
        return this.req<Collection>("/collections", {
            method: "POST",
            body: JSON.stringify({ name }),
        });
    }

    async deleteCollection(id: string): Promise<void>{
        await this.req(`/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    async addToCollection(id: string, imageIds: number[]): Promise<void>{
        await this.req(`/collections/${encodeURIComponent(id)}/items`, {
            method: "POST",
            body: JSON.stringify({ ids: imageIds }),
        });
    }

    async removeFromCollection(id: string, imageIds: number[]): Promise<void>{
        await this.req(`/collections/${encodeURIComponent(id)}/items`, {
            method: "DELETE",
            body: JSON.stringify({ ids: imageIds }),
        });
    }

    listSavedSearches(): Promise<SavedSearch[]>{
        return this.req<SavedSearch[]>("/searches");
    }

    /** The whole query is posted, not just the text — the sidecar stores it as
     *  one JSON blob so running it later restores the filters too. */
    saveSearch(query: SearchQuery): Promise<SavedSearch>{
        return this.req<SavedSearch>("/searches", {
            method: "POST",
            body: JSON.stringify({
                query: query.q,
                view: query.view,
                collection: query.collection,
                filters: query.filters,
            }),
        });
    }

    async deleteSavedSearch(id: string): Promise<void>{
        await this.req(`/searches/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    storage(): Promise<StorageUsage>{
        return this.req<StorageUsage>("/storage");
    }

    ocrStatus(): Promise<OcrStatus>{
        return this.req<OcrStatus>("/ocr");
    }

    async clearThumbnailCache(): Promise<void>{
        await this.req("/storage/thumbnails", { method: "DELETE" });
    }

    async revealInFiles(ids: number[]): Promise<void>{
        await this.req("/reveal", { method: "POST", body: JSON.stringify({ ids }) });
    }

    async openExternally(id: number): Promise<void>{
        await this.req("/open", { method: "POST", body: JSON.stringify({ id }) });
    }

    deletePhotos(ids: number[]): Promise<DeleteResult>{
        return this.req<DeleteResult>("/images", { method: "DELETE", body: JSON.stringify({ ids }) });
    }

    async setIndexingPaused(paused: boolean): Promise<void>{
        await this.req("/indexing/pause", { method: "POST", body: JSON.stringify({ paused }) });
    }

    /**
     * `/events` is read with fetch rather than `EventSource`, which cannot set
     * the token header. The response is an endless stream, so the reader runs
     * detached and the returned function aborts it. When the stream ends or
     * fails it is reopened with a growing delay: without that, one dropped
     * connection silently ends indexing progress and every refresh the sidecar
     * pushes, for the rest of the session. The reopen is announced to the
     * handler as `reconnected`, because what was said in the gap is lost.
     */
    subscribeEvents(handler: (event: SidecarEvent) => void): () => void{
        const controller = new AbortController();
        const signal = controller.signal;

        const pause = (ms: number) => new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            signal.addEventListener("abort", () => {
                clearTimeout(t);
                resolve();
            }, { once: true });
        });

        const pump = async (body: ReadableStream<Uint8Array>) => {
            const reader = body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while(true){
                const { done, value } = await reader.read();
                if(done){
                    return;
                }
                buffer += decoder.decode(value, { stream: true });
                // SSE frames are separated by a blank line; a chunk can hold
                // several, or half of one.
                const frames = buffer.split("\n\n");
                buffer = frames.pop() ?? "";
                for(const frame of frames){
                    for(const line of frame.split("\n")){
                        if(!line.startsWith("data:")){
                            continue;   // ": keepalive" and friends
                        }
                        try{
                            handler(JSON.parse(line.slice(5).trim()) as SidecarEvent);
                        }catch{
                            // A malformed frame is not worth tearing the stream down.
                        }
                    }
                }
            }
        };

        void (async () => {
            let wasUp = false;
            let delay = EVENTS_RETRY_MIN_MS;
            while(!signal.aborted){
                try{
                    const res = await fetch(`${this.base}/events`, {
                        headers: { "X-PicSearch-Token": this.handshake.token },
                        signal,
                    });
                    if(res.ok && res.body !== null){
                        if(wasUp){
                            handler({ type: "reconnected" });
                        }
                        wasUp = true;
                        delay = EVENTS_RETRY_MIN_MS;
                        await pump(res.body);
                    }
                }catch(err){
                    if(signal.aborted){
                        return;
                    }
                    console.error("event stream ended", err);
                }
                await pause(delay);
                delay = Math.min(delay * 2, EVENTS_RETRY_MAX_MS);
            }
        })();

        return () => controller.abort();
    }
}

/**
 * Returns the mock adapter until the Tauri shell provides a sidecar handshake.
 * Build step 5 (see ARCHITECTURE.md) replaces the window global with a real
 * `invoke("sidecar_handshake")` call.
 */
export function resolveApi(): PhotoSearchApi{
    if(typeof window === "undefined"){
        return new MockApi();
    }
    const handshake = (window as unknown as { __PICSEARCH__?: SidecarHandshake }).__PICSEARCH__;
    if(handshake !== undefined){
        return new HttpApi(handshake);
    }
    return new MockApi();
}

export const api = resolveApi();
export const isMockMode = api instanceof MockApi;
