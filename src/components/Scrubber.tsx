import { memo, useMemo, useState } from "react";
import { monthKeyLabel } from "../lib/format";
import { markAt, markForIndex, yearTicks, type Mark, type Marks } from "../lib/timeline";

/** Rail width, px at 100% UI scale. It sits in the grid's right gutter. */
const RAIL_W = 20;
/** Inset of the rail's ends from the pane's edges, px at 100% UI scale. */
const RAIL_PAD = 10;
/** Months closer together than this on the rail get no tick — a solid bar of
 *  ticks says nothing about where a month is. */
const MIN_TICK_GAP = 4;

function markLabel(mark: Mark | null): string{
    if(mark === null){
        return "";
    }
    return mark.month === null ? "Undated" : monthKeyLabel(mark.month);
}

/** `top` for a rail fraction: the rail runs between the two pads. */
function railTop(fraction: number): string{
    return `calc(${RAIL_PAD}px*var(--ui-scale) + (100% - ${RAIL_PAD * 2}px*var(--ui-scale)) * ${fraction})`;
}

/**
 * Google Photos style jump rail on the grid's right edge.
 *
 * Everything is in index space (`lib/timeline.ts`): a position is a fraction
 * of the photo count, so the rail does not slide as pages load in. Hovering
 * shows the month under the pointer; a click or drag jumps to it, and
 * `onJump` loads whatever pages that takes.
 *
 * Outside `useGridGesture`, so the `selectstart` backstop there does not cover
 * a drag here: `user-select` is set inline, with the `-webkit-` form, or
 * WebKitGTK paints a text selection over the grid while the rail is dragged.
 * Hidden from assistive tech — it duplicates the scroll position, and the
 * grid is fully navigable from the keyboard without it.
 */
export const Scrubber = memo(function Scrubber(props: {
    marks: Marks;
    /** Index of the first photo in view. */
    currentIndex: number;
    /** Distance from the pane's right edge — the native scrollbar's width. */
    rightInset: number;
    onJump: (index: number) => void;
    /** The grid's scroll container. The rail is its sibling, so a wheel over
     *  the rail — right where a hand parks near the scrollbar — reaches
     *  nothing scrollable unless it is handed across. */
    scrollRef: React.RefObject<HTMLDivElement | null>;
}){
    const { marks, currentIndex, rightInset, onJump, scrollRef } = props;
    const [hover, setHover] = useState<number | null>(null);
    const [dragging, setDragging] = useState(false);
    const [lastJump, setLastJump] = useState<number | null>(null);

    const fractionAt = (e: React.PointerEvent<HTMLDivElement>): number => {
        const r = e.currentTarget.getBoundingClientRect();
        const pad = RAIL_PAD * (r.width / RAIL_W);
        return Math.min(1, Math.max(0, (e.clientY - r.top - pad) / Math.max(1, r.height - pad * 2)));
    };

    const jumpTo = (fraction: number) => {
        const mark = markAt(marks, fraction);
        // One jump per month crossed, not one per pointermove: a jump past the
        // loaded pages is a fetch.
        if(mark !== null && mark.start !== lastJump){
            setLastJump(mark.start);
            onJump(mark.start);
        }
    };

    const current = markForIndex(marks, currentIndex);
    const thumb = marks.total > 0 ? Math.min(1, currentIndex / marks.total) : 0;
    const shown = hover !== null ? markAt(marks, hover) : (dragging ? current : null);
    const active = hover !== null || dragging;

    // Per timeline, not per render: this component re-renders on every
    // scroll frame. Thinned by share of the rail, since the pane's height is
    // not known here — ~700px of rail makes MIN_TICK_GAP px about 0.6%.
    const ticks = useMemo(() => {
        const out: number[] = [];
        let last = -1;
        for(const m of marks.marks){
            const f = m.start / Math.max(1, marks.total);
            if(last < 0 || f - last >= MIN_TICK_GAP / 700){
                out.push(f);
                last = f;
            }
        }
        return out;
    }, [marks]);
    const years = useMemo(() => yearTicks(marks), [marks]);

    return (
        <div
            aria-hidden="true"
            className="absolute top-0 bottom-0 z-[3] cursor-pointer"
            style={{
                right: rightInset,
                width: `calc(${RAIL_W}px*var(--ui-scale))`,
                WebkitUserSelect: "none",
                userSelect: "none",
                touchAction: "none",
            }}
            onWheel={(e) => {
                const el = scrollRef.current;
                // Ctrl/Cmd+wheel is the grid zoom, which App's window-level
                // capture listener has already handled.
                if(el === null || e.ctrlKey || e.metaKey){
                    return;
                }
                // Same normalisation as App's zoom: WebKitGTK reports lines
                // (`deltaMode` 1), Chrome reports pixels.
                const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? el.clientHeight : 1);
                el.scrollTop += e.deltaY * unit;
            }}
            onPointerMove={(e) => {
                const f = fractionAt(e);
                setHover(f);
                if(dragging){
                    jumpTo(f);
                }
            }}
            onPointerLeave={() => {
                if(!dragging){
                    setHover(null);
                }
            }}
            onPointerDown={(e) => {
                if(e.button !== 0){
                    return;
                }
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(true);
                setLastJump(null);
                const f = fractionAt(e);
                setHover(f);
                const mark = markAt(marks, f);
                if(mark !== null){
                    setLastJump(mark.start);
                    onJump(mark.start);
                }
            }}
            onPointerUp={(e) => {
                if(e.currentTarget.hasPointerCapture(e.pointerId)){
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }
                setDragging(false);
                setHover(null);
            }}
            onPointerCancel={() => {
                setDragging(false);
                setHover(null);
            }}
        >
            <div
                className="absolute w-px bg-edge transition-opacity"
                style={{
                    top: `calc(${RAIL_PAD}px*var(--ui-scale))`,
                    bottom: `calc(${RAIL_PAD}px*var(--ui-scale))`,
                    right: `calc(9px*var(--ui-scale))`,
                    opacity: active ? 1 : 0.6,
                }}
            />
            {ticks.map((f) => (
                <div
                    key={f}
                    className="absolute h-px bg-fg-faint"
                    style={{
                        top: railTop(f),
                        right: `calc(7px*var(--ui-scale))`,
                        width: `calc(5px*var(--ui-scale))`,
                        opacity: active ? 0.9 : 0.45,
                    }}
                />
            ))}
            {active ? years.map((t) => (
                <div
                    key={t.year}
                    className="pointer-events-none absolute -translate-y-1/2 whitespace-nowrap rounded bg-panel px-[calc(4px*var(--ui-scale))] text-[calc(10.5px*var(--ui-scale))] tabular-nums text-fg-faint"
                    style={{ top: railTop(t.fraction), right: `calc(${RAIL_W + 2}px*var(--ui-scale))` }}
                >
                    {t.year}
                </div>
            )) : null}
            <div
                className="absolute h-[calc(3px*var(--ui-scale))] -translate-y-1/2 rounded-full bg-accent"
                style={{
                    top: railTop(thumb),
                    right: `calc(4px*var(--ui-scale))`,
                    width: `calc(11px*var(--ui-scale))`,
                }}
            />
            {shown !== null ? (
                <div
                    className="pointer-events-none absolute -translate-y-1/2 whitespace-nowrap rounded-lg border border-edge bg-raised px-[calc(9px*var(--ui-scale))] py-[calc(4px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] font-semibold text-fg shadow-[var(--shadow-pop)]"
                    style={{
                        top: railTop(hover ?? thumb),
                        right: `calc(${RAIL_W + 34}px*var(--ui-scale))`,
                    }}
                >
                    {markLabel(shown)}
                </div>
            ) : null}
        </div>
    );
});
