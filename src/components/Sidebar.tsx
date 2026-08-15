import { useStore } from "../lib/store";
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

export function Sidebar(){
    const collapsed = useStore((s) => s.sidebarCollapsed);
    return (
        <div
            className="flex-shrink-0 overflow-hidden border-r border-edge bg-panel transition-[width] duration-150"
            style={{ width: collapsed ? 0 : 240 }}
        >
            <div className="h-full w-[240px] overflow-y-auto px-[10px] pt-[14px] pb-14">
                <LibrarySection />
                <CollectionsSection />
                <SavedSearchesSection />
                <FiltersSection />
            </div>
        </div>
    );
}

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
                "mb-px flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-[7px] text-left text-[13px] transition-colors " +
                (active ? "bg-accent-muted text-accent-text" : "text-fg-dim hover:bg-hover")
            }
        >
            <span>{label}</span>
            {count !== undefined ? (
                <span
                    className={
                        "rounded-[9px] px-[7px] py-px text-[11px] tabular-nums " +
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
    const total = useStore((s) => s.total);
    const results = useStore((s) => s.results);

    const dupes = results.filter((r) => r.isDupe).length;
    const isActive = (v: LibraryView) => activeCollection === null && libraryView === v;

    return (
        <>
            <div className="flex items-center justify-between px-[6px] pb-[10px]">
                <span className="text-[11px] font-semibold tracking-[0.06em] text-fg-faint">
                    LIBRARY
                </span>
                <button
                    type="button"
                    onClick={toggleSidebar}
                    aria-label="Collapse sidebar"
                    className="cursor-pointer text-[12px] text-fg-faint hover:text-fg"
                >
                    ◀
                </button>
            </div>
            <NavRow
                label="All"
                active={isActive("all")}
                count={total}
                onClick={() => setLibraryView("all")}
            />
            <NavRow label="Recent" active={isActive("recent")} onClick={() => setLibraryView("recent")} />
            <NavRow
                label="Duplicates"
                active={isActive("dupes")}
                count={dupes}
                onClick={() => setLibraryView("dupes")}
            />
        </>
    );
}

function CollectionsSection(){
    const collections = useStore((s) => s.collections);
    const active = useStore((s) => s.activeCollection);
    const setActive = useStore((s) => s.setActiveCollection);
    const adding = useStore((s) => s.addingCollection);
    const name = useStore((s) => s.newCollectionName);
    const setName = useStore((s) => s.setNewCollectionName);
    const start = useStore((s) => s.startAddCollection);
    const commit = useStore((s) => s.commitCollection);
    const cancel = useStore((s) => s.cancelAddCollection);

    return (
        <>
            <SectionLabel>COLLECTIONS</SectionLabel>
            {collections.map((c) => (
                <button
                    key={c.id}
                    type="button"
                    onClick={() => setActive(c.id)}
                    className={
                        "mb-px w-full cursor-pointer rounded-md px-2 py-[7px] text-left text-[13px] transition-colors " +
                        (active === c.id
                            ? "bg-accent-muted text-accent-text"
                            : "text-fg-dim hover:bg-hover")
                    }
                >
                    {c.name}
                </button>
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
                            cancel();
                        }
                    }}
                    placeholder="Collection name"
                    className="mt-px w-full rounded-md border border-accent bg-raised px-2 py-[6px] text-[13px] text-fg outline-none"
                />
            ) : (
                <button
                    type="button"
                    onClick={start}
                    className="w-full cursor-pointer rounded-md px-2 py-[7px] text-left text-[13px] text-fg-faint hover:bg-hover hover:text-fg-dim"
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
    return (
        <>
            <SectionLabel>SAVED SEARCHES</SectionLabel>
            {saved.map((s) => (
                <button
                    key={s.id}
                    type="button"
                    onClick={() => run(s.query)}
                    className="mb-px flex w-full cursor-pointer items-center gap-[6px] rounded-md px-2 py-[7px] text-left text-[13px] text-fg-dim hover:bg-hover"
                >
                    <span className="text-[11px] text-fg-faint">⌕</span>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">{s.query}</span>
                </button>
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
                className="flex w-full cursor-pointer items-center justify-between px-2 py-[6px] text-[13px] text-fg-dim hover:text-fg"
            >
                <span>{props.title}</span>
                <span className="text-[10px] text-fg-faint">{props.open ? "▾" : "▸"}</span>
            </button>
            {props.open ? <div className="px-2 pt-1 pb-[10px]">{props.children}</div> : null}
        </div>
    );
}

function FiltersSection(){
    const filters = useStore((s) => s.filters);
    const open = useStore((s) => s.filtersOpen);
    const toggleSection = useStore((s) => s.toggleFilterSection);
    const setDatePreset = useStore((s) => s.setDatePreset);
    const toggleFolder = useStore((s) => s.toggleFolderFilter);
    const toggleType = useStore((s) => s.toggleTypeFilter);
    const setDims = useStore((s) => s.setDimsFilter);
    const clearAll = useStore((s) => s.clearAllFilters);
    const folders = useStore((s) => s.folders);

    const activeCount =
        filters.folders.length +
        filters.types.length +
        (filters.datePreset !== null ? 1 : 0) +
        (filters.dims !== null ? 1 : 0);

    return (
        <>
            <SectionLabel
                action={
                    activeCount > 0 ? (
                        <button
                            type="button"
                            onClick={clearAll}
                            className="cursor-pointer text-[11px] text-accent-text hover:underline"
                        >
                            Clear all ({activeCount})
                        </button>
                    ) : undefined
                }
            >
                FILTERS
            </SectionLabel>

            <FilterGroup title="Date taken" open={open.date} onToggle={() => toggleSection("date")}>
                <div className="flex flex-wrap gap-[6px]">
                    {DATE_PRESETS.map((d) => (
                        <Chip
                            key={d.key}
                            label={d.label}
                            active={filters.datePreset === d.key}
                            onClick={() => setDatePreset(d.key)}
                        />
                    ))}
                </div>
            </FilterGroup>

            <FilterGroup title="Source folder" open={open.folder} onToggle={() => toggleSection("folder")}>
                {folders.length === 0 ? (
                    <div className="text-[12px] text-fg-faint">No folders watched yet.</div>
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
                <div className="flex gap-[6px]">
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
                <div className="flex gap-[6px]">
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
