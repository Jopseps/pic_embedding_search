import { memo, useCallback, useEffect, useRef, useState } from "react";
import { activeSort, useStore } from "../lib/store";
import { SORT_OPTIONS } from "../lib/catalog";
import { fmtCount, fmtDecimal, fmtEta } from "../lib/format";
import { fmtBytes, fmtTransfer } from "../lib/transfer";
import { useT } from "../lib/i18n/useT";
import { Icon } from "./Icon";

const RING_CIRCUMFERENCE = 37.7;

/** Close a popover on a press outside `ref` or on Escape. Capture, and Escape
 *  stopped: App's own Escape would otherwise also clear the query. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>){
    useEffect(() => {
        if(!open){
            return;
        }
        const onDown = (e: PointerEvent) => {
            if(!ref.current?.contains(e.target as Node)){
                close();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if(e.key === "Escape"){
                e.stopPropagation();
                close();
            }
        };
        window.addEventListener("pointerdown", onDown, { capture: true });
        window.addEventListener("keydown", onKey, { capture: true });
        return () => {
            window.removeEventListener("pointerdown", onDown, { capture: true });
            window.removeEventListener("keydown", onKey, { capture: true });
        };
    }, [open, close, ref]);
}

/** Memoised: `App` re-renders on every scroll frame — the grid's scroll
 *  position is state up there — and the top bar depends on none of it. */
export const TopBar = memo(function TopBar(){
    const t = useT();
    const query = useStore((s) => s.query);
    const searching = useStore((s) => s.searching);
    // A re-index no longer disables search: the outgoing model keeps answering
    // until the incoming one has full coverage.
    const reindexActive = useStore((s) => s.reindex.active);
    const modelPct = useStore(servingModelPercent);
    // A first download that failed (offline): nothing to search with until
    // the Download button in Settings fetches it.
    const modelMissing = useStore((s) => s.models[s.settings.modelId]?.downloaded === false) && modelPct === null;
    const setQuery = useStore((s) => s.setQuery);
    const clearQuery = useStore((s) => s.clearQuery);
    const saveSearch = useStore((s) => s.saveCurrentSearch);
    const setView = useStore((s) => s.setView);
    const view = useStore((s) => s.view);
    const inputRef = useRef<HTMLInputElement>(null);

    // `/` focuses search from anywhere; App owns the key handler and pokes here.
    useEffect(() => {
        const focus = () => inputRef.current?.focus();
        window.addEventListener("picsearch:focus-search", focus);
        const timer = setTimeout(focus, 60);
        return () => {
            window.removeEventListener("picsearch:focus-search", focus);
            clearTimeout(timer);
        };
    }, []);

    return (
        <div className="flex h-[calc(56px*var(--ui-scale))] flex-shrink-0 items-center gap-[calc(14px*var(--ui-scale))] border-b border-edge bg-panel px-4">
            <div className="flex h-[calc(34px*var(--ui-scale))] w-[calc(280px*var(--ui-scale))] max-w-[44vw] flex-shrink-0 items-center gap-2 rounded-lg border border-edge bg-raised px-[calc(10px*var(--ui-scale))]">
                <Icon name="search" size={18} className="text-fg-faint" />
                <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    // First run: the serving model is still downloading, and a query has nothing to embed with.
                    disabled={modelPct !== null || modelMissing}
                    placeholder={
                        modelPct !== null
                            ? t("topbar.searchPlaceholderModel", { percent: modelPct })
                            : modelMissing
                            ? t("topbar.searchPlaceholderNoModel")
                            : t(reindexActive ? "topbar.searchPlaceholderReindex" : "topbar.searchPlaceholder")
                    }
                    className="min-w-0 flex-1 border-none bg-transparent text-[calc(13px*var(--ui-scale))] text-fg outline-none placeholder:text-fg-faint disabled:cursor-not-allowed"
                />
                {searching ? (
                    <span
                        className="h-[calc(9px*var(--ui-scale))] w-[calc(9px*var(--ui-scale))] flex-shrink-0 rounded-full border-[calc(1.5px*var(--ui-scale))] border-edge border-t-accent"
                        style={{ animation: "spin 0.7s linear infinite" }}
                    />
                ) : null}
                {query !== "" ? (
                    <button
                        type="button"
                        onClick={clearQuery}
                        className="flex cursor-pointer rounded-full p-[calc(2px*var(--ui-scale))] text-fg-faint hover:bg-hover hover:text-fg"
                        aria-label={t("topbar.clearSearch")}
                        title={t("topbar.clearSearch")}
                    >
                        <Icon name="close" size={16} />
                    </button>
                ) : null}
            </div>

            {/* Saving stores the filters too, so it only appears once there is
                a query to attach them to. */}
            {query.trim() !== "" ? (
                <button
                    type="button"
                    onClick={() => void saveSearch()}
                    title={t("topbar.saveTitle")}
                    aria-label={t("topbar.saveAria")}
                    className="flex h-[calc(32px*var(--ui-scale))] w-[calc(32px*var(--ui-scale))] flex-shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-dim hover:bg-hover hover:text-fg"
                >
                    <Icon name="bookmark_add" />
                </button>
            ) : null}

            <SortMenu />

            <div className="flex-1" />

            <ModelDownloadPill />

            <IndexingIndicator />

            <button
                type="button"
                onClick={() => setView(view === "settings" ? "library" : "settings")}
                aria-label={t("topbar.settings")}
                title={t("topbar.settings")}
                className={
                    "flex h-[calc(36px*var(--ui-scale))] w-[calc(36px*var(--ui-scale))] flex-shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-hover " +
                    (view === "settings" ? "bg-accent-muted text-accent-text" : "text-fg-dim")
                }
            >
                <Icon name="settings" size={22} />
            </button>
        </div>
    );
});

/**
 * The order of the grid. Browsing writes the choice to config.toml; with a
 * query typed it is session-only and starts at Relevance, which is the only
 * entry that exists while searching.
 */
function SortMenu(){
    const t = useT();
    const sort = useStore(activeSort);
    const searching = useStore((s) => s.query.trim() !== "");
    const similar = useStore((s) => s.similarTo !== null);
    const setSort = useStore((s) => s.setSort);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismiss(open, close, rootRef);

    // "Find similar" is ordered by similarity and nothing else.
    if(similar){
        return null;
    }
    const options = SORT_OPTIONS.filter((o) => searching || o.key !== "relevance");
    const current = SORT_OPTIONS.find((o) => o.key === sort) ?? SORT_OPTIONS[1];

    return (
        <div ref={rootRef} className="relative flex-shrink-0">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                title={t(searching ? "topbar.sortResultsTitle" : "topbar.sortLibraryTitle")}
                className="flex h-[calc(30px*var(--ui-scale))] cursor-pointer items-center gap-[calc(6px*var(--ui-scale))] rounded-lg border border-edge bg-raised px-[calc(10px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg-dim hover:bg-hover hover:text-fg"
            >
                <Icon name="sort" size={18} className="text-fg-faint" />
                <span className="sr-only">{t("topbar.sort")}</span>
                <span className="whitespace-nowrap text-fg">{current === undefined ? "" : t(current.short)}</span>
                <Icon name={open ? "keyboard_arrow_up" : "keyboard_arrow_down"} size={16} className="text-fg-faint" />
            </button>
            {open ? (
                <div
                    role="listbox"
                    aria-label={t("topbar.sortOrder")}
                    className="absolute top-[calc(36px*var(--ui-scale))] left-0 z-40 min-w-[calc(210px*var(--ui-scale))] rounded-[calc(10px*var(--ui-scale))] border border-edge bg-raised p-1 shadow-[var(--shadow-pop)]"
                >
                    {options.map((o) => (
                        <button
                            key={o.key}
                            type="button"
                            role="option"
                            aria-selected={o.key === sort}
                            onClick={() => {
                                setOpen(false);
                                if(o.key !== sort){
                                    setSort(o.key);
                                }
                            }}
                            className={
                                "flex w-full cursor-pointer items-center justify-between gap-3 rounded px-2 py-[calc(6px*var(--ui-scale))] text-left text-[calc(12.5px*var(--ui-scale))] hover:bg-hover " +
                                (o.key === sort ? "text-fg" : "text-fg-dim")
                            }
                        >
                            <span className="whitespace-nowrap">{t(o.label)}</span>
                            {o.key === sort ? (
                                <svg width="12" height="12" viewBox="0 0 12 12" className="flex-shrink-0 text-accent" aria-hidden="true">
                                    <path d="M2 6.5 5 9.5 10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            ) : null}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

/** The serving model's download, 0–100, or null when it is on disk. A swap's
 *  download is a different model and leaves search working, so it is not this. */
function servingModelPercent(s: ReturnType<typeof useStore.getState>): number | null{
    const d = s.modelDownload;
    if(d === null || d.modelId !== s.settings.modelId){
        return null;
    }
    return d.total > 0 ? Math.min(100, Math.round((d.done / d.total) * 100)) : 0;
}

function ModelDownloadPill(){
    const t = useT();
    const pct = useStore(servingModelPercent);
    const download = useStore((s) => s.modelDownload);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismiss(open, close, rootRef);
    if(pct === null || download === null){
        return null;
    }
    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex cursor-pointer items-center gap-[calc(7px*var(--ui-scale))] rounded-[calc(7px*var(--ui-scale))] bg-raised px-[calc(10px*var(--ui-scale))] py-[calc(6px*var(--ui-scale))] hover:bg-hover"
            >
                <svg width="16" height="16" viewBox="0 0 16 16" className="flex-shrink-0">
                    <circle cx="8" cy="8" r="6" fill="none" stroke="var(--border)" strokeWidth="2" />
                    <circle
                        cx="8"
                        cy="8"
                        r="6"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="2"
                        strokeDasharray={RING_CIRCUMFERENCE}
                        strokeDashoffset={RING_CIRCUMFERENCE * (1 - pct / 100)}
                        strokeLinecap="round"
                        transform="rotate(-90 8 8)"
                    />
                </svg>
                <span className="whitespace-nowrap text-[calc(11.5px*var(--ui-scale))] tabular-nums text-fg-dim">
                    {t("topbar.modelPill", { percent: pct })}
                </span>
            </button>
            {open ? (
                <div className="absolute top-[calc(42px*var(--ui-scale))] right-0 z-40 w-[calc(260px*var(--ui-scale))] rounded-[calc(10px*var(--ui-scale))] border border-edge bg-raised p-[calc(14px*var(--ui-scale))] shadow-[var(--shadow-pop)]">
                    <div className="mb-2 text-[calc(12.5px*var(--ui-scale))] text-fg">{t("topbar.modelTitle")}</div>
                    <div className="mb-[calc(10px*var(--ui-scale))] h-[calc(5px*var(--ui-scale))] overflow-hidden rounded-[calc(3px*var(--ui-scale))] bg-hover">
                        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mb-[calc(10px*var(--ui-scale))] flex justify-between gap-2 text-[calc(11.5px*var(--ui-scale))] tabular-nums text-fg-dim">
                        <span>{download.total > 0 ? `${fmtBytes(download.done)} / ${fmtBytes(download.total)}` : fmtBytes(download.done)}</span>
                        {download.transfer !== null ? <span>{fmtTransfer(download.transfer)}</span> : null}
                    </div>
                    <div className="text-[calc(12px*var(--ui-scale))] text-fg-faint">{t("topbar.modelBody")}</div>
                </div>
            ) : null}
        </div>
    );
}

function IndexingIndicator(){
    const t = useT();
    const indexing = useStore((s) => s.indexing);
    const open = useStore((s) => s.indexingPanelOpen);
    const toggle = useStore((s) => s.toggleIndexingPanel);
    const togglePause = useStore((s) => s.toggleIndexingPause);
    const photoCount = useStore((s) => s.counts.library);
    const rootRef = useRef<HTMLDivElement>(null);
    const close = useCallback(() => {
        if(useStore.getState().indexingPanelOpen){
            toggle();
        }
    }, [toggle]);
    useDismiss(open, close, rootRef);

    // `running` is the truth: the counter reaches the total before the last
    // batch is embedded and OCR'd, and a scan's walk has no total yet.
    const complete = !indexing.running;
    const counting = indexing.running && indexing.current < indexing.total;
    const pct = counting ? Math.min(100, (indexing.current / indexing.total) * 100) : 25;

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                onClick={toggle}
                className="flex cursor-pointer items-center gap-[calc(7px*var(--ui-scale))] rounded-[calc(7px*var(--ui-scale))] bg-raised px-[calc(10px*var(--ui-scale))] py-[calc(6px*var(--ui-scale))] hover:bg-hover"
            >
                {complete ? (
                    <span className="h-[calc(7px*var(--ui-scale))] w-[calc(7px*var(--ui-scale))] rounded-full bg-fg-faint" />
                ) : (
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        className="flex-shrink-0"
                        // No count to show (walking, finishing the last batch): spin instead of sitting still.
                        style={counting || indexing.paused ? undefined : { animation: "spin 0.9s linear infinite" }}
                    >
                        <circle cx="8" cy="8" r="6" fill="none" stroke="var(--border)" strokeWidth="2" />
                        <circle
                            cx="8"
                            cy="8"
                            r="6"
                            fill="none"
                            stroke="var(--accent)"
                            strokeWidth="2"
                            strokeDasharray={RING_CIRCUMFERENCE}
                            strokeDashoffset={RING_CIRCUMFERENCE * (1 - pct / 100)}
                            strokeLinecap="round"
                            transform="rotate(-90 8 8)"
                        />
                    </svg>
                )}
                <span className="whitespace-nowrap text-[calc(11.5px*var(--ui-scale))] tabular-nums text-fg-dim">
                    {indexing.paused
                        ? t("indexing.paused")
                        : complete
                        ? t("indexing.upToDate")
                        : counting
                        ? t("indexing.progress", { current: fmtCount(indexing.current), total: fmtCount(indexing.total) })
                        : t("indexing.working")}
                </span>
            </button>

            {open ? (
                <div className="absolute top-[calc(42px*var(--ui-scale))] right-0 z-40 w-[calc(260px*var(--ui-scale))] rounded-[calc(10px*var(--ui-scale))] border border-edge bg-raised p-[calc(14px*var(--ui-scale))] shadow-[var(--shadow-pop)]">
                    {complete ? (
                        <div className="text-[calc(12.5px*var(--ui-scale))] text-fg-dim">
                            {t("indexing.idleSummary", { count: fmtCount(photoCount) })}
                        </div>
                    ) : (
                        <>
                            {indexing.currentFile !== "" ? (
                                <>
                                    <div className="mb-2 text-[calc(12px*var(--ui-scale))] text-fg-faint">{t("indexing.currentFile")}</div>
                                    <div className="mb-3 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[calc(11.5px*var(--ui-scale))] text-fg">
                                        {indexing.currentFile}
                                    </div>
                                </>
                            ) : null}
                            {counting ? (
                                <>
                                    <div className="mb-[calc(10px*var(--ui-scale))] h-[calc(5px*var(--ui-scale))] overflow-hidden rounded-[calc(3px*var(--ui-scale))] bg-hover">
                                        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
                                    </div>
                                    {indexing.rate > 0 ? (
                                        <div className="mb-[calc(14px*var(--ui-scale))] flex justify-between text-[calc(11.5px*var(--ui-scale))] text-fg-dim">
                                            <span>{t("indexing.rate", { rate: fmtDecimal(indexing.rate, 2, 0) })}</span>
                                            <span>{t("indexing.eta", { time: fmtEta(indexing.etaSec) })}</span>
                                        </div>
                                    ) : null}
                                </>
                            ) : (
                                <div className="mb-[calc(14px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg-dim">{t("indexing.workingBody")}</div>
                            )}
                        </>
                    )}
                    {/* Pause only while something runs: a pause pressed while idle held the next folder add at 0 / N until restart. */}
                    {!complete || indexing.paused ? (
                        <button
                            type="button"
                            onClick={() => void togglePause()}
                            className={
                                "w-full cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-hover p-2 text-[calc(12.5px*var(--ui-scale))] text-fg hover:opacity-80" +
                                (complete ? " mt-3" : "")
                            }
                        >
                            {t(indexing.paused ? "indexing.resume" : "indexing.pause")}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
