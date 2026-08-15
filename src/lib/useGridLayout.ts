import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildLayout, type Layout, type Section } from "./grid";
import { GRID_GAP, GRID_ROW_HEIGHTS } from "./catalog";
import { monthLabel } from "./format";
import { gridMode, useStore } from "./store";
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
    layout: Layout<Photo>;
    mode: GridMode;
    scrollTop: number;
    viewportHeight: number;
    width: number;
    scrollToIndex(index: number): void;
}

export function useGridLayout(): GridLayoutHandle{
    const scrollRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);

    const results = useStore((s) => s.results);
    const density = useStore((s) => s.density);
    const mode = useStore(gridMode);

    useEffect(() => {
        const el = scrollRef.current;
        if(el === null){
            return;
        }
        const measure = () => {
            setWidth(Math.max(240, el.clientWidth - GRID_PAD_X * 2));
            setViewportHeight(el.clientHeight);
        };
        measure();
        if(typeof ResizeObserver === "undefined"){
            return;
        }
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const onScroll = useCallback(() => {
        const el = scrollRef.current;
        if(el !== null){
            setScrollTop(el.scrollTop);
        }
    }, []);

    useEffect(() => {
        const el = scrollRef.current;
        if(el === null){
            return;
        }
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, [onScroll]);

    const layout = useMemo(() => {
        const sections = buildSections(mode, results);
        const targetHeight = GRID_ROW_HEIGHTS[density] ?? GRID_ROW_HEIGHTS[1];
        return buildLayout(sections, targetHeight, GRID_GAP, width);
    }, [mode, results, density, width]);

    // Reset scroll when the result set changes identity, so a new search does
    // not land the user halfway down a shorter list.
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: 0 });
        setScrollTop(0);
    }, [mode, results]);

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

    return { scrollRef, layout, mode, scrollTop, viewportHeight, width, scrollToIndex };
}
