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
    const setView = useStore((s) => s.setView);
    const view = useStore((s) => s.view);

    // Search in the middle, a wide pill like Google Photos; sort on its left and
    // the progress pills on its right. The sides share what is left equally
    // (and never squeeze below their content), so the pill stays centred.
    return (
        <div className="flex h-[calc(60px*var(--ui-scale))] flex-shrink-0 items-start gap-[calc(14px*var(--ui-scale))] border-b border-edge bg-panel px-4 pt-[calc(8px*var(--ui-scale))]">
            <div className="flex h-[calc(44px*var(--ui-scale))] min-w-fit flex-[1_1_0%] items-center">
                <SortMenu />
            </div>

            <SearchBox />

            <div className="flex h-[calc(44px*var(--ui-scale))] min-w-fit flex-[1_1_0%] items-center justify-end gap-[calc(14px*var(--ui-scale))]">
                <UpdatePill />

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
        </div>
    );
});

/** Only while a newer release is known. Opens Settings on About, where the
 *  release page button is. Its own subscription, so the memo'd bar stays still. */
function UpdatePill(){
    const t = useT();
    const latest = useStore((s) => (s.update.kind === "available" ? s.update.latest : null));
    const open = useStore((s) => s.openSettingsSection);
    if(latest === null){
        return null;
    }
    return (
        <button
            type="button"
            onClick={() => open("about")}
            title={t("topbar.updateTitle", { version: latest })}
            className="flex-shrink-0 cursor-pointer whitespace-nowrap rounded-full border-none bg-accent-muted px-[calc(12px*var(--ui-scale))] py-[calc(5px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] font-semibold text-accent-text hover:opacity-80"
        >
            {t("topbar.updatePill", { version: latest })}
        </button>
    );
}

/**
 * The search pill. Clicking it drops a panel open under the text, on the same
 * surface, listing the recent searches; typing narrows them to the ones that
 * contain the text. A search is remembered when it is submitted (Enter, or a
 * row picked) or when the panel is dismissed with something typed — the live
 * results already run as you type, so "done" is the only moment worth keeping.
 */
function SearchBox(){
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
    const recents = useStore((s) => s.settings.recentSearches);
    const setQuery = useStore((s) => s.setQuery);
    const clearQuery = useStore((s) => s.clearQuery);
    const saveSearch = useStore((s) => s.saveCurrentSearch);
    const remember = useStore((s) => s.rememberSearch);
    const forget = useStore((s) => s.forgetSearch);
    const clearRecents = useStore((s) => s.clearRecentSearches);
    const inputRef = useRef<HTMLInputElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const disabled = modelPct !== null || modelMissing;

    const typed = query.trim().toLowerCase();
    const rows = typed === ""
        ? recents
        : recents.filter((r) => r.toLowerCase().includes(typed) && r.toLowerCase() !== typed);
    const showPanel = open && !disabled && rows.length > 0;

    const dismiss = useCallback(() => {
        setOpen(false);
        setActive(-1);
        remember(useStore.getState().query);
    }, [remember]);
    useDismiss(open, dismiss, rootRef);

    // `/` focuses search from anywhere; App owns the key handler and pokes here.
    // The first focus at start-up does not open the panel — only a click or `/` does.
    useEffect(() => {
        const focus = () => {
            inputRef.current?.focus();
            setOpen(true);
        };
        window.addEventListener("picsearch:focus-search", focus);
        const timer = setTimeout(() => inputRef.current?.focus(), 60);
        return () => {
            window.removeEventListener("picsearch:focus-search", focus);
            clearTimeout(timer);
        };
    }, []);

    const pick = (text: string) => {
        setQuery(text);
        remember(text);
        setOpen(false);
        setActive(-1);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if(e.key === "ArrowDown" || e.key === "ArrowUp"){
            e.preventDefault();
            if(!open){
                setOpen(true);
                return;
            }
            if(rows.length > 0){
                const step = e.key === "ArrowDown" ? 1 : -1;
                // -1 is the input itself, so the arrows loop through it.
                setActive((i) => {
                    const next = i + step;
                    return next >= rows.length ? -1 : next < -1 ? rows.length - 1 : next;
                });
            }
        }else if(e.key === "Enter"){
            const row = rows[active];
            if(showPanel && row !== undefined){
                pick(row);
            }else{
                remember(query);
                setOpen(false);
            }
        }
    };

    return (
        <div
            ref={rootRef}
            className="relative h-[calc(44px*var(--ui-scale))] min-w-0 flex-[0_1_calc(640px*var(--ui-scale))]"
        >
            <div
                className={
                    "absolute inset-x-0 top-0 z-40 overflow-hidden rounded-[calc(22px*var(--ui-scale))] transition-[background-color,box-shadow] " +
                    // A trace of the text colour mixed in: lighter on dark themes, darker on light ones.
                    (open
                        ? "bg-[color-mix(in_oklab,var(--surface-raised),var(--color-fg)_9%)] shadow-[var(--shadow-pop)]"
                        : "bg-raised hover:bg-[color-mix(in_oklab,var(--surface-raised),var(--color-fg)_4%)] focus-within:bg-[color-mix(in_oklab,var(--surface-raised),var(--color-fg)_9%)] focus-within:shadow-[var(--shadow-pop)]")
                }
            >
                <div className="flex h-[calc(44px*var(--ui-scale))] items-center gap-[calc(12px*var(--ui-scale))] pr-[calc(10px*var(--ui-scale))] pl-[calc(16px*var(--ui-scale))]">
                    <Icon name="search" size={22} className="text-fg-dim" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setOpen(true);
                            setActive(-1);
                        }}
                        onClick={() => setOpen(true)}
                        onKeyDown={onKeyDown}
                        role="combobox"
                        aria-expanded={showPanel}
                        aria-controls="search-recents"
                        // First run: the serving model is still downloading, and a query has nothing to embed with.
                        disabled={disabled}
                        placeholder={
                            modelPct !== null
                                ? t("topbar.searchPlaceholderModel", { percent: modelPct })
                                : modelMissing
                                ? t("topbar.searchPlaceholderNoModel")
                                : t(reindexActive ? "topbar.searchPlaceholderReindex" : "topbar.searchPlaceholder")
                        }
                        className="search-input min-w-0 flex-1 border-none bg-transparent text-[calc(14.5px*var(--ui-scale))] text-fg outline-none placeholder:text-fg-faint disabled:cursor-not-allowed"
                    />
                    {searching ? (
                        <span
                            className="h-[calc(11px*var(--ui-scale))] w-[calc(11px*var(--ui-scale))] flex-shrink-0 rounded-full border-[calc(1.5px*var(--ui-scale))] border-edge border-t-accent"
                            style={{ animation: "spin 0.7s linear infinite" }}
                        />
                    ) : null}
                    {/* Saving stores the filters too, so it only appears once there is
                        a query to attach them to. */}
                    {query.trim() !== "" ? (
                        <button
                            type="button"
                            onClick={() => void saveSearch()}
                            title={t("topbar.saveTitle")}
                            aria-label={t("topbar.saveAria")}
                            className="flex cursor-pointer rounded-full p-[calc(6px*var(--ui-scale))] text-fg-dim hover:bg-fg/[0.1] hover:text-fg"
                        >
                            <Icon name="bookmark_add" />
                        </button>
                    ) : null}
                    {query !== "" ? (
                        <button
                            type="button"
                            onClick={() => {
                                clearQuery();
                                inputRef.current?.focus();
                            }}
                            className="flex cursor-pointer rounded-full p-[calc(6px*var(--ui-scale))] text-fg-dim hover:bg-fg/[0.1] hover:text-fg"
                            aria-label={t("topbar.clearSearch")}
                            title={t("topbar.clearSearch")}
                        >
                            <Icon name="close" />
                        </button>
                    ) : null}
                </div>

                {showPanel ? (
                    <div
                        id="search-recents"
                        role="listbox"
                        className="border-t border-edge pb-[calc(8px*var(--ui-scale))]"
                        style={{ animation: "drop-in 140ms ease-out" }}
                    >
                        {typed === "" ? (
                            <div className="flex items-center justify-between px-[calc(18px*var(--ui-scale))] pt-[calc(10px*var(--ui-scale))] pb-[calc(4px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] text-fg-faint">
                                <span>{t("topbar.recent")}</span>
                                <button
                                    type="button"
                                    onClick={clearRecents}
                                    className="cursor-pointer rounded px-1 text-fg-faint hover:text-fg"
                                >
                                    {t("topbar.recentClear")}
                                </button>
                            </div>
                        ) : null}
                        {rows.map((r, i) => (
                            <div
                                key={r}
                                role="option"
                                aria-selected={i === active}
                                onMouseEnter={() => setActive(i)}
                                className={
                                    "group flex cursor-pointer items-center gap-[calc(14px*var(--ui-scale))] px-[calc(16px*var(--ui-scale))] py-[calc(9px*var(--ui-scale))] " +
                                    (i === active ? "bg-fg/[0.08]" : "")
                                }
                                onClick={() => pick(r)}
                            >
                                <Icon name="history" size={20} className="text-fg-faint" />
                                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[calc(13.5px*var(--ui-scale))] text-fg">{r}</span>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        forget(r);
                                    }}
                                    aria-label={t("topbar.recentRemove", { text: r })}
                                    title={t("topbar.recentRemove", { text: r })}
                                    className="flex cursor-pointer rounded-full p-[calc(4px*var(--ui-scale))] text-fg-faint opacity-0 hover:bg-fg/[0.1] hover:text-fg group-hover:opacity-100 focus:opacity-100"
                                >
                                    <Icon name="close" size={16} />
                                </button>
                            </div>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

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
