// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useGridLayout } from "./useGridLayout";
import { visibleRange } from "./grid";
import { useStore } from "./store";
import type { Photo } from "./types";

/**
 * The scroll container is a *conditionally rendered* node — `App` swaps
 * `LibraryView` for `SettingsView` — while this hook lives in `App` and never
 * unmounts. That combination is what these tests are about: with the element
 * bound once, a trip through Settings left the ResizeObserver and the scroll
 * listener attached to a node that was no longer in the document, and the grid
 * came back frozen.
 */
const INITIAL = useStore.getState();

/** A node in the document, the way React would mount it. Attached matters: the
 *  restore reads `scrollTop` while the element is still in the tree, because a
 *  detached one reports 0 in a real engine. */
function makeNode(){
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
}

/** A fresh results array. Fresh matters: the point of two of these tests is
 *  that a *new array for the same search* must not move the scroll. */
function photos(): Photo[]{
    return [1, 2, 3, 4, 5, 6].map((id) => ({
        id,
        path: `/p/${id}.jpg`,
        filename: `${id}.jpg`,
        folder: "/p",
        width: 1600,
        height: 1200,
        mime: "image/jpeg",
        takenAt: "2026-03-01T10:00:00Z",
        isScreenshot: false,
        hasOcr: false,
        ocrText: null,
        snippet: null,
        isDupe: false,
        collections: [],
    }));
}

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class{
            observe(){}
            unobserve(){}
            disconnect(){}
        },
    );
    useStore.setState(INITIAL, true);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("useGridLayout", () => {
    it("follows the scroll container across a remount", () => {
        const { result } = renderHook(() => useGridLayout());

        const first = makeNode();
        act(() => result.current.attachScroll(first));
        const second = makeNode();
        // Settings opened and closed: the old node is gone, a new one arrives.
        act(() => result.current.attachScroll(null));
        act(() => result.current.attachScroll(second));

        second.scrollTop = 321;
        act(() => {
            second.dispatchEvent(new Event("scroll"));
        });
        expect(result.current.scrollTop).toBe(321);

        // And the dead node no longer drives anything.
        first.scrollTop = 999;
        act(() => {
            first.dispatchEvent(new Event("scroll"));
        });
        expect(result.current.scrollTop).toBe(321);
    });

    it("puts the user back where they were before Settings", () => {
        const { result } = renderHook(() => useGridLayout());

        const first = makeNode();
        act(() => result.current.attachScroll(first));
        first.scrollTop = 640;
        act(() => {
            first.dispatchEvent(new Event("scroll"));
        });

        // React detaches the ref, *then* removes the node — which is the order
        // the restore depends on.
        act(() => result.current.attachScroll(null));
        first.remove();
        const second = makeNode();
        act(() => result.current.attachScroll(second));
        expect(second.scrollTop).toBe(640);
        expect(result.current.scrollTop).toBe(640);
    });

    it("stays where it is when a photo is selected", () => {
        // The regression: `gridMode` returned "selection" the moment anything
        // was picked, the reset effect took `mode` as a dependency, and a
        // press-and-hold halfway down the library jumped to the top.
        useStore.setState({ results: photos(), foldersLoaded: true });
        const { result, rerender } = renderHook(() => useGridLayout());
        const el = makeNode();
        act(() => result.current.attachScroll(el));
        el.scrollTop = 900;
        act(() => {
            el.dispatchEvent(new Event("scroll"));
        });

        act(() => useStore.getState().toggleSelect(2));
        rerender();
        expect(el.scrollTop).toBe(900);
        expect(result.current.scrollTop).toBe(900);
    });

    it("stays where it is when a rescan re-runs the same search", () => {
        // `runSearch` fires on every watcher `scan-complete`, so the results
        // array is replaced under a user who typed nothing.
        useStore.setState({ results: photos(), foldersLoaded: true });
        const { result, rerender } = renderHook(() => useGridLayout());
        const el = makeNode();
        act(() => result.current.attachScroll(el));
        el.scrollTop = 640;
        act(() => {
            el.dispatchEvent(new Event("scroll"));
        });

        act(() => useStore.setState({ results: photos() }));
        rerender();
        expect(el.scrollTop).toBe(640);
    });

    it("goes back to the top when the search itself changes", () => {
        useStore.setState({ results: photos(), foldersLoaded: true });
        const { result, rerender } = renderHook(() => useGridLayout());
        const el = makeNode();
        act(() => result.current.attachScroll(el));
        el.scrollTop = 640;
        act(() => {
            el.dispatchEvent(new Event("scroll"));
        });

        act(() => useStore.setState({ query: "table" }));
        rerender();
        expect(el.scrollTop).toBe(0);
        expect(result.current.scrollTop).toBe(0);
    });

    it("does not report a position past the end of a shrunken result set", () => {
        // Deleting a selection re-runs the same search and hands back a much
        // shorter list. Nothing resets the scroll — that is the point of the
        // fix above — so the position has to be clamped to the content that is
        // left, or `visibleRange` slices an empty window and the grid is blank.
        useStore.setState({ results: photos(), foldersLoaded: true });
        const { result, rerender } = renderHook(() => useGridLayout());
        const el = makeNode();
        act(() => result.current.attachScroll(el));
        el.scrollTop = 900;
        act(() => {
            el.dispatchEvent(new Event("scroll"));
        });

        act(() => useStore.setState({ results: photos().slice(0, 1) }));
        rerender();
        expect(result.current.scrollTop).toBeLessThanOrEqual(result.current.layout.totalHeight);
        const { start, end } = visibleRange(
            result.current.layout.blocks, result.current.scrollTop, 600,
        );
        expect(end).toBeGreaterThan(start);
    });

    it("scales row and header heights with the accessibility setting", () => {
        const { result, rerender } = renderHook(() => useGridLayout());
        act(() => result.current.attachScroll(makeNode()));
        const before = result.current.layout.totalHeight;

        act(() => {
            useStore.setState((s) => ({
                settings: { ...s.settings, uiScale: 150 },
            }));
        });
        rerender();
        expect(result.current.layout.totalHeight).toBeGreaterThan(before);
    });
});
