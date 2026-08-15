import type {
    Photo,
    SearchQuery,
    SearchResponse,
    SidecarEvent,
    StorageUsage,
    WatchedFolder,
} from "./types";
import { buildMockLibrary, type MockPhoto } from "./mockData";
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
    similar(id: number): Promise<SearchResponse>;
    thumbUrl(id: number, size: 256 | 512): string | null;
    fileUrl(id: number): string | null;
    listFolders(): Promise<WatchedFolder[]>;
    addFolder(): Promise<WatchedFolder | null>;
    removeFolder(path: string): Promise<void>;
    setFolderRecursive(path: string, recursive: boolean): Promise<void>;
    storage(): Promise<StorageUsage>;
    clearThumbnailCache(): Promise<void>;
    revealInFiles(ids: number[]): Promise<void>;
    openExternally(id: number): Promise<void>;
    deletePhotos(ids: number[]): Promise<void>;
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

const DAY_MS = 86_400_000;
const DATE_PRESET_DAYS: Record<string, number> = {
    today: 1,
    week: 7,
    month: 30,
    year: 365,
};

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
    if(f.dims === "large"){
        out = out.filter((it) => Math.max(it.width, it.height) >= 2500);
    }else if(f.dims === "small"){
        out = out.filter((it) => Math.max(it.width, it.height) < 2500);
    }

    return out;
}

function strip(item: MockPhoto): Photo{
    const { tags: _tags, takenMs: _takenMs, ...rest } = item;
    return rest;
}

export class MockApi implements PhotoSearchApi{
    private items = buildMockLibrary();
    private folders: WatchedFolder[] = [
        { path: "~/Pictures", count: 1842, recursive: true },
        { path: "~/Pictures/Screenshots", count: 967, recursive: true },
        { path: "~/Downloads/Screenshots", count: 432, recursive: false },
    ];
    private cacheGb = 1.4;

    async search(query: SearchQuery): Promise<SearchResponse>{
        const started = performance.now();
        let scoped = applyScope(this.items, query);
        const q = query.q.trim();

        if(q !== ""){
            scoped = scoped.filter((it) => matches(it, q));
        }

        const items = scoped.map((it, i) => {
            const photo = strip(it);
            if(q === ""){
                return photo;
            }
            // Stand-in for the RRF score the sidecar returns.
            return { ...photo, score: Math.max(0.05, 0.92 - i * 0.004) };
        });

        // Browsing is newest-first; search is relevance-ordered.
        if(q === ""){
            items.sort((a, b) => (b.takenAt ?? "").localeCompare(a.takenAt ?? ""));
        }

        return {
            items,
            total: items.length,
            tookMs: Math.round(performance.now() - started) + 8,
            cursor: null,
        };
    }

    async similar(id: number): Promise<SearchResponse>{
        const target = this.items.find((it) => it.id === id);
        const started = performance.now();
        if(target === undefined){
            return { items: [], total: 0, tookMs: 0, cursor: null };
        }
        const scored = this.items
            .filter((it) => it.id !== id)
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
    }

    async setFolderRecursive(path: string, recursive: boolean): Promise<void>{
        this.folders = this.folders.map((f) => f.path === path ? { ...f, recursive } : f);
    }

    async storage(): Promise<StorageUsage>{
        return { thumbnailCacheGb: this.cacheGb, indexGb: 0.34 };
    }

    async clearThumbnailCache(): Promise<void>{
        this.cacheGb = 0;
    }

    async revealInFiles(): Promise<void>{}
    async openExternally(): Promise<void>{}

    async deletePhotos(ids: number[]): Promise<void>{
        const drop = new Set(ids);
        this.items = this.items.filter((it) => !drop.has(it.id));
    }

    /** No sidecar, no events — the store simulates progress in mock mode. */
    subscribeEvents(): () => void{
        return () => {};
    }
}

// ---------------------------------------------------------------------------
// HTTP adapter (real sidecar)
// ---------------------------------------------------------------------------

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
        if(query.filters.dims !== null){
            p.set("dims", query.filters.dims);
        }
        for(const f of query.filters.folders){
            p.append("folder", f);
        }
        for(const t of query.filters.types){
            p.append("type", t);
        }
        if(query.limit !== undefined){
            p.set("limit", String(query.limit));
        }
        if(query.cursor != null){
            p.set("cursor", query.cursor);
        }
        return this.req<SearchResponse>(`/search?${p.toString()}`);
    }

    similar(id: number): Promise<SearchResponse>{
        return this.req<SearchResponse>("/search/similar", {
            method: "POST",
            body: JSON.stringify({ image_id: id }),
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

    storage(): Promise<StorageUsage>{
        return this.req<StorageUsage>("/storage");
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

    async deletePhotos(ids: number[]): Promise<void>{
        await this.req("/images", { method: "DELETE", body: JSON.stringify({ ids }) });
    }

    /**
     * `/events` is read with fetch rather than `EventSource`, which cannot set
     * the token header. The response is an endless stream, so the reader runs
     * detached and the returned function aborts it.
     */
    subscribeEvents(handler: (event: SidecarEvent) => void): () => void{
        const controller = new AbortController();

        void (async () => {
            try{
                const res = await fetch(`${this.base}/events`, {
                    headers: { "X-PicSearch-Token": this.handshake.token },
                    signal: controller.signal,
                });
                if(res.body === null){
                    return;
                }
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while(true){
                    const { done, value } = await reader.read();
                    if(done){
                        break;
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
            }catch(err){
                if(!controller.signal.aborted){
                    console.error("event stream ended", err);
                }
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
