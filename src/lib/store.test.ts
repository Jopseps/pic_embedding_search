// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
    SIDEBAR_DEFAULT_W,
    SIDEBAR_MAX_W,
    SIDEBAR_MIN_W,
    clampSidebarWidth,
    useStore,
} from "./store";

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
