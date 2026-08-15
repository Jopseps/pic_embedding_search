/**
 * Justified-rows layout ("Google Photos style").
 *
 * Every image keeps its true aspect ratio; each row is stretched to fill the
 * container exactly by solving for a common row height. This is why `width` and
 * `height` must exist on every Photo before layout runs — see CLAUDE.md.
 *
 * The output is a flat list of absolutely-positioned blocks with cumulative Y
 * offsets, which is what lets PhotoGrid render only the visible window instead
 * of every cell.
 */

export interface Sized{
    width: number;
    height: number;
}

export interface JustifiedCell<T>{
    item: T;
    width: number;
    height: number;
}

export interface JustifiedRow<T>{
    height: number;
    cells: JustifiedCell<T>[];
}

export type LayoutBlock<T> =
    | { kind: "header"; key: string; label: string; top: number; height: number }
    | {
          kind: "row";
          key: string;
          /** Global row index, matching `rowMap[i].row`. Section-local indices
           *  diverge from this at the first section boundary, so anything
           *  resolving a row from `rowMap` must key off this field. */
          rowIndex: number;
          row: JustifiedRow<T>;
          top: number;
          height: number;
      };

export interface Layout<T>{
    blocks: LayoutBlock<T>[];
    totalHeight: number;
    /** Row-major order of every item, for lightbox paging and keyboard nav. */
    flat: T[];
    /** Parallel to `flat`: which row/column each item sits in. */
    rowMap: { row: number; col: number }[];
}

export interface Section<T>{
    label: string | null;
    items: T[];
}

export const HEADER_HEIGHT = 36;
export const SECTION_GAP = 4;

const MIN_HEIGHT_RATIO = 0.5;
const MAX_HEIGHT_RATIO = 1.6;

function aspectOf(item: Sized): number{
    if(item.height <= 0){
        return 1;
    }
    return item.width / item.height;
}

/** Row height that makes `aspectSum` images plus gaps exactly fill `width`. */
function heightFor(aspectSum: number, count: number, gap: number, width: number): number{
    const usable = width - gap * (count - 1);
    if(aspectSum <= 0 || usable <= 0){
        return 0;
    }
    return usable / aspectSum;
}

/**
 * Break `items` into rows. At each candidate break we compare the row height we
 * would get by including the current item against the height from stopping
 * before it, and take whichever lands closer to `targetHeight`. Breaking
 * unconditionally on overflow (as the design draft did) produces rows that are
 * consistently shorter than the target.
 */
export function justifyRows<T extends Sized>(
    items: readonly T[],
    targetHeight: number,
    gap: number,
    containerWidth: number,
): JustifiedRow<T>[]{
    const rows: JustifiedRow<T>[] = [];
    if(containerWidth <= 0 || items.length === 0){
        return rows;
    }

    let current: T[] = [];
    let aspectSum = 0;

    const push = (rowItems: T[], height: number) => {
        const clamped = Math.max(
            targetHeight * MIN_HEIGHT_RATIO,
            Math.min(targetHeight * MAX_HEIGHT_RATIO, height),
        );
        let used = 0;
        const cells: JustifiedCell<T>[] = rowItems.map((item, i) => {
            // Round progressively so the row sums to exactly containerWidth
            // instead of drifting a pixel or two off the right edge.
            const isLast = i === rowItems.length - 1;
            const ideal = aspectOf(item) * clamped;
            const width = isLast && rowItems.length > 1
                ? containerWidth - used - gap * (rowItems.length - 1)
                : Math.round(ideal);
            used += width;
            return { item, width: Math.max(1, width), height: Math.round(clamped) };
        });
        rows.push({ height: Math.round(clamped), cells });
    };

    for(const item of items){
        const nextSum = aspectSum + aspectOf(item);
        const widthAtTarget = nextSum * targetHeight + gap * current.length;

        if(widthAtTarget < containerWidth){
            current.push(item);
            aspectSum = nextSum;
            continue;
        }

        const withItem = heightFor(nextSum, current.length + 1, gap, containerWidth);
        const withoutItem = current.length > 0
            ? heightFor(aspectSum, current.length, gap, containerWidth)
            : Infinity;

        if(Math.abs(withItem - targetHeight) <= Math.abs(withoutItem - targetHeight)){
            current.push(item);
            push(current, withItem);
            current = [];
            aspectSum = 0;
        }else{
            push(current, withoutItem);
            current = [item];
            aspectSum = aspectOf(item);
        }
    }

    // Trailing partial row keeps the target height rather than stretching to
    // fill — stretching three photos across a wide window looks broken.
    if(current.length > 0){
        push(current, targetHeight);
    }

    return rows;
}

/** Lay sections out into positioned blocks ready for windowed rendering. */
export function buildLayout<T extends Sized>(
    sections: readonly Section<T>[],
    targetHeight: number,
    gap: number,
    containerWidth: number,
): Layout<T>{
    const blocks: LayoutBlock<T>[] = [];
    const flat: T[] = [];
    const rowMap: { row: number; col: number }[] = [];
    let top = 0;
    let rowIndex = -1;

    sections.forEach((section, si) => {
        if(section.label !== null){
            blocks.push({
                kind: "header",
                key: `h${si}`,
                label: section.label,
                top,
                height: HEADER_HEIGHT,
            });
            top += HEADER_HEIGHT;
        }

        const rows = justifyRows(section.items, targetHeight, gap, containerWidth);
        rows.forEach((row, ri) => {
            rowIndex++;
            const thisRow = rowIndex;
            row.cells.forEach((cell, col) => {
                flat.push(cell.item);
                rowMap.push({ row: thisRow, col });
            });
            blocks.push({
                kind: "row",
                key: `r${si}-${ri}`,
                rowIndex: thisRow,
                row,
                top,
                height: row.height,
            });
            top += row.height + gap;
        });

        top += SECTION_GAP;
    });

    return { blocks, totalHeight: Math.max(0, top - gap - SECTION_GAP), flat, rowMap };
}

/** Indices of blocks intersecting the viewport, with overscan. */
export function visibleRange<T>(
    blocks: readonly LayoutBlock<T>[],
    scrollTop: number,
    viewportHeight: number,
    overscan = 600,
): { start: number; end: number }{
    const top = scrollTop - overscan;
    const bottom = scrollTop + viewportHeight + overscan;

    let start = 0;
    while(start < blocks.length){
        const b = blocks[start];
        if(b !== undefined && b.top + b.height >= top){
            break;
        }
        start++;
    }

    let end = start;
    while(end < blocks.length){
        const b = blocks[end];
        if(b === undefined || b.top > bottom){
            break;
        }
        end++;
    }

    return { start, end };
}
