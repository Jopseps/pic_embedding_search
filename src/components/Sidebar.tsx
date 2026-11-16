import { memo, useEffect, useRef, useState } from "react";
import { SIDEBAR_DEFAULT_W, SIDEBAR_SNAP_W, useStore } from "../lib/store";
import { fmtCount } from "../lib/format";
import { Chip, CheckRow, SectionLabel } from "./ui";
import type { DatePreset, DimsFilter, LibraryView, PhotoKind } from "../lib/types";

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week", label: "This week" },
    { key: "month", label: "This month" },
    { key: "year", label: "This year" },
];

const TYPES: PhotoKind[] = ["Photo", "Screenshot"];

const DIMS: { key: DimsFilter; label: string }[] = [
    { key: "large", label: "Large" },
    { key: "small", label: "Small" },
];

/** Memoised for the same reason as `TopBar`: nothing here moves with the
 *  grid's scroll position, and `App` re-renders on every frame of it. */
export const Sidebar = memo(function Sidebar(){
    const collapsed = useStore((s) => s.sidebarCollapsed);
    const width = useStore((s) => s.sidebarWidth);
    const setWidth = useStore((s) => s.setSidebarWidth);
    const setCollapsed = useStore((s) => s.setSidebarCollapsed);
    const [dragging, setDragging] = useState(false);
    const shell = useRef<HTMLDivElement>(null);

    function onPointerDown(e: React.PointerEvent){
        if(e.button !== 0){
            return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
    }

    function onPointerMove(e: React.PointerEvent){
        if(!dragging || shell.current === null){
            return;
        }
        const w = e.clientX - shell.current.getBoundingClientRect().left;
        if(w < SIDEBAR_SNAP_W){
            setCollapsed(true);
            return;
        }
        setCollapsed(false);
        setWidth(w, false);
    }

    function endDrag(e: React.PointerEvent){
        if(e.currentTarget.hasPointerCapture(e.pointerId)){
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        if(dragging){
            setWidth(useStore.getState().sidebarWidth);   // the release makes it final
        }
        setDragging(false);
    }

    return (
        <div
            ref={shell}
            className={
                "relative flex-shrink-0 overflow-hidden border-r border-edge bg-panel "
                // Animating width while the pointer drives it fights the pointer:
                // the panel lags a frame behind the handle the whole way.
                + (dragging ? "" : "transition-[width] duration-150")
            }
            style={{ width: collapsed ? 0 : width }}
        >
            <div
                className="h-full overflow-y-auto px-[calc(10px*var(--ui-scale))] pt-[calc(14px*var(--ui-scale))] pb-14"
                // Pinned to the target width so the collapse animation slides the
                // panel out instead of reflowing every row down to nothing.
                style={{ width }}
            >
                <LibrarySection />
                <CollectionsSection />
                <SavedSearchesSection />
                <FiltersSection />
            </div>

            {/* Kept mounted while dragging even after a snap to collapsed —
                unmounting it there drops the pointer capture and the panel can
                never be dragged back open in the same gesture. */}
            {collapsed && !dragging ? null : (
                <div
                    role="separator"
                    aria-label="Resize sidebar"
                    aria-orientation="vertical"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_W)}
                    className={
                        "absolute top-0 right-0 z-[6] h-full w-[calc(6px*var(--ui-scale))] cursor-col-resize "
                        + (dragging ? "bg-accent/40" : "hover:bg-accent/30")
                    }
                />
            )}
        </div>
    );
});

function NavRow(props: {
    label: string;
    active: boolean;
    count?: number;
    onClick: () => void;
}){
    const { label, active, count, onClick } = props;
    return (
        <button
            type="button"
            onClick={onClick}
            className={
                "mb-px flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-[calc(7px*var(--ui-scale))] text-left text-[calc(13px*var(--ui-scale))] transition-colors " +
                (active ? "bg-accent-muted text-accent-text" : "text-fg-dim hover:bg-hover")
            }
        >
            <span>{label}</span>
            {count !== undefined ? (
                <span
                    className={
                        "rounded-[calc(9px*var(--ui-scale))] px-[calc(7px*var(--ui-scale))] py-px text-[calc(11px*var(--ui-scale))] tabular-nums " +
                        (active ? "text-accent-text" : "bg-hover text-fg-faint")
                    }
                >
                    {fmtCount(count)}
                </span>
            ) : null}
        </button>
    );
}

function LibrarySection(){
    const libraryView = useStore((s) => s.libraryView);
    const activeCollection = useStore((s) => s.activeCollection);
    const setLibraryView = useStore((s) => s.setLibraryView);
    const toggleSidebar = useStore((s) => s.toggleSidebar);
    // Library-wide, from /counts. Reading these off the current search made
    // "All" show however many results the query returned.
    const counts = useStore((s) => s.counts);
    const isActive = (v: LibraryView) => activeCollection === null && libraryView === v;

    return (
        <>
            <div className="flex items-center justify-between px-[calc(6px*var(--ui-scale))] pb-[calc(10px*var(--ui-scale))]">
                <span className="text-[calc(11px*var(--ui-scale))] font-semibold tracking-[0.06em] text-fg-faint">
                    LIBRARY
                </span>
                <button
                    type="button"
                    onClick={toggleSidebar}
                    aria-label="Collapse sidebar"
                    className="cursor-pointer text-[calc(12px*var(--ui-scale))] text-fg-faint hover:text-fg"
                >
                    ◀
                </button>
            </div>
            <NavRow
                label="All"
                active={isActive("all")}
                count={counts.library}
                onClick={() => setLibraryView("all")}
            />
            <NavRow
                label="Recent"
                active={isActive("recent")}
                count={counts.recent}
                onClick={() => setLibraryView("recent")}
            />
            <NavRow
                label="Duplicates"
                active={isActive("dupes")}
                count={counts.dupes}
                onClick={() => setLibraryView("dupes")}
            />
        </>
    );
}

function CollectionsSection(){
    const collections = useStore((s) => s.collections);
    const counts = useStore((s) => s.counts.collections);
    const active = useStore((s) => s.activeCollection);
    const setActive = useStore((s) => s.setActiveCollection);
    const remove = useStore((s) => s.deleteCollection);
    const pendingDelete = useStore((s) => s.pendingCollectionDelete);
    const cancelDelete = useStore((s) => s.cancelDeleteCollection);
    const adding = useStore((s) => s.addingCollection);
    const name = useStore((s) => s.newCollectionName);
    const setName = useStore((s) => s.setNewCollectionName);
    const start = useStore((s) => s.startAddCollection);
    const commit = useStore((s) => s.commitCollection);
    const cancel = useStore((s) => s.cancelAddCollection);
    const dropTarget = useStore((s) => s.dragOut.overCollection);

    return (
        <>
            <SectionLabel>COLLECTIONS</SectionLabel>
            {collections.map((c) => (
                <div
                    key={c.id}
                    // The gesture machine finds this row with `elementFromPoint`
                    // rather than HTML5 dragover: the drag is a plain pointer
                    // drag until it leaves the window, and mixing the two drag
                    // protocols would also fight App's find-similar file drop.
                    data-collection-id={c.id}
                    className={
                        "group mb-px flex items-center rounded-md transition-colors "
                        + (dropTarget === c.id
                            ? "ring-2 ring-accent ring-inset bg-accent-muted text-accent-text "
                            : "")
                        + (active === c.id
                            ? "bg-accent-muted text-accent-text"
                            : "text-fg-dim hover:bg-hover")
                    }
                >
                    <button
                        type="button"
                        onClick={() => setActive(c.id)}
                        className="flex flex-1 cursor-pointer items-center justify-between gap-2 overflow-hidden px-2 py-[calc(7px*var(--ui-scale))] text-left text-[calc(13px*var(--ui-scale))]"
                    >
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{c.name}</span>
                        {counts[c.id] !== undefined && counts[c.id]! > 0 ? (
                            <span className="shrink-0 text-[calc(11px*var(--ui-scale))] tabular-nums text-fg-faint">
                                {fmtCount(counts[c.id]!)}
                            </span>
                        ) : null}
                    </button>
                    {/* Armed on the first click, confirmed on the second. The
                        collection is cheap to recreate; its membership is not. */}
                    <button
                        type="button"
                        title={pendingDelete === c.id ? "Click again to delete" : `Delete "${c.name}"`}
                        onClick={() => void remove(c.id)}
                        onBlur={cancelDelete}
                        className={
                            "mr-1 cursor-pointer rounded px-[calc(6px*var(--ui-scale))] py-[calc(2px*var(--ui-scale))] text-[calc(11px*var(--ui-scale))] hover:bg-hover " +
                            (pendingDelete === c.id
                                ? "block text-danger"
                                : "hidden text-[calc(13px*var(--ui-scale))] text-fg-faint hover:text-fg group-hover:block")
                        }
                    >
                        {pendingDelete === c.id ? "Delete?" : "×"}
                    </button>
                </div>
            ))}
            {adding ? (
                <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={cancel}
                    onKeyDown={(e) => {
                        if(e.key === "Enter"){
                            commit();
                        }else if(e.key === "Escape"){
                            e.stopPropagation();
                            cancel();
                        }
                    }}
                    placeholder="Collection name"
                    className="mt-px w-full rounded-md border border-accent bg-raised px-2 py-[calc(6px*var(--ui-scale))] text-[calc(13px*var(--ui-scale))] text-fg outline-none"
                />
            ) : (
                <button
                    type="button"
                    onClick={start}
                    className="w-full cursor-pointer rounded-md px-2 py-[calc(7px*var(--ui-scale))] text-left text-[calc(13px*var(--ui-scale))] text-fg-faint hover:bg-hover hover:text-fg-dim"
                >
                    + New collection
                </button>
            )}
        </>
    );
}

function SavedSearchesSection(){
    const saved = useStore((s) => s.savedSearches);
    const run = useStore((s) => s.runSavedSearch);
    const remove = useStore((s) => s.deleteSavedSearch);
    if(saved.length === 0){
        return null;   // an empty labelled section is just noise
    }
    return (
        <>
            <SectionLabel>SAVED SEARCHES</SectionLabel>
            {saved.map((s) => (
                <div
                    key={s.id}
                    className="group mb-px flex items-center rounded-md text-fg-dim hover:bg-hover"
                >
                    <button
                        type="button"
                        // The whole saved search, not just the text: it restores
                        // the filters and view it was saved with.
                        onClick={() => run(s)}
                        title={s.query}
                        className="flex flex-1 cursor-pointer items-center gap-[calc(6px*var(--ui-scale))] overflow-hidden px-2 py-[calc(7px*var(--ui-scale))] text-left text-[calc(13px*var(--ui-scale))]"
                    >
                        <span className="text-[calc(11px*var(--ui-scale))] text-fg-faint">⌕</span>
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{s.query}</span>
                    </button>
                    <button
                        type="button"
                        title="Delete saved search"
                        onClick={() => void remove(s.id)}
                        className="mr-1 hidden cursor-pointer rounded px-[calc(6px*var(--ui-scale))] py-[calc(2px*var(--ui-scale))] text-[calc(13px*var(--ui-scale))] text-fg-faint hover:bg-hover hover:text-fg group-hover:block"
                    >
                        ×
                    </button>
                </div>
            ))}
        </>
    );
}

function FilterGroup(props: {
    title: string;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}){
    return (
        <div className="mb-px">
            <button
                type="button"
                onClick={props.onToggle}
                className="flex w-full cursor-pointer items-center justify-between px-2 py-[calc(6px*var(--ui-scale))] text-[calc(13px*var(--ui-scale))] text-fg-dim hover:text-fg"
            >
                <span>{props.title}</span>
                <span className="text-[calc(10px*var(--ui-scale))] text-fg-faint">{props.open ? "▾" : "▸"}</span>
            </button>
            {props.open ? <div className="px-2 pt-1 pb-[calc(10px*var(--ui-scale))]">{props.children}</div> : null}
        </div>
    );
}

/** A full `YYYY-MM-DD` from 1900 on. The year floor is what makes one rule fit
 *  both engines: Chrome's picker reports `0002-05-30` while a year is still
 *  being typed, and where `type="date"` is unsupported the field is plain text
 *  and reports every keystroke raw. */
function completeDay(v: string): boolean{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0, 4)) < 1900){
        return false;
    }
    const d = new Date(`${v}T12:00:00`);
    return !Number.isNaN(d.getTime()) && d.getDate() === Number(v.slice(8, 10));
}

/**
 * One end of the custom range. The draft is local so a half-typed date never
 * reaches the search; it commits the moment it is a whole date, or empty.
 */
function DateField(props: { label: string; value: string | null; onCommit: (v: string | null) => void }){
    const { label, value, onCommit } = props;
    const [draft, setDraft] = useState(value ?? "");

    // A preset click or "Clear all" empties the range from outside.
    useEffect(() => {
        setDraft(value ?? "");
    }, [value]);

    const bad = draft !== "" && !completeDay(draft);
    return (
        <label className="flex items-center gap-[calc(8px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg-dim">
            <span className="w-[calc(34px*var(--ui-scale))] flex-shrink-0">{label}</span>
            <input
                type="date"
                value={draft}
                placeholder="YYYY-MM-DD"
                onChange={(e) => {
                    const v = e.target.value;
                    setDraft(v);
                    if(v === ""){
                        onCommit(null);
                    }else if(completeDay(v)){
                        onCommit(v);
                    }
                }}
                aria-invalid={bad}
                className={
                    "min-w-0 flex-1 rounded-md border bg-raised px-[calc(7px*var(--ui-scale))] py-[calc(4px*var(--ui-scale))] font-mono text-[calc(11.5px*var(--ui-scale))] text-fg outline-none focus:border-accent " +
                    (bad ? "border-accent" : "border-edge")
                }
            />
            {value !== null ? (
                <button
                    type="button"
                    onClick={() => {
                        setDraft("");
                        onCommit(null);
                    }}
                    aria-label={`Clear ${label.toLowerCase()} date`}
                    className="cursor-pointer px-[calc(2px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg-faint hover:text-fg"
                >
                    ✕
                </button>
            ) : null}
        </label>
    );
}

function FiltersSection(){
    const filters = useStore((s) => s.filters);
    const open = useStore((s) => s.filtersOpen);
    const toggleSection = useStore((s) => s.toggleFilterSection);
    const setDatePreset = useStore((s) => s.setDatePreset);
    const setDateRange = useStore((s) => s.setDateRange);
    const toggleFolder = useStore((s) => s.toggleFolderFilter);
    const toggleType = useStore((s) => s.toggleTypeFilter);
    const setDims = useStore((s) => s.setDimsFilter);
    const clearAll = useStore((s) => s.clearAllFilters);
    const folders = useStore((s) => s.folders);

    const activeCount =
        filters.folders.length +
        filters.types.length +
        (filters.datePreset !== null ? 1 : 0) +
        (filters.dateFrom !== null || filters.dateTo !== null ? 1 : 0) +
        (filters.dims !== null ? 1 : 0);

    return (
        <>
            <SectionLabel
                action={
                    activeCount > 0 ? (
                        <button
                            type="button"
                            onClick={clearAll}
                            className="cursor-pointer text-[calc(11px*var(--ui-scale))] text-accent-text hover:underline"
                        >
                            Clear all ({activeCount})
                        </button>
                    ) : undefined
                }
            >
                FILTERS
            </SectionLabel>

            <FilterGroup title="Date taken" open={open.date} onToggle={() => toggleSection("date")}>
                <div className="flex flex-wrap gap-[calc(6px*var(--ui-scale))]">
                    {DATE_PRESETS.map((d) => (
                        <Chip
                            key={d.key}
                            label={d.label}
                            active={filters.datePreset === d.key}
                            onClick={() => setDatePreset(d.key)}
                        />
                    ))}
                </div>
                <div className="mt-[calc(10px*var(--ui-scale))] flex flex-col gap-[calc(6px*var(--ui-scale))]">
                    <DateField
                        label="From"
                        value={filters.dateFrom}
                        onCommit={(v) => setDateRange(v, filters.dateTo)}
                    />
                    <DateField
                        label="To"
                        value={filters.dateTo}
                        onCommit={(v) => setDateRange(filters.dateFrom, v)}
                    />
                    {filters.dateFrom !== null && filters.dateTo !== null && filters.dateFrom > filters.dateTo ? (
                        <div className="text-[calc(11px*var(--ui-scale))] text-fg-faint">From is after To — nothing can match.</div>
                    ) : null}
                </div>
            </FilterGroup>

            <FilterGroup title="Source folder" open={open.folder} onToggle={() => toggleSection("folder")}>
                {folders.length === 0 ? (
                    <div className="text-[calc(12px*var(--ui-scale))] text-fg-faint">No folders watched yet.</div>
                ) : (
                    folders.map((f) => (
                        <CheckRow
                            key={f.path}
                            label={f.path}
                            mono
                            checked={filters.folders.includes(f.path)}
                            onToggle={() => toggleFolder(f.path)}
                        />
                    ))
                )}
            </FilterGroup>

            <FilterGroup title="File type" open={open.type} onToggle={() => toggleSection("type")}>
                <div className="flex gap-[calc(6px*var(--ui-scale))]">
                    {TYPES.map((t) => (
                        <Chip
                            key={t}
                            label={t}
                            active={filters.types.includes(t)}
                            onClick={() => toggleType(t)}
                        />
                    ))}
                </div>
            </FilterGroup>

            <FilterGroup title="Dimensions" open={open.dims} onToggle={() => toggleSection("dims")}>
                <div className="flex gap-[calc(6px*var(--ui-scale))]">
                    {DIMS.map((d) => (
                        <Chip
                            key={d.key}
                            label={d.label}
                            active={filters.dims === d.key}
                            onClick={() => setDims(d.key)}
                        />
                    ))}
                </div>
            </FilterGroup>
        </>
    );
}
