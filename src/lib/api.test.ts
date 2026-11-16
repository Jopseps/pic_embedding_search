/**
 * `HttpApi` tests — the half of the sidecar contract that lives in TypeScript.
 *
 * The Python side asserts the same contract from the other direction
 * (`sidecar/tests/test_search.py`); these cover what only the client can get
 * wrong: how the query string is built, that the token rides along in both
 * forms, and that the SSE stream survives being chopped into arbitrary chunks.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { HttpApi } from "./api";
import type { SearchQuery, SidecarEvent } from "./types";

const HANDSHAKE = { port: 41337, token: "tok-en/with+chars" };

function makeQuery(overrides: Partial<SearchQuery> = {}): SearchQuery{
    return {
        q: "table",
        view: null,
        collection: null,
        filters: { datePreset: null, dateFrom: null, dateTo: null, folders: [], types: [], dims: null },
        ...overrides,
    };
}

function jsonResponse(body: unknown){
    return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** A Response whose body streams the given chunks, one read at a time. */
function streamResponse(chunks: string[]){
    const encoder = new TextEncoder();
    let i = 0;
    return {
        ok: true,
        status: 200,
        body: {
            getReader(){
                return {
                    async read(){
                        if(i >= chunks.length){
                            return { done: true, value: undefined };
                        }
                        const value = encoder.encode(chunks[i] as string);
                        i += 1;
                        return { done: false, value };
                    },
                };
            },
        },
    } as unknown as Response;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("HttpApi request building", () => {
    it("sends the token as a header on json routes", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse({ items: [], total: 0, tookMs: 1, cursor: null }));
        vi.stubGlobal("fetch", fetchSpy);

        await new HttpApi(HANDSHAKE).search(makeQuery());

        const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain("http://127.0.0.1:41337/search?");
        expect((init.headers as Record<string, string>)["X-PicSearch-Token"]).toBe(HANDSHAKE.token);
    });

    it("serializes filters the way the sidecar reads them", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse({ items: [], total: 0, tookMs: 1, cursor: null }));
        vi.stubGlobal("fetch", fetchSpy);

        await new HttpApi(HANDSHAKE).search(makeQuery({
            q: "masa",
            view: "recent",
            filters: {
                datePreset: "week",
                dateFrom: null,
                dateTo: null,
                folders: ["/home/u/Pictures", "/home/u/Downloads"],
                types: ["Screenshot"],
                dims: "large",
            },
            limit: 40,
        }));

        const url = new URL((fetchSpy.mock.calls[0] as unknown as [string])[0]);
        const p = url.searchParams;
        expect(p.get("q")).toBe("masa");
        expect(p.get("view")).toBe("recent");
        expect(p.get("date")).toBe("week");
        expect(p.get("dims")).toBe("large");
        expect(p.getAll("folder")).toEqual(["/home/u/Pictures", "/home/u/Downloads"]);
        // Capitalized PhotoKind, not a mime string — the sidecar matches on it.
        expect(p.getAll("type")).toEqual(["Screenshot"]);
        expect(p.get("limit")).toBe("40");
    });

    it("puts the token in the query string for image bytes", () => {
        const api = new HttpApi(HANDSHAKE);
        // <img src> cannot set headers, so ?t= is the only way in.
        expect(api.thumbUrl(7, 512)).toBe(
            `http://127.0.0.1:41337/thumb/7?size=512&t=${encodeURIComponent(HANDSHAKE.token)}`,
        );
        expect(api.fileUrl(7)).toContain(`/file/7?t=${encodeURIComponent(HANDSHAKE.token)}`);
    });

    it("throws with the sidecar's own message on failure", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: false,
            status: 401,
            text: async () => "missing or invalid token",
        } as unknown as Response)));

        await expect(new HttpApi(HANDSHAKE).search(makeQuery())).rejects.toThrow(/401/);
    });
});

describe("HttpApi event stream", () => {
    it("parses frames that arrive split across chunks", async () => {
        const seen: SidecarEvent[] = [];
        vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
            'data: {"type":"index","current":1,"tot',
            'al":10,"rate":5,"etaSec":2,"paused":false,"currentFile":"a.jpg","running":true}\n\n',
            ": keepalive\n\n",
            'data: {"type":"scan-complete","scanned":10,"ingested":10,"skipped":0,'
                + '"embedded":10,"ocred":4,"removed":0,"errors":0}\n\n',
        ])));

        const stop = new HttpApi(HANDSHAKE).subscribeEvents((e) => seen.push(e));
        await vi.waitFor(() => expect(seen).toHaveLength(2));
        stop();

        expect(seen[0]).toMatchObject({ type: "index", current: 1, total: 10, running: true });
        expect(seen[1]).toMatchObject({ type: "scan-complete", ingested: 10 });
    });

    it("handles several frames in one chunk and ignores malformed ones", async () => {
        const seen: SidecarEvent[] = [];
        vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
            'data: {"type":"reindex","active":true,"progress":40,"modelName":"jina"}\n\n'
                + "data: {not json}\n\n"
                + 'data: {"type":"reindex","active":false,"progress":100,"modelName":"jina"}\n\n',
        ])));

        const stop = new HttpApi(HANDSHAKE).subscribeEvents((e) => seen.push(e));
        await vi.waitFor(() => expect(seen).toHaveLength(2));
        stop();

        expect(seen.map((e) => (e as { progress: number }).progress)).toEqual([40, 100]);
    });

    it("aborts the request when unsubscribed", async () => {
        let signal: AbortSignal | undefined;
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
            signal = init.signal ?? undefined;
            return streamResponse([]);
        }));

        const stop = new HttpApi(HANDSHAKE).subscribeEvents(() => {});
        await vi.waitFor(() => expect(signal).toBeDefined());
        expect(signal?.aborted).toBe(false);
        stop();
        expect(signal?.aborted).toBe(true);
    });
});

describe("HttpApi collections and saved searches", () => {
    it("posts image ids to the collection's items route", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse({ added: 2, count: 2 }));
        vi.stubGlobal("fetch", fetchSpy);

        await new HttpApi(HANDSHAKE).addToCollection("7", [11, 12]);

        const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://127.0.0.1:41337/collections/7/items");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({ ids: [11, 12] });
    });

    it("removes membership with a DELETE that carries a body", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse({ removed: 1, count: 0 }));
        vi.stubGlobal("fetch", fetchSpy);

        await new HttpApi(HANDSHAKE).removeFromCollection("7", [11]);

        const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.method).toBe("DELETE");
        expect(JSON.parse(init.body as string)).toEqual({ ids: [11] });
    });

    it("saves the whole query, not just the text", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse({
            id: "1", query: "masa", view: null, collection: null,
            filters: { datePreset: "week", dateFrom: null, dateTo: null, folders: [], types: ["Screenshot"], dims: null },
        }));
        vi.stubGlobal("fetch", fetchSpy);

        await new HttpApi(HANDSHAKE).saveSearch(makeQuery({
            q: "masa",
            filters: { datePreset: "week", dateFrom: null, dateTo: null, folders: [], types: ["Screenshot"], dims: null },
        }));

        const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://127.0.0.1:41337/searches");
        // Filters ride along or a saved search runs against whatever happens to
        // be set when it is clicked.
        expect(JSON.parse(init.body as string)).toEqual({
            query: "masa",
            view: null,
            collection: null,
            filters: { datePreset: "week", dateFrom: null, dateTo: null, folders: [], types: ["Screenshot"], dims: null },
        });
    });

    it("sends the collection id, not its name, as the search filter", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse({ items: [], total: 0, tookMs: 1, cursor: null }));
        vi.stubGlobal("fetch", fetchSpy);

        await new HttpApi(HANDSHAKE).search(makeQuery({ q: "", collection: "12" }));

        const url = new URL((fetchSpy.mock.calls[0] as unknown as [string])[0]);
        expect(url.searchParams.get("collection")).toBe("12");
    });
});

describe("HttpApi folder picker", () => {
    it("returns null without posting when the picker is unavailable", async () => {
        // Outside the desktop shell there is no dialog, and the sidecar must not
        // be asked to guess a path.
        const fetchSpy = vi.fn(async () => jsonResponse(null));
        vi.stubGlobal("fetch", fetchSpy);

        expect(await new HttpApi(HANDSHAKE).addFolder()).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
