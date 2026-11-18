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
import type { Filters, Photo, SearchResponse } from "./types";

const INITIAL = useStore.getState();
const EMPTY: Filters = {
    datePreset: null, dateFrom: null, dateTo: null, folders: [], types: [], dims: null,
};

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
        // matchObject: an earlier test's coalesced write may still be queued
        expect(put.mock.calls[0]?.[0]).toMatchObject({ accentHue: 260 });
        put.mockRestore();
    });

    it("collapses two settings written together into one write", async () => {
        // A tint preset is a hue *and* a strength. Two PUTs built from two
        // reads of the same file lose one of them.
        const put = vi.spyOn(api, "putSettings");
        useStore.getState().setSetting("tintHue", 70);
        useStore.getState().setSetting("tintStrength", 200);

        await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
        expect(put.mock.calls[0]?.[0]).toMatchObject({ tintHue: 70, tintStrength: 200 });
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

describe("find similar", () => {
    it("puts the screen back when the lookup fails, instead of skeletons forever", async () => {
        useStore.setState({ query: "masa", results: [photo(1)] });
        const similar = vi.spyOn(api, "similar").mockRejectedValue(new Error("sidecar gone"));
        await useStore.getState().findSimilar(photo(7));
        const s = useStore.getState();
        expect(s.searching).toBe(false);
        expect(s.similarTo).toBeNull();
        expect(s.query).toBe("masa");
        expect(s.toast).toContain("sidecar gone");
        similar.mockRestore();
    });

    it("a background refresh re-runs the similar lookup, not a library search", async () => {
        const target = photo(7);
        useStore.setState({ similarTo: target, results: [photo(1)] });
        const search = vi.spyOn(api, "search");
        const similar = vi.spyOn(api, "similar").mockResolvedValue(page([1, 2], null, 2));
        await useStore.getState().runSearch({ keepLoaded: true });
        expect(search).not.toHaveBeenCalled();
        expect(similar).toHaveBeenCalledWith(7, EMPTY);
        expect(useStore.getState().results.map((p) => p.id)).toEqual([1, 2]);
        search.mockRestore();
        similar.mockRestore();
    });
});

describe("find similar with filters", () => {
    it("sends the current filters, and a filter click re-runs the lookup with them", async () => {
        const similar = vi.spyOn(api, "similar").mockResolvedValue(page([1, 2], null, 2));
        const search = vi.spyOn(api, "search");
        await useStore.getState().findSimilar(photo(7));
        expect(similar).toHaveBeenLastCalledWith(7, EMPTY);

        useStore.getState().toggleTypeFilter("Screenshot");
        await vi.waitFor(() => expect(similar).toHaveBeenCalledTimes(2));
        expect(similar).toHaveBeenLastCalledWith(7, { ...EMPTY, types: ["Screenshot"] });
        expect(search).not.toHaveBeenCalled();
        expect(useStore.getState().similarTo?.id).toBe(7);
        search.mockRestore();
        similar.mockRestore();
    });

    it("Esc brings back the previous search with its own filters, not the ones set since", async () => {
        const similar = vi.spyOn(api, "similar").mockResolvedValue(page([1], null, 1));
        const search = vi.spyOn(api, "search").mockResolvedValue(page([5], null, 1));
        const before: Filters = { ...EMPTY, dims: "large" };
        useStore.setState({ query: "masa", filters: before, results: [photo(5)] });

        await useStore.getState().findSimilar(photo(7));
        useStore.getState().toggleTypeFilter("Photo");
        await vi.waitFor(() => expect(similar).toHaveBeenCalledTimes(2));
        useStore.getState().exitSimilar();

        const s = useStore.getState();
        expect(s.similarTo).toBeNull();
        expect(s.query).toBe("masa");
        expect(s.filters).toEqual(before);
        await vi.waitFor(() => expect(search).toHaveBeenCalled());
        expect(search.mock.calls[0]?.[0].filters).toEqual(before);
        search.mockRestore();
        similar.mockRestore();
    });
});

describe("find similar to a dropped file", () => {
    it("looks the file up by path with the filters and shows its name", async () => {
        const byFile = vi.spyOn(api, "similarToFile").mockResolvedValue(page([3, 4], null, 2));
        await useStore.getState().dropFiles(["/home/me/Pictures/cat.jpg"]);
        expect(byFile).toHaveBeenCalledWith("/home/me/Pictures/cat.jpg", EMPTY);
        const s = useStore.getState();
        expect(s.similarTo?.filename).toBe("cat.jpg");
        expect(s.isDraggingFile).toBe(false);
        expect(s.results.map((p) => p.id)).toEqual([3, 4]);
        byFile.mockRestore();
    });

    it("a background refresh re-runs the same file lookup, not a search or a row lookup", async () => {
        const byFile = vi.spyOn(api, "similarToFile").mockResolvedValue(page([3], null, 1));
        const similar = vi.spyOn(api, "similar");
        const search = vi.spyOn(api, "search");
        await useStore.getState().findSimilarToFile("/x/cat.jpg");
        await useStore.getState().runSearch({ keepLoaded: true });
        expect(byFile).toHaveBeenCalledTimes(2);
        expect(similar).not.toHaveBeenCalled();
        expect(search).not.toHaveBeenCalled();
        byFile.mockRestore();
        similar.mockRestore();
        search.mockRestore();
    });

    it("uses the first of several files and says so", async () => {
        const byFile = vi.spyOn(api, "similarToFile").mockResolvedValue(page([3], null, 1));
        await useStore.getState().dropFiles(["/a/one.jpg", "/a/two.jpg", "/a/three.jpg"]);
        expect(byFile).toHaveBeenCalledTimes(1);
        expect(byFile.mock.calls[0]?.[0]).toBe("/a/one.jpg");
        expect(useStore.getState().toast).toContain("2 other files were ignored");
        byFile.mockRestore();
    });

    it("a file that is not an image toasts the sidecar's sentence and changes nothing", async () => {
        const byFile = vi.spyOn(api, "similarToFile").mockRejectedValue(
            new Error('sidecar 415: {"detail":"not a supported image: notes.txt"}'),
        );
        useStore.setState({ query: "masa", results: [photo(1)] });
        await useStore.getState().dropFiles(["/a/notes.txt"]);
        const s = useStore.getState();
        expect(s.toast).toBe("not a supported image: notes.txt");
        expect(s.similarTo).toBeNull();
        expect(s.query).toBe("masa");
        expect(s.searching).toBe(false);
        byFile.mockRestore();
    });

    it("two different dropped files are two different searches for the scroll", async () => {
        const byFile = vi.spyOn(api, "similarToFile").mockResolvedValue(page([3], null, 1));
        await useStore.getState().findSimilarToFile("/a/one.jpg");
        const first = searchKey(useStore.getState());
        await useStore.getState().findSimilarToFile("/a/two.jpg");
        expect(searchKey(useStore.getState())).not.toBe(first);
        byFile.mockRestore();
    });

    it("Esc restores the search the drop replaced", async () => {
        const byFile = vi.spyOn(api, "similarToFile").mockResolvedValue(page([3], null, 1));
        const search = vi.spyOn(api, "search").mockResolvedValue(page([5], null, 1));
        useStore.setState({ query: "masa", results: [photo(5)] });
        await useStore.getState().findSimilarToFile("/a/one.jpg");
        useStore.getState().exitSimilar();
        expect(useStore.getState().query).toBe("masa");
        expect(useStore.getState().similarTo).toBeNull();
        byFile.mockRestore();
        search.mockRestore();
    });
});

describe("pause indexing", () => {
    it("flips the flag and tells the sidecar", async () => {
        const pause = vi.spyOn(api, "setIndexingPaused").mockResolvedValue();
        await useStore.getState().toggleIndexingPause();
        expect(useStore.getState().indexing.paused).toBe(true);
        expect(pause).toHaveBeenLastCalledWith(true);
        await useStore.getState().toggleIndexingPause();
        expect(useStore.getState().indexing.paused).toBe(false);
        expect(pause).toHaveBeenLastCalledWith(false);
        pause.mockRestore();
    });

    it("puts the flag back and says so when the sidecar refuses", async () => {
        const pause = vi.spyOn(api, "setIndexingPaused").mockRejectedValue(new Error("gone"));
        await useStore.getState().toggleIndexingPause();
        expect(useStore.getState().indexing.paused).toBe(false);
        expect(useStore.getState().toast).toContain("gone");
        pause.mockRestore();
    });
});

describe("removing a watched folder", () => {
    it("asks first, then refreshes results, counts and folders", async () => {
        const remove = vi.spyOn(api, "removeFolder").mockResolvedValue();
        const search = vi.spyOn(api, "search").mockResolvedValue(page([1], null, 1));
        const counts = vi.spyOn(api, "counts");
        useStore.getState().requestRemoveFolder("~/Pictures");
        expect(useStore.getState().removeFolderConfirm).toBe("~/Pictures");
        expect(remove).not.toHaveBeenCalled();

        await useStore.getState().removeFolder("~/Pictures");
        expect(remove).toHaveBeenCalledWith("~/Pictures");
        expect(useStore.getState().removeFolderConfirm).toBeNull();
        expect(search).toHaveBeenCalled();
        expect(counts).toHaveBeenCalled();
        expect(useStore.getState().toast).toContain("files stay on disk");
        remove.mockRestore();
        search.mockRestore();
        counts.mockRestore();
    });
});

describe("a refresh under an open photo", () => {
    function open(ids: number[], at: number){
        useStore.setState({ results: ids.map((id) => photo(id)), lightboxIndex: at, focusedIndex: at });
    }

    it("follows the photo when rows are inserted before it", async () => {
        open([1, 2, 3], 1);
        const search = vi.spyOn(api, "search").mockResolvedValue(page([9, 1, 2, 3], null));
        await useStore.getState().runSearch({ keepLoaded: true });
        expect(useStore.getState().lightboxIndex).toBe(2);
        expect(useStore.getState().focusedIndex).toBe(2);
        search.mockRestore();
    });

    it("shows the neighbour when the photo itself is gone, and closes on an empty result", async () => {
        open([1, 2, 3], 1);
        const search = vi.spyOn(api, "search").mockResolvedValue(page([1, 3], null));
        await useStore.getState().runSearch({ keepLoaded: true });
        expect(useStore.getState().lightboxIndex).toBe(1);
        search.mockResolvedValue(page([], null, 0));
        await useStore.getState().runSearch({ keepLoaded: true });
        expect(useStore.getState().lightboxIndex).toBeNull();
        search.mockRestore();
    });

    it("never leaves the lightbox open past the end of a shrunken result", async () => {
        open([1, 2, 3], 2);
        const search = vi.spyOn(api, "search").mockResolvedValue(page([1], null));
        await useStore.getState().runSearch({ keepLoaded: true });
        expect(useStore.getState().lightboxIndex).toBe(0);
        search.mockRestore();
    });

    it("a failed refresh keeps the rows on screen", async () => {
        open([1, 2], 0);
        const search = vi.spyOn(api, "search").mockRejectedValue(new Error("blip"));
        await useStore.getState().runSearch({ keepLoaded: true });
        const s = useStore.getState();
        expect(s.results.map((p) => p.id)).toEqual([1, 2]);
        expect(s.lightboxIndex).toBe(0);
        expect(s.backendError).toBe("blip");
        search.mockRestore();
    });
});

describe("failing writes", () => {
    it("a failed delete keeps the selection and says why", async () => {
        useStore.setState({ selectedIds: new Set([1, 2]) });
        const del = vi.spyOn(api, "deletePhotos").mockRejectedValue(new Error("locked"));
        await expect(useStore.getState().deleteSelected()).resolves.toBeUndefined();
        expect([...useStore.getState().selectedIds]).toEqual([1, 2]);
        expect(useStore.getState().toast).toContain("locked");
        del.mockRestore();
    });

    it("filing one photo leaves the rest of the selection alone", async () => {
        useStore.setState({ selectedIds: new Set([1, 2, 3]) });
        const add = vi.spyOn(api, "addToCollection").mockResolvedValue();
        await useStore.getState().addPhotosToCollection("refs", [2]);
        expect([...useStore.getState().selectedIds]).toEqual([1, 3]);
        add.mockRestore();
    });

    it("filing the whole selection still empties it", async () => {
        useStore.setState({ selectedIds: new Set([1, 2]) });
        const add = vi.spyOn(api, "addToCollection").mockResolvedValue();
        await useStore.getState().addPhotosToCollection("refs", [1, 2]);
        expect(useStore.getState().selectedIds.size).toBe(0);
        add.mockRestore();
    });
});

describe("move to trash", () => {
    it("asks first: requesting changes nothing and Cancel is a no-op", () => {
        const del = vi.spyOn(api, "deletePhotos");
        useStore.setState({ selectedIds: new Set([1, 2]) });
        useStore.getState().requestDelete();
        expect(useStore.getState().deleteConfirm).toBe(true);
        expect(del).not.toHaveBeenCalled();
        useStore.getState().cancelDelete();
        expect(useStore.getState().deleteConfirm).toBe(false);
        expect([...useStore.getState().selectedIds]).toEqual([1, 2]);
        expect(del).not.toHaveBeenCalled();
        del.mockRestore();
    });

    it("has nothing to ask about with an empty selection", () => {
        useStore.getState().requestDelete();
        expect(useStore.getState().deleteConfirm).toBe(false);
    });

    it("keeps exactly the photos the trash refused selected, and counts the rest", async () => {
        useStore.setState({ selectedIds: new Set([1, 2, 3]), deleteConfirm: true });
        const del = vi.spyOn(api, "deletePhotos").mockResolvedValue({ removed: 2, failed: [2] });
        const search = vi.spyOn(api, "search").mockResolvedValue(page([2], null, 1));
        await useStore.getState().deleteSelected();
        const s = useStore.getState();
        expect(del).toHaveBeenCalledWith([1, 2, 3]);
        expect(s.deleteConfirm).toBe(false);
        expect([...s.selectedIds]).toEqual([2]);
        expect(s.toast).toBe("2 photos moved to the trash; 1 could not be moved");
        del.mockRestore();
        search.mockRestore();
    });

    it("clears the selection when everything moved", async () => {
        useStore.setState({ selectedIds: new Set([4]) });
        const del = vi.spyOn(api, "deletePhotos").mockResolvedValue({ removed: 1, failed: [] });
        const search = vi.spyOn(api, "search").mockResolvedValue(page([], null, 0));
        await useStore.getState().deleteSelected();
        expect(useStore.getState().selectedIds.size).toBe(0);
        expect(useStore.getState().toast).toBe("1 photo moved to the trash");
        del.mockRestore();
        search.mockRestore();
    });
});

describe("typing from Settings", () => {
    it("brings the library back so the results are visible", () => {
        useStore.setState({ view: "settings" });
        useStore.getState().setQuery("masa");
        expect(useStore.getState().view).toBe("library");
        useStore.getState().clearQuery();
    });
});

describe("density", () => {
    it("a burst of steps writes the file once", async () => {
        const put = vi.spyOn(api, "putSettings");
        useStore.getState().stepDensity(1);
        useStore.getState().stepDensity(-1);
        useStore.getState().stepDensity(-1);
        expect(put).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
        expect(put.mock.calls[0]?.[0]).toMatchObject({ density: 0 });
        put.mockRestore();
    });
});

describe("match cutoff", () => {
    it("lifts for the search it was pressed on, and only that one", async () => {
        useStore.setState({ query: "flower" });
        await useStore.getState().runSearch();
        const cut = useStore.getState();
        expect(cut.weak).toBeGreaterThan(0);

        cut.showWeakMatches();
        await vi.waitFor(() => expect(useStore.getState().weak).toBe(0));
        expect(useStore.getState().total).toBeGreaterThan(cut.total);

        // A different query is a different search: the cutoff is back.
        useStore.setState({ query: "tree" });
        await useStore.getState().runSearch();
        expect(useStore.getState().weak).toBeGreaterThan(0);
    });
});

describe("model files", () => {
    it("lists what is on disk, and which model is in use", async () => {
        await useStore.getState().loadModels();
        const { models } = useStore.getState();
        expect(models["siglip2-base-patch16-224"]?.downloaded).toBe(true);
        expect(models["siglip2-base-patch16-224"]?.active).toBe(true);
        expect(models["jina-clip-v2"]?.downloaded).toBe(false);
    });

    it("deletes an unused model's files only after the confirmation", async () => {
        await useStore.getState().loadModels();
        useStore.getState().askDeleteModel("siglip2-so400m-patch14-384");
        expect(useStore.getState().deletingModelId).toBe("siglip2-so400m-patch14-384");
        expect(useStore.getState().models["siglip2-so400m-patch14-384"]?.downloaded).toBe(true);

        await useStore.getState().confirmDeleteModel();
        expect(useStore.getState().deletingModelId).toBeNull();
        expect(useStore.getState().models["siglip2-so400m-patch14-384"]?.downloaded).toBe(false);
    });

    it("cancelling the confirmation deletes nothing", async () => {
        // The mock api outlives the store reset, and an earlier test deleted this one.
        await api.downloadModel("siglip2-so400m-patch14-384");
        await useStore.getState().loadModels();
        useStore.getState().askDeleteModel("siglip2-so400m-patch14-384");
        useStore.getState().cancelDeleteModel();
        expect(useStore.getState().deletingModelId).toBeNull();
        expect(useStore.getState().models["siglip2-so400m-patch14-384"]?.downloaded).toBe(true);
    });

    it("refuses to delete the model that is in use", async () => {
        await useStore.getState().loadModels();
        useStore.getState().askDeleteModel("siglip2-base-patch16-224");
        await useStore.getState().confirmDeleteModel();
        expect(useStore.getState().models["siglip2-base-patch16-224"]?.downloaded).toBe(true);
        expect(useStore.getState().toast).toContain("in use");
    });

    it("shows download progress, then marks the model downloaded", async () => {
        vi.useFakeTimers();
        try{
            await useStore.getState().loadModels();
            await useStore.getState().downloadModel("jina-clip-v2");
            await vi.advanceTimersByTimeAsync(600);
            const mid = useStore.getState().modelDownload;
            expect(mid?.modelId).toBe("jina-clip-v2");
            expect(mid?.done).toBeGreaterThan(0);
            await vi.advanceTimersByTimeAsync(6000);
            expect(useStore.getState().modelDownload).toBeNull();
            expect(useStore.getState().models["jina-clip-v2"]?.downloaded).toBe(true);
        }finally{
            vi.useRealTimers();
        }
    });

    it("starts one download at a time", async () => {
        vi.useFakeTimers();
        try{
            await useStore.getState().downloadModel("jina-clip-v2");
            await vi.advanceTimersByTimeAsync(400);
            await useStore.getState().downloadModel("openclip-vit-l14");
            expect(useStore.getState().modelDownload?.modelId).toBe("jina-clip-v2");
            await vi.advanceTimersByTimeAsync(6000);
        }finally{
            vi.useRealTimers();
        }
    });
});
