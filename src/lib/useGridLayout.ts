import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildLayout, HEADER_HEIGHT, type Layout, type Section } from "./grid";
import { GRID_GAP, GRID_ROW_HEIGHTS } from "./catalog";
import { monthLabel } from "./format";
import { gridMode, searchKey, useStore } from "./store";
import type { GridMode, Photo } from "./types";

export const GRID_PAD_X = 20;

/** Placeholder cells for the loading state — varied aspects so the justified
 *  layout is actually exercised rather than degenerating to a uniform strip. */
const SKELETON_ASPECTS = [
    1.5, 1.7778, 0.6667, 1.3333, 2.3333, 1, 0.5625, 1.6, 1.2, 1.7778, 0.8, 1.3333,
    1.5, 1, 1.7778, 0.6667, 1.6, 1.2,
];

function skeletonPhotos(): Photo[]{
    return SKELETON_ASPECTS.map((aspect, i) => ({
        id: -1 - i,
        path: "",
        filename: "",
        folder: "",
        width: Math.round(1000 * aspect),
        height: 1000,
        mime: "",
        takenAt: null,
        isScreenshot: false,
        hasOcr: false,
        ocrText: null,
        snippet: null,
        isDupe: false,
        collections: [],
    }));
}

const SKELETONS = skeletonPhotos();

function buildSections(mode: GridMode, results: Photo[]): Section<Photo>[]{
    if(mode === "loading"){
        return [{ label: null, items: SKELETONS }];
    }
    if(mode === "emptySearch" || mode === "emptyLibrary"){
        return [];
    }
    // Browsing groups by month; search results are relevance-ordered, so a date
    // separator there would be actively misleading.
    if(mode === "idle"){
        const sections: Section<Photo>[] = [];
        let current: Section<Photo> | null = null;
        for(const p of results){
            const label = monthLabel(p.takenAt);
            if(current === null || current.label !== label){
                current = { label, items: [] };
                sections.push(current);
            }
            current.items.push(p);
        }
        return sections;
    }
    return [{ label: null, items: results }];
}

export interface GridLayoutHandle{
    scrollRef: React.RefObject<HTMLDivElement | null>;
    /** Ref callback for the scroll container. It has to be a callback rather
     *  than the RefObject: the node unmounts every time Settings opens, and an
     *  effect keyed on nothing keeps observing the detached one. */
    attachScroll(el: HTMLDivElement | null): void;
    layout: Layout<Photo>;
    mode: GridMode;
    scrollTop: number;
    viewportHeight: number;
    width: number;
    scrollToIndex(index: number): void;
}

export function useGridLayout(): GridLayoutHandle{
    const scrollRef = useRef<HTMLDivElement>(null);
    // The node itself is state, not just a ref, so the effects below re-run
    // when it is replaced. `useGridLayout` lives in `App` and survives the
    // switch to Settings; the scroll container it measures does not, and with
    // `[]` deps the ResizeObserver and the scroll listener stayed bound to the
    // dead node — the grid came back frozen, rendering a window that no longer
    // moved. Same class as the Lightbox wheel bug, see CLAUDE.md.
    const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    /** Where the user was before the node went away. A fresh node starts at 0,
     *  so a trip to Settings and back would otherwise jump to the top. */
    const savedScroll = useRef(0);

    const results = useStore((s) => s.results);
    const density = useStore((s) => s.density);
    const uiScale = useStore((s) => s.settings.uiScale);
    const mode = useStore(gridMode);
    /** The search on screen, as one string — see `searchKey`. */
    const query = useStore(searchKey);

    const attachScroll = useCallback((el: HTMLDivElement | null) => {
        if(el === null && scrollRef.current !== null){
            // The last moment the position can be read. React detaches refs
            // before it removes the node, and a *detached* element reports
            // `scrollTop` 0 — capturing this in the effect cleanup instead
            // saves a zero and silently never restores anything.
            savedScroll.current = scrollRef.current.scrollTop;
        }
        // The RefObject stays live: `useGridGesture` reads `scrollRef.current`
        // during a drag, where a re-render is exactly what must not happen.
        scrollRef.current = el;
        setScrollEl(el);
    }, []);

    useEffect(() => {
        const el = scrollEl;
        if(el === null){
            return;
        }
        const measure = () => {
            setWidth(Math.max(240, el.clientWidth - GRID_PAD_X * 2));
            setViewportHeight(el.clientHeight);
        };
        measure();
        if(savedScroll.current > 0){
            el.scrollTop = savedScroll.current;
            setScrollTop(savedScroll.current);
        }
        if(typeof ResizeObserver === "undefined"){
            return;
        }
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [scrollEl]);

    const onScroll = useCallback(() => {
        const el = scrollRef.current;
        if(el !== null){
            setScrollTop(el.scrollTop);
        }
    }, []);

    useEffect(() => {
        const el = scrollEl;
        if(el === null){
            return;
        }
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, [onScroll, scrollEl]);

    const layout = useMemo(() => {
        const sections = buildSections(mode, results);
        const base = GRID_ROW_HEIGHTS[density] ?? GRID_ROW_HEIGHTS[1];
        // The UI scale is an accessibility setting, so it moves the photos and
        // the month headers with everything else — the header height is a
        // layout constant here, not CSS, and a header that did not grow with
        // its own text would be overrun by it.
        const s = uiScale / 100;
        return buildLayout(sections, base * s, GRID_GAP, width, HEADER_HEIGHT * s);
    }, [mode, results, density, width, uiScale]);

    // Reset scroll when the user asks a *different* question, so a new search
    // does not land them halfway down a shorter list.
    //
    // Keyed on the query and not on `results`, and not on `mode` either. Both
    // move without the user asking for anything: `runSearch` re-runs on every
    // watcher `scan-complete`, so a background rescan scrolled a browsing user
    // back to the top — and `mode` used to flip to "selection" on the first
    // photo picked, which is what made press-and-hold jump to the top.
    useEffect(() => {
        const el = scrollRef.current;
        if(el !== null){
            // Assignment rather than `scrollTo`: same effect, and it is the one
            // of the two jsdom implements, which is what makes this testable.
            el.scrollTop = 0;
        }
        savedScroll.current = 0;
        setScrollTop(0);
    }, [query]);

    const scrollToIndex = useCallback(
        (index: number) => {
            const el = scrollRef.current;
            const entry = layout.rowMap[index];
            if(el === null || entry === undefined){
                return;
            }
            const block = layout.blocks.find(
                (b) => b.kind === "row" && b.rowIndex === entry.row,
            );
            if(block === undefined){
                return;
            }
            const { top, height } = block;
            if(top < el.scrollTop){
                el.scrollTo({ top: Math.max(0, top - 16) });
            }else if(top + height > el.scrollTop + el.clientHeight){
                el.scrollTo({ top: top + height - el.clientHeight + 16 });
            }
        },
        [layout],
    );

    // Clamped to the content that actually exists. A result set can shrink
    // without the search changing — deleting a selection is the everyday case —
    // and the old position then points past the end of the canvas, so
    // `visibleRange` slices an empty window and the grid renders blank. Engines
    // do fire a `scroll` event when they clamp a shrunken container, but that
    // is one frame later and one engine's behaviour to rely on.
    const maxScroll = Math.max(0, layout.totalHeight - viewportHeight);
    return {
        scrollRef,
        attachScroll,
        layout,
        mode,
        scrollTop: Math.min(scrollTop, maxScroll),
        viewportHeight,
        width,
        scrollToIndex,
    };
}
