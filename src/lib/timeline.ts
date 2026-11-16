import type { Timeline } from "./types";

/**
 * The scrubber's geometry, in *index* space.
 *
 * Positions are fractions of the whole result's photo count, never of the
 * canvas height: the canvas only spans the pages loaded so far, so a rail
 * mapped to `scrollHeight` would slide under the pointer every time a page
 * arrived. The timeline counts every page, loaded or not.
 */
export interface Mark{
    /** `YYYY-MM`, or null for the undated tail. */
    month: string | null;
    /** Index of the first photo in this month, in grid order. */
    start: number;
    count: number;
}

export interface Marks{
    marks: Mark[];
    total: number;
}

export function buildMarks(t: Timeline): Marks{
    const marks: Mark[] = [];
    let start = 0;
    for(const b of t.buckets){
        marks.push({ month: b.month, start, count: b.count });
        start += b.count;
    }
    // Undated rows sort last in both directions, so their stretch is always
    // the bottom of the rail.
    if(t.undated > 0){
        marks.push({ month: null, start, count: t.undated });
        start += t.undated;
    }
    return { marks, total: start };
}

/** The mark under a rail position, 0 at the top and 1 at the bottom. */
export function markAt(m: Marks, fraction: number): Mark | null{
    if(m.marks.length === 0 || m.total === 0){
        return null;
    }
    const index = Math.min(m.total - 1, Math.max(0, Math.floor(fraction * m.total)));
    return markForIndex(m, index);
}

/** The mark a photo index falls in — binary search, the rail asks per frame. */
export function markForIndex(m: Marks, index: number): Mark | null{
    let lo = 0;
    let hi = m.marks.length - 1;
    let found: Mark | null = null;
    while(lo <= hi){
        const mid = (lo + hi) >> 1;
        const mark = m.marks[mid] as Mark;
        if(mark.start <= index){
            found = mark;
            lo = mid + 1;
        }else{
            hi = mid - 1;
        }
    }
    return found;
}

/** Where each year's first month sits on the rail, for the year labels. */
export function yearTicks(m: Marks): { year: string; fraction: number }[]{
    const out: { year: string; fraction: number }[] = [];
    let last = "";
    for(const mark of m.marks){
        if(mark.month === null || m.total === 0){
            continue;
        }
        const year = mark.month.slice(0, 4);
        if(year !== last){
            out.push({ year, fraction: mark.start / m.total });
            last = year;
        }
    }
    return out;
}
