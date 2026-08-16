import { memo, useEffect, useRef } from "react";
import { useStore } from "../lib/store";
import { fmtCount, fmtEta } from "../lib/format";

const RING_CIRCUMFERENCE = 37.7;

/** Memoised: `App` re-renders on every scroll frame — the grid's scroll
 *  position is state up there — and the top bar depends on none of it. */
export const TopBar = memo(function TopBar(){
    const query = useStore((s) => s.query);
    const searching = useStore((s) => s.searching);
    // A re-index no longer disables search: the outgoing model keeps answering
    // until the incoming one has full coverage.
    const reindexActive = useStore((s) => s.reindex.active);
    const setQuery = useStore((s) => s.setQuery);
    const clearQuery = useStore((s) => s.clearQuery);
    const saveSearch = useStore((s) => s.saveCurrentSearch);
    const setView = useStore((s) => s.setView);
    const inputRef = useRef<HTMLInputElement>(null);

    // `/` focuses search from anywhere; App owns the key handler and pokes here.
    useEffect(() => {
        const focus = () => inputRef.current?.focus();
        window.addEventListener("picsearch:focus-search", focus);
        const t = setTimeout(focus, 60);
        return () => {
            window.removeEventListener("picsearch:focus-search", focus);
            clearTimeout(t);
        };
    }, []);

    return (
        <div className="flex h-[calc(56px*var(--ui-scale))] flex-shrink-0 items-center gap-[calc(14px*var(--ui-scale))] border-b border-edge bg-panel px-4">
            <div className="flex h-[calc(34px*var(--ui-scale))] w-[calc(280px*var(--ui-scale))] max-w-[44vw] flex-shrink-0 items-center gap-2 rounded-lg border border-edge bg-raised px-[calc(10px*var(--ui-scale))]">
                <span className="text-[calc(14px*var(--ui-scale))] text-fg-faint">⌕</span>
                <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={
                        reindexActive
                            ? "Search your photos — re-indexing in the background…"
                            : "Search your photos and screenshots…"
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
                        className="cursor-pointer p-[calc(2px*var(--ui-scale))] text-[calc(13px*var(--ui-scale))] text-fg-faint hover:text-fg"
                        aria-label="Clear search"
                    >
                        ✕
                    </button>
                ) : null}
            </div>

            {/* Saving stores the filters too, so it only appears once there is
                a query to attach them to. */}
            {query.trim() !== "" ? (
                <button
                    type="button"
                    onClick={() => void saveSearch()}
                    title="Save this search, with its filters"
                    aria-label="Save search"
                    className="h-[calc(30px*var(--ui-scale))] flex-shrink-0 cursor-pointer rounded-lg border border-edge bg-raised px-[calc(10px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg-dim hover:bg-hover hover:text-fg"
                >
                    ☆ Save
                </button>
            ) : null}

            <div className="flex-1" />

            <IndexingIndicator />

            <button
                type="button"
                onClick={() => setView("settings")}
                aria-label="Settings"
                className="h-8 w-8 flex-shrink-0 cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-raised text-[calc(15px*var(--ui-scale))] text-fg-dim hover:bg-hover"
            >
                ⚙
            </button>
        </div>
    );
});

function IndexingIndicator(){
    const indexing = useStore((s) => s.indexing);
    const open = useStore((s) => s.indexingPanelOpen);
    const toggle = useStore((s) => s.toggleIndexingPanel);
    const togglePause = useStore((s) => s.toggleIndexingPause);

    const complete = indexing.current >= indexing.total;
    const pct = indexing.total === 0 ? 100 : Math.min(100, (indexing.current / indexing.total) * 100);

    return (
        <div className="relative">
            <button
                type="button"
                onClick={toggle}
                className="flex cursor-pointer items-center gap-[calc(7px*var(--ui-scale))] rounded-[calc(7px*var(--ui-scale))] bg-raised px-[calc(10px*var(--ui-scale))] py-[calc(6px*var(--ui-scale))] hover:bg-hover"
            >
                {complete ? (
                    <span className="h-[calc(7px*var(--ui-scale))] w-[calc(7px*var(--ui-scale))] rounded-full bg-fg-faint" />
                ) : (
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
                )}
                <span className="whitespace-nowrap text-[calc(11.5px*var(--ui-scale))] tabular-nums text-fg-dim">
                    {complete
                        ? "Up to date"
                        : `Indexing ${fmtCount(indexing.current)} / ${fmtCount(indexing.total)}`}
                </span>
            </button>

            {open ? (
                <div className="absolute top-[calc(42px*var(--ui-scale))] right-0 z-40 w-[calc(260px*var(--ui-scale))] rounded-[calc(10px*var(--ui-scale))] border border-edge bg-raised p-[calc(14px*var(--ui-scale))] shadow-[var(--shadow-pop)]">
                    <div className="mb-2 text-[calc(12px*var(--ui-scale))] text-fg-faint">CURRENT FILE</div>
                    <div className="mb-3 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[calc(11.5px*var(--ui-scale))] text-fg">
                        {indexing.currentFile}
                    </div>
                    <div className="mb-[calc(10px*var(--ui-scale))] h-[calc(5px*var(--ui-scale))] overflow-hidden rounded-[calc(3px*var(--ui-scale))] bg-hover">
                        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mb-[calc(14px*var(--ui-scale))] flex justify-between text-[calc(11.5px*var(--ui-scale))] text-fg-dim">
                        <span>{indexing.rate} img/s</span>
                        <span>ETA {fmtEta(indexing.etaSec)}</span>
                    </div>
                    <button
                        type="button"
                        onClick={togglePause}
                        className="w-full cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-hover p-2 text-[calc(12.5px*var(--ui-scale))] text-fg hover:opacity-80"
                    >
                        {indexing.paused ? "Resume indexing" : "Pause indexing"}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
