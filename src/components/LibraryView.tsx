import { useMemo } from "react";
import { useStore } from "../lib/store";
import { GRID_GAP } from "../lib/catalog";
import { visibleRange } from "../lib/grid";
import { GRID_PAD_X, type GridLayoutHandle } from "../lib/useGridLayout";
import { fmtCount } from "../lib/format";
import { GridCell, SkeletonCell } from "./GridCell";
import { Button } from "./ui";
import type { Photo } from "../lib/types";

const ZOOM_DOTS = [6, 9, 12];

export function LibraryView(props: { grid: GridLayoutHandle }){
    const { grid } = props;
    const { layout, mode, scrollRef, scrollTop, viewportHeight } = grid;

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
    const addFolder = useStore((s) => s.addFolder);

    const isSearch = mode === "results" || mode === "emptySearch";
    const title = useMemo(() => {
        if(isSearch){
            return similarTo !== null ? "Visually similar" : "Search results";
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

    // Month header currently scrolled past — pinned so the date context never
    // disappears, which plain absolute positioning would otherwise lose.
    const stickyLabel = useMemo(() => {
        if(mode !== "idle"){
            return null;
        }
        let label: string | null = null;
        for(const b of layout.blocks){
            if(b.kind === "header" && b.top <= scrollTop + 1){
                label = b.label;
            }else if(b.top > scrollTop + 1){
                break;
            }
        }
        return label;
    }, [layout.blocks, scrollTop, mode]);

    return (
        <div className="relative flex min-w-0 flex-1 flex-col">
            <div className="flex flex-shrink-0 items-center justify-between px-5 pt-[14px] pb-[6px]">
                <div>
                    <div className="text-[15px] font-semibold">{title}</div>
                    {mode === "results" ? (
                        <div className="mt-[2px] text-[12px] tabular-nums text-fg-faint">
                            {fmtCount(total)} result{total === 1 ? "" : "s"} · {tookMs} ms
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
                                    width: dot,
                                    height: dot,
                                    background: density === i
                                        ? "var(--text-primary)"
                                        : "var(--text-tertiary)",
                                }}
                            />
                        </button>
                    ))}
                </div>
            </div>

            <div
                ref={scrollRef}
                className="relative flex-1 overflow-y-auto pt-2 pb-[90px]"
                style={{ paddingLeft: GRID_PAD_X, paddingRight: GRID_PAD_X }}
            >
                {stickyLabel !== null ? (
                    <div className="pointer-events-none sticky top-0 z-[2] -mx-5 bg-canvas px-5 pt-[10px] pb-2 text-[12.5px] font-semibold text-fg-dim">
                        {stickyLabel}
                    </div>
                ) : null}

                {mode === "emptyLibrary" ? (
                    <EmptyLibrary onAddFolder={() => void addFolder()} />
                ) : null}

                {mode === "emptySearch" ? (
                    <EmptySearch query={query} similar={similarTo !== null} onClear={clearQuery} />
                ) : null}

                {layout.totalHeight > 0 ? (
                    <div className="relative" style={{ height: layout.totalHeight }}>
                        {blocks.map((block) => {
                            if(block.kind === "header"){
                                return (
                                    <div
                                        key={block.key}
                                        className="absolute right-0 left-0 flex items-end pb-2 text-[12.5px] font-semibold text-fg-dim"
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
            </div>

            <SelectionBar />
        </div>
    );
}

/** Split out so each cell subscribes to only its own slice of selection state —
 *  otherwise selecting one photo re-renders the entire visible window. */
function Cell(props: {
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
}

function EmptyLibrary(props: { onAddFolder: () => void }){
    return (
        <div className="flex min-h-[400px] flex-col items-center justify-center gap-[14px] py-24 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-edge text-[22px] text-fg-faint">
                +
            </div>
            <div className="text-[15px] font-semibold">No folders yet</div>
            <div className="max-w-[320px] text-[13px] leading-[1.5] text-fg-dim">
                Add a photo or screenshot folder to start indexing. Everything stays on this machine.
            </div>
            <Button variant="primary" onClick={props.onAddFolder} className="mt-[6px]">
                Add a folder
            </Button>
        </div>
    );
}

function EmptySearch(props: { query: string; similar: boolean; onClear: () => void }){
    return (
        <div className="flex min-h-[400px] flex-col items-center justify-center gap-[10px] py-24 text-center">
            <div className="text-[26px] text-fg-faint">⌕</div>
            <div className="text-[15px] font-semibold">
                {props.similar ? "No visually similar images" : `No results for "${props.query}"`}
            </div>
            <div className="text-[13px] text-fg-dim">
                Try a broader term, or check another folder / filter.
            </div>
            <Button onClick={props.onClear} className="mt-[6px]">
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
        <div className="absolute bottom-full left-0 z-20 mb-2 min-w-[180px] rounded-lg border border-edge bg-raised p-1 shadow-[var(--shadow-bar)]">
            {collections.map((c) => (
                <button
                    key={c.id}
                    type="button"
                    onClick={() => void add(c.id)}
                    className="w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded px-2 py-[6px] text-left text-[13px] text-fg-dim hover:bg-hover hover:text-fg"
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
                            cancel();
                        }
                    }}
                    placeholder="Collection name"
                    className="w-full rounded border border-accent bg-raised px-2 py-[5px] text-[13px] text-fg outline-none"
                />
            ) : (
                <button
                    type="button"
                    onClick={start}
                    className="w-full cursor-pointer rounded px-2 py-[6px] text-left text-[13px] text-fg-faint hover:bg-hover hover:text-fg-dim"
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
    const del = useStore((s) => s.deleteSelected);

    if(count === 0){
        return null;
    }

    return (
        <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-[10px] rounded-xl border border-edge bg-raised py-2 pr-[10px] pl-4 shadow-[var(--shadow-bar)]">
            <span className="whitespace-nowrap text-[12.5px] text-fg-dim">{count} selected</span>
            <div className="h-5 w-px bg-edge" />
            <div className="relative">
                <Button variant="subtle" onClick={toggleMenu}>
                    Add to collection {menuOpen ? "▴" : "▾"}
                </Button>
                {menuOpen ? <CollectionMenu /> : null}
            </div>
            <Button variant="subtle" onClick={() => void reveal()}>Reveal in files</Button>
            <Button variant="danger" onClick={() => void del()}>Delete</Button>
            <button
                type="button"
                onClick={clear}
                aria-label="Clear selection"
                className="cursor-pointer px-1 text-[14px] text-fg-faint hover:text-fg"
            >
                ✕
            </button>
        </div>
    );
}
