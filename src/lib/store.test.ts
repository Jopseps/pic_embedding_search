// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
    SIDEBAR_DEFAULT_W,
    SIDEBAR_MAX_W,
    SIDEBAR_MIN_W,
    activeSort,
    clampSidebarWidth,
    searchKey,
    sectionsByDate,
    useStore,
} from "./store";
import type { Photo, SearchResponse } from "./types";

const INITIAL = useStore.getState();

beforeEach(() => {
    useStore.setState(INITIAL, true);
});

describe("sidebar width", () => {
    it("clamps to the readable range", () => {
        expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_W);
        expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_W);
        expect(clampSidebarWidth(301.6)).toBe(302);
    });

    it("writes the width through for the next launch", () => {
        // This jsdom build ships no localStorage, which is also the case the
        // store's try/catch exists for — stub one and check the write lands.
        const store = new Map<string, string>();
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: {
                getItem: (k: string) => store.get(k) ?? null,
                setItem: (k: string, v: string) => void store.set(k, v),
            },
        });
        useStore.getState().setSidebarWidth(333);
        expect(useStore.getState().sidebarWidth).toBe(333);
        expect(store.get("picsearch.sidebarWidth")).toBe("333");
    });

    it("does not throw when storage is unavailable", () => {
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: undefined,
        });
        expect(() => useStore.getState().setSidebarWidth(260)).not.toThrow();
        expect(useStore.getState().sidebarWidth).toBe(260);
    });

    it("starts at the default when nothing is stored", () => {
        expect(INITIAL.sidebarWidth).toBe(SIDEBAR_DEFAULT_W);
    });
});

describe("stepDensity", () => {
    it("moves one step and stops at both ends", () => {
        useStore.getState().stepDensity(1);
        expect(useStore.getState().density).toBe(2);
        useStore.getState().stepDensity(1);
        expect(useStore.getState().density).toBe(2);
        useStore.getState().stepDensity(-1);
        useStore.getState().stepDensity(-1);
        useStore.getState().stepDensity(-1);
        expect(useStore.getState().density).toBe(0);
    });

    it("keeps the persisted settings copy in step", () => {
        useStore.getState().stepDensity(-1);
        expect(useStore.getState().settings.density).toBe(0);
    });
});

describe("paint selection", () => {
    it("adds a swept batch and removes it again", () => {
        useStore.getState().paintSelection([1, 2, 3], "add");
        expect([...useStore.getState().selectedIds]).toEqual([1, 2, 3]);
        useStore.getState().paintSelection([2], "remove");
        expect([...useStore.getState().selectedIds]).toEqual([1, 3]);
    });

    it("keeps the same set reference when the sweep re-crosses the same photos", () => {
        useStore.getState().paintSelection([1, 2], "add");
        const first = useStore.getState().selectedIds;
        useStore.getState().paintSelection([1, 2], "add");
        expect(useStore.getState().selectedIds).toBe(first);
    });

    it("never wipes what was already selected", () => {
        useStore.getState().paintSelection([1], "add");
        useStore.getState().paintSelection([7, 8], "add");
        expect([...useStore.getState().selectedIds]).toEqual([1, 7, 8]);
    });
});

describe("range selection", () => {
    it("replaces wholesale, so a range can shrink as well as grow", () => {
        useStore.getState().setSelection([1, 2, 3]);
        useStore.getState().setSelection([1, 2]);
        expect([...useStore.getState().selectedIds]).toEqual([1, 2]);
    });

    it("emptying it also closes the collection menu that hangs off the bar", () => {
        useStore.getState().setSelection([1, 2]);
        useStore.getState().setSelection([]);
        expect(useStore.getState().selectedIds.size).toBe(0);
        expect(useStore.getState().collectionMenuOpen).toBe(false);
    });
});

describe("anchor", () => {
    it("follows the last single photo picked", () => {
        useStore.getState().toggleSelect(42);
        expect(useStore.getState().anchorId).toBe(42);
        useStore.getState().toggleSelect(7);
        expect(useStore.getState().anchorId).toBe(7);
    });

    it("is dropped when the selection is cleared", () => {
        useStore.getState().toggleSelect(42);
        useStore.getState().clearSelection();
        expect(useStore.getState().anchorId).toBeNull();
    });
});

describe("setSetting", () => {
    it("previews every step but writes the file once", async () => {
        // A slider fires an input event per pixel of the drag. Persisting each
        // one is a PUT that re-reads and rewrites config.toml, and the sidecar
        // runs them concurrently — a read-modify-write race against itself.
        const put = vi.spyOn(api, "putSettings");
        for(let hue = 200; hue <= 260; hue += 2){
            useStore.getState().setSetting("accentHue", hue);
        }
        expect(useStore.getState().settings.accentHue).toBe(260);
        expect(put).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
        expect(put.mock.calls[0]?.[0]).toEqual({ accentHue: 260 });
        put.mockRestore();
    });

    it("collapses two settings written together into one write", async () => {
        // A tint preset is a hue *and* a strength. Two PUTs built from two
        // reads of the same file lose one of them.
        const put = vi.spyOn(api, "putSettings");
        useStore.getState().setSetting("tintHue", 70);
        useStore.getState().setSetting("tintStrength", 200);

        await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
        expect(put.mock.calls[0]?.[0]).toEqual({ tintHue: 70, tintStrength: 200 });
        put.mockRestore();
    });
});

describe("drag out", () => {
    it("tracks the collection under the pointer and resets on end", () => {
        useStore.getState().startDragOut(3);
        expect(useStore.getState().dragOut.count).toBe(3);
        useStore.getState().setDragOverCollection("c1");
        expect(useStore.getState().dragOut.overCollection).toBe("c1");
        useStore.getState().endDragOut();
        expect(useStore.getState().dragOut).toEqual({
            active: false,
            count: 0,
            overCollection: null,
        });
    });
});

function photo(id: number, takenAt: string | null = "2026-05-01T10:00:00"): Photo{
    return {
        id, path: `/p/${id}.png`, filename: `${id}.png`, folder: "/p", width: 100, height: 100,
        mime: "image/png", takenAt, dateSource: takenAt === null ? null : "filename",
        isScreenshot: false, hasOcr: false, ocrText: null, snippet: null, isDupe: false,
        collections: [],
    };
}

function page(ids: number[], cursor: string | null, total = 10): SearchResponse{
    return { items: ids.map((id) => photo(id)), total, tookMs: 1, cursor };
}

describe("sort", () => {
    it("persists the browse order and sends it with the search", async () => {
        const search = vi.spyOn(api, "search");
        useStore.getState().setSort("name-asc");
        expect(useStore.getState().settings.sort).toBe("name-asc");
        await vi.waitFor(() => expect(search).toHaveBeenCalled());
        expect(search.mock.calls.at(-1)?.[0].sort).toBe("name-asc");
        search.mockRestore();
    });

    it("keeps a query's order to the session and resets it when the query clears", () => {
        useStore.setState({ query: "masa" });
        useStore.getState().setSort("date-asc");
        const s = useStore.getState();
        expect(s.searchSort).toBe("date-asc");
        expect(s.settings.sort).toBe("date-desc");
        expect(activeSort(s)).toBe("date-asc");
        useStore.getState().clearQuery();
        expect(useStore.getState().searchSort).toBe("relevance");
        expect(activeSort(useStore.getState())).toBe("date-desc");
    });

    it("draws date headers exactly when the order is by date", () => {
        expect(sectionsByDate(useStore.getState())).toBe(true);
        useStore.setState({ query: "masa" });
        expect(sectionsByDate(useStore.getState())).toBe(false);
        useStore.setState({ searchSort: "date-desc" });
        expect(sectionsByDate(useStore.getState())).toBe(true);
    });

    it("is part of the search key, so a new order starts at the top", () => {
        const before = searchKey(useStore.getState());
        useStore.setState((s) => ({ settings: { ...s.settings, sort: "size-desc" } }));
        expect(searchKey(useStore.getState())).not.toBe(before);
    });
});

describe("date range", () => {
    it("and a preset replace each other", () => {
        useStore.getState().setDatePreset("week");
        useStore.getState().setDateRange("2026-05-01", null);
        let f = useStore.getState().filters;
        expect([f.datePreset, f.dateFrom, f.dateTo]).toEqual([null, "2026-05-01", null]);
        useStore.getState().setDatePreset("month");
        f = useStore.getState().filters;
        expect([f.datePreset, f.dateFrom, f.dateTo]).toEqual(["month", null, null]);
    });
});

describe("paging", () => {
    it("appends the next page and drops ids it already has", async () => {
        useStore.setState({ results: [photo(1), photo(2)], cursor: "2" });
        const search = vi.spyOn(api, "search").mockResolvedValue(page([2, 3, 4], "5"));
        await useStore.getState().loadMore();
        const s = useStore.getState();
        expect(s.results.map((p) => p.id)).toEqual([1, 2, 3, 4]);
        expect(s.cursor).toBe("5");
        expect(s.loadingMore).toBe(false);
        expect(search.mock.calls[0]?.[0].cursor).toBe("2");
        search.mockRestore();
    });

    it("does not flip the grid to skeletons", async () => {
        useStore.setState({ results: [photo(1)], cursor: "1" });
        let seen = false;
        const search = vi.spyOn(api, "search").mockImplementation(async () => {
            seen = useStore.getState().loadingMore && !useStore.getState().searching;
            return page([2], null);
        });
        await useStore.getState().loadMore();
        expect(seen).toBe(true);
        search.mockRestore();
    });

    it("drops a page that lands after a new search started", async () => {
        useStore.setState({ results: [photo(1)], cursor: "1" });
        let release: (r: SearchResponse) => void = () => {};
        const search = vi.spyOn(api, "search").mockImplementationOnce(
            () => new Promise((resolve) => { release = resolve; }),
        );
        const pending = useStore.getState().loadMore();
        search.mockResolvedValue(page([9], null));
        await useStore.getState().runSearch();
        release(page([2], null));
        await pending;
        expect(useStore.getState().results.map((p) => p.id)).toEqual([9]);
        search.mockRestore();
    });

    it("loads through to a far index in as few requests as the cap allows", async () => {
        useStore.setState({ results: [photo(0)], cursor: "1" });
        const search = vi.spyOn(api, "search").mockImplementation(async (q) => {
            const from = Number(q.cursor);
            const ids = Array.from({ length: q.limit ?? 0 }, (_, i) => from + i);
            return page(ids, String(from + ids.length), 5000);
        });
        await useStore.getState().loadThrough(1500);
        expect(useStore.getState().results.length).toBeGreaterThan(1500);
        expect(search.mock.calls.map((c) => c[0].limit)).toEqual([1000, 500]);
        search.mockRestore();
    });

    it("a failed page stops paging instead of retrying in a loop", async () => {
        useStore.setState({ results: [photo(1)], cursor: "1" });
        const search = vi.spyOn(api, "search").mockRejectedValue(new Error("sidecar gone"));
        await useStore.getState().loadMore();
        await useStore.getState().loadMore();
        expect(search).toHaveBeenCalledTimes(1);
        expect(useStore.getState().cursor).toBe(null);
        expect(useStore.getState().results.map((p) => p.id)).toEqual([1]);
        search.mockRestore();
    });

    it("a background refresh keeps as many rows as were loaded", async () => {
        useStore.setState({ results: Array.from({ length: 450 }, (_, i) => photo(i)) });
        const search = vi.spyOn(api, "search").mockResolvedValue(page([1], null));
        await useStore.getState().runSearch({ keepLoaded: true });
        expect(search.mock.calls[0]?.[0].limit).toBe(450);
        search.mockRestore();
    });
});
