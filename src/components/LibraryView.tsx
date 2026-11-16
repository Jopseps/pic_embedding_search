import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeSort, EXTERNAL_ID, searchKey, sectionsByDate, useStore } from "../lib/store";
import { GRID_GAP, SORT_OPTIONS } from "../lib/catalog";
import { visibleRange } from "../lib/grid";
import { buildMarks } from "../lib/timeline";
import { GRID_PAD_X, type GridLayoutHandle } from "../lib/useGridLayout";
import { useGridGesture } from "../lib/useGridGesture";
import { fmtCount } from "../lib/format";
import { GridCell, SkeletonCell } from "./GridCell";
import { Scrubber } from "./Scrubber";
import { Button } from "./ui";
import type { Photo } from "../lib/types";

const ZOOM_DOTS = [6, 9, 12];
/** Start fetching the next page this many viewports before the end. */
const LOAD_AHEAD_VIEWPORTS = 1.5;

export function LibraryView(props: { grid: GridLayoutHandle }){
    const { grid } = props;
    const { layout, mode, attachScroll, scrollTop, viewportHeight } = grid;
    const gesture = useGridGesture(grid);

    const density = useStore((s) => s.density);
    const setDensity = useStore((s) => s.setDensity);
    const query = useStore((s) => s.query);
    const similarTo = useStore((s) => s.similarTo);
    const total = useStore((s) => s.total);
    const tookMs = useStore((s) => s.tookMs);
    const activeCollection = useStore((s) => s.activeCollection);
    const collections = useStore((s) => s.collections);
    const libraryView = useStore((s) => s.libraryView);
    const clearQuery = useStore((s) => s.clearQuery);
    const exitSimilar = useStore((s) => s.exitSimilar);
    const addFolder = useStore((s) => s.addFolder);
    const byDate = useStore(sectionsByDate);
    const sort = useStore(activeSort);
    const cursor = useStore((s) => s.cursor);
    const loadingMore = useStore((s) => s.loadingMore);
    const loadMore = useStore((s) => s.loadMore);
    const loadThrough = useStore((s) => s.loadThrough);
    const timeline = useStore((s) => s.timeline);

    const isSearch = mode === "results" || mode === "emptySearch";
    const title = useMemo(() => {
        if(isSearch){
            if(similarTo === null){
                return "Search results";
            }
            return similarTo.id === EXTERNAL_ID ? `Similar to ${similarTo.filename}` : "Visually similar";
        }
        if(activeCollection !== null){
            return collections.find((c) => c.id === activeCollection)?.name ?? "Collection";
        }
        const map: Record<string, string> = {
            all: "All photos",
            recent: "Recent",
            dupes: "Duplicates",
        };
        return map[libraryView ?? "all"] ?? "All photos";
    }, [isSearch, similarTo, activeCollection, collections, libraryView]);

    const { start, end } = visibleRange(layout.blocks, scrollTop, viewportHeight);
    const blocks = layout.blocks.slice(start, end);

    // Row-major position of each photo, for lightbox paging and arrow-key nav.
    // Built once per layout — looking it up per cell would be O(n²).
    const indexById = useMemo(() => {
        const m = new Map<number, number>();
        layout.flat.forEach((p, i) => m.set(p.id, i));
        return m;
    }, [layout]);

    // Month headers, extracted once per layout. Pulled out of the sticky-label
    // lookup below because that runs on every scroll frame and walking the full
    // block list there is the one O(all photos) step on the scroll path.
    const headers = useMemo(() => {
        const out: { top: number; label: string }[] = [];
        for(const b of layout.blocks){
            if(b.kind === "header"){
                out.push({ top: b.top, label: b.label });
            }
        }
        return out;
    }, [layout.blocks]);

    // Month header currently scrolled past — pinned so the date context never
    // disappears, which plain absolute positioning would otherwise lose.
    const stickyLabel = useMemo(() => {
        if(!byDate || mode === "loading" || headers.length === 0){
            return null;
        }
        let lo = 0;
        let hi = headers.length - 1;
        let found = -1;
        while(lo <= hi){
            const mid = (lo + hi) >> 1;
            // Strictly past: a header still in view is its own label, and a
            // pinned copy over it reads as the month printed twice.
            if((headers[mid]?.top ?? 0) < scrollTop){
                found = mid;
                lo = mid + 1;
            }else{
                hi = mid - 1;
            }
        }
        return found < 0 ? null : headers[found]?.label ?? null;
    }, [headers, scrollTop, mode, byDate]);

    // Infinite scroll. An effect on the geometry rather than a scroll
    // listener: content shorter than the viewport never scrolls, and a first
    // page that does not fill a tall window would otherwise never grow.
    const canPage = mode === "idle" || mode === "results";
    useEffect(() => {
        if(!canPage || cursor === null || loadingMore || viewportHeight === 0){
            return;
        }
        if(scrollTop + viewportHeight * (1 + LOAD_AHEAD_VIEWPORTS) >= layout.totalHeight){
            void loadMore();
        }
    }, [canPage, cursor, loadingMore, scrollTop, viewportHeight, layout.totalHeight, loadMore]);

    // ---- scrubber ---------------------------------------------------------

    const marks = useMemo(() => (timeline === null ? null : buildMarks(timeline)), [timeline]);

    // First photo in view, from the rows already sliced for rendering — the
    // thumb's position, and the month the bubble names while dragging.
    let currentIndex = 0;
    for(const b of blocks){
        if(b.kind === "row" && b.top + b.height > scrollTop){
            const first = b.row.cells[0];
            currentIndex = first === undefined ? 0 : (indexById.get(first.item.id) ?? 0);
            break;
        }
    }

    // The native scrollbar's width, so the rail sits beside it, not on it.
    const [scrollbarW, setScrollbarW] = useState(0);
    useEffect(() => {
        const el = grid.scrollRef.current;
        if(el !== null){
            setScrollbarW(el.offsetWidth - el.clientWidth);
        }
    }, [grid.scrollRef, grid.width, layout.totalHeight]);

    // A jump to a photo that is not loaded yet waits here until it is. The
    // effect below retries after every layout, so a jump made while another
    // page was in flight is not dropped.
    const pendingJump = useRef<number | null>(null);
    const tryJump = useCallback(() => {
        const index = pendingJump.current;
        const el = grid.scrollRef.current;
        if(index === null || el === null){
            return;
        }
        const entry = layout.rowMap[index];
        if(entry === undefined){
            if(useStore.getState().cursor === null){
                // Nothing left to load: the index is not coming. Kept, it would
                // fire on whatever layout change lands next and yank the grid.
                pendingJump.current = null;
            }else{
                void loadThrough(index);
            }
            return;
        }
        const bi = layout.blocks.findIndex((b) => b.kind === "row" && b.rowIndex === entry.row);
        const block = layout.blocks[bi];
        if(block === undefined){
            return;
        }
        // Top-aligned, and onto the month's header when the row opens one:
        // the minimal scroll `scrollToIndex` does would land a jump downward
        // at the *bottom* of the viewport.
        const prev = layout.blocks[bi - 1];
        el.scrollTop = prev !== undefined && prev.kind === "header" ? prev.top : block.top;
        pendingJump.current = null;
    }, [grid.scrollRef, layout, loadThrough]);
    useEffect(() => {
        tryJump();
    }, [tryJump, cursor, loadingMore]);
    const onJump = useCallback((index: number) => {
        pendingJump.current = index;
        tryJump();
    }, [tryJump]);

    // A jump belongs to the question it was made under.
    const asked = useStore(searchKey);
    useEffect(() => {
        pendingJump.current = null;
    }, [asked]);

    const everythingFits = cursor === null && layout.totalHeight <= viewportHeight;
    const showScrubber = byDate && canPage && marks !== null && marks.marks.length > 1 && !everythingFits;

    const sortShort = SORT_OPTIONS.find((o) => o.key === sort)?.short ?? "";

    return (
        <div className="relative flex min-w-0 flex-1 flex-col">
            <div
                style={{ paddingLeft: GRID_PAD_X, paddingRight: GRID_PAD_X }}
                className="flex flex-shrink-0 items-center justify-between pt-[calc(14px*var(--ui-scale))] pb-[calc(6px*var(--ui-scale))]"
            >
                <div>
                    <div className="text-[calc(15px*var(--ui-scale))] font-semibold">{title}</div>
                    {mode === "results" ? (
                        <div className="mt-[calc(2px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] tabular-nums text-fg-faint">
                            {sort === "relevance"
                                // A re-sorted query keeps only its best matches;
                                // saying so stops "100 results" reading as if
                                // the rest of the library vanished.
                                ? `${fmtCount(total)} result${total === 1 ? "" : "s"}`
                                : `Top ${fmtCount(total)} match${total === 1 ? "" : "es"}, ${sortShort.toLowerCase()}`}
                            {" "}· {tookMs} ms
                        </div>
                    ) : null}
                </div>
                <div className="flex items-center gap-1">
                    {ZOOM_DOTS.map((dot, i) => (
                        <button
                            key={dot}
                            type="button"
                            aria-label={`Grid density ${i + 1}`}
                            onClick={() => setDensity(i as 0 | 1 | 2)}
                            className={
                                "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors " +
                                (density === i ? "bg-hover" : "hover:bg-hover/50")
                            }
                        >
                            <span
                                className="rounded-sm"
                                style={{
                                    width: `calc(${dot}px*var(--ui-scale))`,
                                    height: `calc(${dot}px*var(--ui-scale))`,
                                    background: density === i
                                        ? "var(--text-primary)"
                                        : "var(--text-tertiary)",
                                }}
                            />
                        </button>
                    ))}
                </div>
            </div>

            <div className="relative flex min-h-0 flex-1">
                <div
                    ref={attachScroll}
                    onPointerDown={gesture.onPointerDown}
                    className="relative min-w-0 flex-1 overflow-y-auto pb-[calc(90px*var(--ui-scale))]"
                    style={{
                        paddingLeft: GRID_PAD_X,
                        paddingRight: GRID_PAD_X,
                        // The sweep keeps painting under a pointer that has left the
                        // photos, so the cursor has to say so everywhere in the pane.
                        cursor: gesture.sweeping ? "crosshair" : undefined,
                    }}
                >
                    {stickyLabel !== null ? (
                        <div
                            // The grid's own gutter, not `-mx-5`: that follows the UI
                            // scale and the gutter does not, so above 100% the pinned
                            // label stuck out past the scroller and grew a horizontal
                            // scrollbar.
                            style={{
                                marginLeft: -GRID_PAD_X,
                                marginRight: -GRID_PAD_X,
                                paddingLeft: GRID_PAD_X,
                                paddingRight: GRID_PAD_X,
                            }}
                            className="pointer-events-none sticky top-0 z-[2] bg-canvas pt-[calc(10px*var(--ui-scale))] pb-2 text-[calc(12.5px*var(--ui-scale))] font-semibold text-fg-dim"
                        >
                            {stickyLabel}
                        </div>
                    ) : null}

                    {mode === "emptyLibrary" ? (
                        <EmptyLibrary onAddFolder={() => void addFolder()} />
                    ) : null}

                    {mode === "emptySearch" ? (
                        <EmptySearch
                            query={query}
                            similar={similarTo !== null}
                            onClear={similarTo !== null ? exitSimilar : clearQuery}
                        />
                    ) : null}

                    {layout.totalHeight > 0 ? (
                        <div
                            ref={gesture.canvasRef}
                            className="relative mt-2"
                            style={{ height: layout.totalHeight }}
                        >
                            {blocks.map((block) => {
                                if(block.kind === "header"){
                                    return (
                                        <div
                                            key={block.key}
                                            className="absolute right-0 left-0 flex items-end pb-2 text-[calc(12.5px*var(--ui-scale))] font-semibold text-fg-dim"
                                            style={{ top: block.top, height: block.height }}
                                        >
                                            {block.label}
                                        </div>
                                    );
                                }
                                return (
                                    <div
                                        key={block.key}
                                        className="absolute flex"
                                        style={{ top: block.top, height: block.height, gap: GRID_GAP }}
                                    >
                                        {block.row.cells.map((cell) => (
                                            <Cell
                                                key={cell.item.id}
                                                id={cell.item.id}
                                                width={cell.width}
                                                height={cell.height}
                                                skeleton={mode === "loading"}
                                                layoutFlatIndex={indexById.get(cell.item.id) ?? -1}
                                                photo={cell.item}
                                            />
                                        ))}
                                    </div>
                                );
                            })}

                        </div>
                    ) : null}

                    {loadingMore ? (
                        <div className="py-4 text-center text-[calc(12px*var(--ui-scale))] text-fg-faint">Loading more…</div>
                    ) : null}
                </div>
                {showScrubber && marks !== null ? (
                    <Scrubber
                        marks={marks}
                        currentIndex={currentIndex}
                        rightInset={scrollbarW}
                        onJump={onJump}
                        scrollRef={grid.scrollRef}
                    />
                ) : null}
            </div>

            <SelectionBar />
        </div>
    );
}

/** Split out so each cell subscribes to only its own slice of selection state —
 *  otherwise selecting one photo re-renders the entire visible window.
 *
 *  Memoised on top of that. Every one of these hooks is a fresh store
 *  subscription on each render, and the whole visible window re-renders on
 *  every scroll frame — the grid's scroll position is state in `App`. Without
 *  the memo that is ~40 cells × 7 subscriptions per frame, which is what the
 *  scroll stutter was. */
const Cell = memo(function Cell(props: {
    id: number;
    photo: Photo;
    width: number;
    height: number;
    skeleton: boolean;
    layoutFlatIndex: number;
}){
    const { id, photo, width, height, skeleton, layoutFlatIndex } = props;

    const selected = useStore((s) => s.selectedIds.has(id));
    const anySelected = useStore((s) => s.selectedIds.size > 0);
    const hovered = useStore((s) => s.hoveredId === id);
    const focused = useStore((s) => s.focusedIndex === layoutFlatIndex);
    const toggleSelect = useStore((s) => s.toggleSelect);
    const setHovered = useStore((s) => s.setHovered);
    const openLightbox = useStore((s) => s.openLightbox);
    const setFocusedIndex = useStore((s) => s.setFocusedIndex);

    if(skeleton){
        return <SkeletonCell width={width} height={height} />;
    }

    return (
        <GridCell
            photo={photo}
            width={width}
            height={height}
            selected={selected}
            focused={focused}
            hovered={hovered}
            anySelected={anySelected}
            onOpen={() => {
                setFocusedIndex(layoutFlatIndex);
                // With a selection active, clicking extends it rather than
                // yanking the user into the lightbox.
                if(anySelected){
                    toggleSelect(id);
                }else{
                    openLightbox(layoutFlatIndex);
                }
            }}
            onToggleSelect={() => toggleSelect(id)}
            onHover={(h) => setHovered(h ? id : null)}
        />
    );
});

function EmptyLibrary(props: { onAddFolder: () => void }){
    return (
        <div className="flex min-h-[calc(400px*var(--ui-scale))] flex-col items-center justify-center gap-[calc(14px*var(--ui-scale))] py-24 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-[calc(14px*var(--ui-scale))] border-[calc(1.5px*var(--ui-scale))] border-dashed border-edge text-[calc(22px*var(--ui-scale))] text-fg-faint">
                +
            </div>
            <div className="text-[calc(15px*var(--ui-scale))] font-semibold">No folders yet</div>
            <div className="max-w-[calc(320px*var(--ui-scale))] text-[calc(13px*var(--ui-scale))] leading-[1.5] text-fg-dim">
                Add a photo or screenshot folder to start indexing. Everything stays on this machine.
            </div>
            <Button variant="primary" onClick={props.onAddFolder} className="mt-[calc(6px*var(--ui-scale))]">
                Add a folder
            </Button>
        </div>
    );
}

function EmptySearch(props: { query: string; similar: boolean; onClear: () => void }){
    return (
        <div className="flex min-h-[calc(400px*var(--ui-scale))] flex-col items-center justify-center gap-[calc(10px*var(--ui-scale))] py-24 text-center">
            <div className="text-[calc(26px*var(--ui-scale))] text-fg-faint">⌕</div>
            <div className="text-[calc(15px*var(--ui-scale))] font-semibold">
                {props.similar ? "No visually similar images" : `No results for "${props.query}"`}
            </div>
            <div className="text-[calc(13px*var(--ui-scale))] text-fg-dim">
                Try a broader term, or check another folder / filter.
            </div>
            <Button onClick={props.onClear} className="mt-[calc(6px*var(--ui-scale))]">
                Clear search
            </Button>
        </div>
    );
}

/** The collection picker that hangs off "Add to collection". */
function CollectionMenu(){
    const collections = useStore((s) => s.collections);
    const add = useStore((s) => s.addSelectionToCollection);
    const adding = useStore((s) => s.addingCollection);
    const name = useStore((s) => s.newCollectionName);
    const setName = useStore((s) => s.setNewCollectionName);
    const start = useStore((s) => s.startAddCollection);
    const commit = useStore((s) => s.commitCollection);
    const cancel = useStore((s) => s.cancelAddCollection);

    return (
        <div className="absolute bottom-full left-0 z-20 mb-2 min-w-[calc(180px*var(--ui-scale))] rounded-lg border border-edge bg-raised p-1 shadow-[var(--shadow-bar)]">
            {collections.map((c) => (
                <button
                    key={c.id}
                    type="button"
                    onClick={() => void add(c.id)}
                    className="w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded px-2 py-[calc(6px*var(--ui-scale))] text-left text-[calc(13px*var(--ui-scale))] text-fg-dim hover:bg-hover hover:text-fg"
                >
                    {c.name}
                </button>
            ))}
            {collections.length > 0 ? <div className="my-1 h-px bg-edge" /> : null}
            {adding ? (
                <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={cancel}
                    onKeyDown={(e) => {
                        if(e.key === "Enter"){
                            void commit();
                        }else if(e.key === "Escape"){
                            // Closes this box only; App's Esc would also clear
                            // the query or the selection behind it.
                            e.stopPropagation();
                            cancel();
                        }
                    }}
                    placeholder="Collection name"
                    className="w-full rounded border border-accent bg-raised px-2 py-[calc(5px*var(--ui-scale))] text-[calc(13px*var(--ui-scale))] text-fg outline-none"
                />
            ) : (
                <button
                    type="button"
                    onClick={start}
                    className="w-full cursor-pointer rounded px-2 py-[calc(6px*var(--ui-scale))] text-left text-[calc(13px*var(--ui-scale))] text-fg-faint hover:bg-hover hover:text-fg-dim"
                >
                    + New collection
                </button>
            )}
        </div>
    );
}

function SelectionBar(){
    const count = useStore((s) => s.selectedIds.size);
    const clear = useStore((s) => s.clearSelection);
    const menuOpen = useStore((s) => s.collectionMenuOpen);
    const toggleMenu = useStore((s) => s.toggleCollectionMenu);
    const reveal = useStore((s) => s.revealSelected);
    const del = useStore((s) => s.requestDelete);

    if(count === 0){
        return null;
    }

    return (
        <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-[calc(10px*var(--ui-scale))] rounded-xl border border-edge bg-raised py-2 pr-[calc(10px*var(--ui-scale))] pl-4 shadow-[var(--shadow-bar)]">
            <span className="whitespace-nowrap text-[calc(12.5px*var(--ui-scale))] text-fg-dim">{count} selected</span>
            <div className="h-5 w-px bg-edge" />
            <div className="relative">
                <Button variant="subtle" onClick={toggleMenu}>
                    Add to collection {menuOpen ? "▴" : "▾"}
                </Button>
                {menuOpen ? <CollectionMenu /> : null}
            </div>
            <Button variant="subtle" onClick={() => void reveal()}>Reveal in files</Button>
            <Button variant="danger" onClick={del}>Move to trash</Button>
            <button
                type="button"
                onClick={clear}
                aria-label="Clear selection"
                className="cursor-pointer px-1 text-[calc(14px*var(--ui-scale))] text-fg-faint hover:text-fg"
            >
                ✕
            </button>
        </div>
    );
}
