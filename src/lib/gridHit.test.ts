import { describe, expect, it } from "vitest";
import { buildLayout, type Section } from "./grid";
import { itemAt, itemsAlongSegment, rangeIds } from "./gridHit";

interface Item{
    id: number;
    width: number;
    height: number;
}

const GAP = 4;

function items(n: number): Item[]{
    return Array.from({ length: n }, (_, i) => ({ id: i, width: 100, height: 100 }));
}

function layoutOf(n: number, containerWidth = 500){
    const sections: Section<Item>[] = [{ label: null, items: items(n) }];
    return buildLayout(sections, 100, GAP, containerWidth);
}

/** Content-space rect of one item. The solver stretches cells to fill the
 *  container, so nothing here may assume the width it was given. */
function rectOf(blocks: ReturnType<typeof layoutOf>["blocks"], id: number){
    for(const b of blocks){
        if(b.kind !== "row"){
            continue;
        }
        let x = 0;
        for(const cell of b.row.cells){
            if(cell.item.id === id){
                return {
                    left: x,
                    top: b.top,
                    right: x + cell.width,
                    bottom: b.top + cell.height,
                };
            }
            x += cell.width + GAP;
        }
    }
    throw new Error(`no cell for id ${id}`);
}

function centreOf(blocks: ReturnType<typeof layoutOf>["blocks"], id: number){
    const r = rectOf(blocks, id);
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

function idsInRow(layout: ReturnType<typeof layoutOf>, row: number): number[]{
    return layout.flat
        .filter((_, i) => layout.rowMap[i]?.row === row)
        .map((item) => item.id);
}

describe("itemAt", () => {
    it("finds the cell under a point", () => {
        const { blocks } = layoutOf(12);
        const p = centreOf(blocks, 7);
        expect(itemAt(blocks, p.x, p.y, GAP)?.id).toBe(7);
    });

    it("returns null in a gutter and below the last row", () => {
        const layout = layoutOf(12);
        const first = rectOf(layout.blocks, idsInRow(layout, 0)[0]!);
        expect(itemAt(layout.blocks, first.right + 2, first.top + 5, GAP)).toBeNull();
        expect(itemAt(layout.blocks, 50, layout.totalHeight + 50, GAP)).toBeNull();
    });
});

describe("itemsAlongSegment", () => {
    it("returns the single photo under a stationary pointer", () => {
        const { blocks } = layoutOf(12);
        const p = centreOf(blocks, 3);
        expect(itemsAlongSegment(blocks, p, p, GAP).map((i) => i.id)).toEqual([3]);
    });

    it("crosses every photo between two points, in sweep order", () => {
        const layout = layoutOf(12);
        const row = idsInRow(layout, 0);
        const from = centreOf(layout.blocks, row[0]!);
        const to = centreOf(layout.blocks, row[row.length - 1]!);
        expect(itemsAlongSegment(layout.blocks, from, to, GAP).map((i) => i.id)).toEqual(row);
    });

    it("reverses cleanly when the sweep goes right to left", () => {
        const layout = layoutOf(12);
        const row = idsInRow(layout, 0);
        const from = centreOf(layout.blocks, row[row.length - 1]!);
        const to = centreOf(layout.blocks, row[0]!);
        expect(itemsAlongSegment(layout.blocks, from, to, GAP).map((i) => i.id))
            .toEqual([...row].reverse());
    });

    it("does not skip photos on a fast flick across several rows", () => {
        // One pointermove of ~900px — far more than a cell is wide. Sampling
        // only the endpoints would report two photos and silently drop the
        // dozen in between.
        const layout = layoutOf(60);
        const from = centreOf(layout.blocks, 0);
        const to = centreOf(layout.blocks, 23);
        const swept = itemsAlongSegment(layout.blocks, from, to, GAP).map((i) => i.id);
        expect(swept[0]).toBe(0);
        expect(swept).toContain(23);
        expect(swept.length).toBeGreaterThan(5);
    });

    it("reports nothing when the whole segment lies below the grid", () => {
        const layout = layoutOf(12);
        const y = layout.totalHeight + 40;
        expect(itemsAlongSegment(layout.blocks, { x: 0, y }, { x: 400, y }, GAP)).toEqual([]);
    });
});

describe("rangeIds", () => {
    const flat = [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }];

    it("spans anchor to target inclusive, in layout order", () => {
        expect(rangeIds(flat, 11, 13)).toEqual([11, 12, 13]);
    });

    it("works backwards", () => {
        expect(rangeIds(flat, 13, 11)).toEqual([11, 12, 13]);
    });

    it("with no anchor selects only the target — never the whole library", () => {
        expect(rangeIds(flat, null, 12)).toEqual([12]);
        expect(rangeIds(flat, 999, 12)).toEqual([12]);
    });

    it("is empty when the target is gone from the layout", () => {
        expect(rangeIds(flat, 11, 999)).toEqual([]);
    });
});
