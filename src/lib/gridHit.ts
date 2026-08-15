/**
 * Hit testing for grid gestures.
 *
 * Everything here works in *content* coordinates — the space of the virtual
 * canvas, whose origin is the top of the first block and which does not move
 * when the list scrolls. Viewport coordinates cannot be used: a sweep
 * auto-scrolls, and a point captured against the viewport addresses a different
 * photo one frame later.
 *
 * Cells carry no `left`, so the x offset is accumulated across the row exactly
 * the way the flex row renders it (`width` + `gap`). Keeping that walk here,
 * next to the layout it mirrors, is what stops the hit test and the DOM from
 * drifting apart.
 */
import type { LayoutBlock, Sized } from "./grid";

export interface Point{
    x: number;
    y: number;
}

/** The item under a single content-space point, or null for a gap / header. */
export function itemAt<T extends Sized>(
    blocks: readonly LayoutBlock<T>[],
    x: number,
    y: number,
    gap: number,
): T | null{
    for(const block of blocks){
        if(block.kind !== "row" || y < block.top || y >= block.top + block.height){
            continue;
        }
        let cx = 0;
        for(const cell of block.row.cells){
            const right = cx + cell.width;
            if(x >= cx && x < right && y < block.top + cell.height){
                return cell.item;
            }
            cx = right + gap;
        }
        return null;
    }
    return null;
}

/**
 * Every item the pointer swept over between two moves, in the order it crossed
 * them.
 *
 * Sampling only the two endpoints is the obvious version and it under-selects:
 * pointermove fires every few pixels of travel when the hand is slow, but a
 * fast flick jumps hundreds — far more than a cell is wide — and every photo in
 * between is silently skipped. The path is walked at `step` instead, which is
 * smaller than any cell the layout can produce.
 */
export function itemsAlongSegment<T extends Sized>(
    blocks: readonly LayoutBlock<T>[],
    from: Point,
    to: Point,
    gap: number,
    step = 16,
): T[]{
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
    const seen = new Set<T>();
    const hits: T[] = [];
    for(let i = 0; i <= steps; i++){
        const t = i / steps;
        const item = itemAt(blocks, from.x + dx * t, from.y + dy * t, gap);
        if(item !== null && !seen.has(item)){
            seen.add(item);
            hits.push(item);
        }
    }
    return hits;
}

/**
 * The ids from `anchorId` to `targetId` inclusive, in row-major order.
 *
 * `flat` is the layout's own ordering, so the range follows what the eye sees
 * rather than the order the backend returned. An anchor that is no longer in
 * the layout — its photo was deleted, or the query changed under it — yields
 * just the target: a shift-click must never silently select the whole library.
 */
export function rangeIds(
    flat: readonly { id: number }[],
    anchorId: number | null,
    targetId: number,
): number[]{
    const target = flat.findIndex((p) => p.id === targetId);
    if(target < 0){
        return [];
    }
    const anchor = anchorId === null ? -1 : flat.findIndex((p) => p.id === anchorId);
    if(anchor < 0){
        return [targetId];
    }
    const lo = Math.min(anchor, target);
    const hi = Math.max(anchor, target);
    return flat.slice(lo, hi + 1).map((p) => p.id);
}
