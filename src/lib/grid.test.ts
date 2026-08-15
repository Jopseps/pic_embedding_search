import { describe, expect, it } from "vitest";
import { buildLayout, justifyRows, visibleRange, type Sized } from "./grid";

function sized(aspect: number): Sized{
    return { width: Math.round(1000 * aspect), height: 1000 };
}

const WIDE = sized(1.7778);
const SQUARE = sized(1);
const TALL = sized(0.6667);

describe("justifyRows", () => {
    it("fills every full row to exactly the container width", () => {
        const items = Array.from({ length: 40 }, (_, i) => [WIDE, SQUARE, TALL][i % 3] as Sized);
        const rows = justifyRows(items, 190, 4, 1200);

        // The trailing row is intentionally left unstretched.
        for(const row of rows.slice(0, -1)){
            const total =
                row.cells.reduce((sum, c) => sum + c.width, 0) + 4 * (row.cells.length - 1);
            expect(total).toBe(1200);
        }
    });

    it("preserves aspect ratio within a row", () => {
        const rows = justifyRows([WIDE, WIDE, SQUARE, TALL, WIDE, SQUARE], 190, 4, 1200);
        const row = rows[0];
        expect(row).toBeDefined();
        for(const cell of row!.cells){
            const wanted = cell.item.width / cell.item.height;
            const got = cell.width / cell.height;
            // Rounding to whole pixels, plus the last-cell width correction.
            expect(Math.abs(got - wanted)).toBeLessThan(0.06);
        }
    });

    it("keeps row heights near the target", () => {
        const items = Array.from({ length: 60 }, (_, i) => [WIDE, SQUARE, TALL][i % 3] as Sized);
        const rows = justifyRows(items, 190, 4, 1400);
        for(const row of rows.slice(0, -1)){
            expect(row.height).toBeGreaterThan(190 * 0.5);
            expect(row.height).toBeLessThan(190 * 1.6);
        }
    });

    it("does not drop or duplicate items", () => {
        const items = Array.from({ length: 97 }, (_, i) => sized(0.5 + (i % 7) * 0.3));
        const rows = justifyRows(items, 170, 4, 900);
        const laid = rows.flatMap((r) => r.cells.map((c) => c.item));
        expect(laid).toHaveLength(items.length);
        expect(new Set(laid).size).toBe(items.length);
    });

    it("handles degenerate inputs without throwing", () => {
        expect(justifyRows([], 190, 4, 1200)).toEqual([]);
        expect(justifyRows([SQUARE], 190, 4, 0)).toEqual([]);
        expect(justifyRows([{ width: 100, height: 0 }], 190, 4, 800)).toHaveLength(1);
    });

    it("gives a lone ultrawide image a sane height rather than a sliver", () => {
        const rows = justifyRows([sized(8)], 190, 4, 600);
        expect(rows[0]!.height).toBeGreaterThanOrEqual(190 * 0.5);
    });
});

describe("buildLayout", () => {
    const items = Array.from({ length: 30 }, (_, i) => [WIDE, SQUARE, TALL][i % 3] as Sized);

    it("orders flat row-major and keeps rowMap aligned", () => {
        const layout = buildLayout([{ label: null, items }], 190, 4, 1200);
        expect(layout.flat).toHaveLength(items.length);
        expect(layout.rowMap).toHaveLength(items.length);

        let cursor = 0;
        for(const block of layout.blocks){
            if(block.kind !== "row"){
                continue;
            }
            block.row.cells.forEach((cell, col) => {
                expect(layout.flat[cursor]).toBe(cell.item);
                expect(layout.rowMap[cursor]!.col).toBe(col);
                cursor++;
            });
        }
    });

    it("stacks blocks with monotonically increasing offsets", () => {
        const layout = buildLayout(
            [
                { label: "March 2026", items: items.slice(0, 12) },
                { label: "February 2026", items: items.slice(12) },
            ],
            190,
            4,
            1200,
        );
        let prev = -1;
        for(const b of layout.blocks){
            expect(b.top).toBeGreaterThanOrEqual(prev);
            prev = b.top;
        }
        expect(layout.totalHeight).toBeGreaterThan(prev);
    });

    it("gives row blocks a global rowIndex that matches rowMap across sections", () => {
        // Regression: row keys are section-local (`r{section}-{rowInSection}`)
        // while rowMap.row counts globally. Resolving a row by key suffix picked
        // the wrong block for every section after the first, so keyboard
        // scroll-into-view jumped to an unrelated row past a month boundary.
        const layout = buildLayout(
            [
                { label: "March 2026", items: items.slice(0, 12) },
                { label: "February 2026", items: items.slice(12, 24) },
                { label: "January 2026", items: items.slice(24) },
            ],
            190,
            4,
            1200,
        );

        const rowBlocks = layout.blocks.filter((b) => b.kind === "row");
        rowBlocks.forEach((b, i) => {
            expect(b.kind === "row" && b.rowIndex).toBe(i);
        });

        // Every item must resolve to the block that actually contains it.
        layout.rowMap.forEach((entry, i) => {
            const block = layout.blocks.find(
                (b) => b.kind === "row" && b.rowIndex === entry.row,
            );
            expect(block).toBeDefined();
            expect(block!.kind).toBe("row");
            if(block!.kind === "row"){
                expect(block!.row.cells[entry.col]!.item).toBe(layout.flat[i]);
            }
        });
    });

    it("emits a header block per labelled section only", () => {
        const withLabels = buildLayout(
            [
                { label: "A", items: items.slice(0, 9) },
                { label: "B", items: items.slice(9, 18) },
            ],
            190,
            4,
            1200,
        );
        expect(withLabels.blocks.filter((b) => b.kind === "header")).toHaveLength(2);

        const unlabelled = buildLayout([{ label: null, items }], 190, 4, 1200);
        expect(unlabelled.blocks.filter((b) => b.kind === "header")).toHaveLength(0);
    });
});

describe("visibleRange", () => {
    const layout = buildLayout(
        [{ label: null, items: Array.from({ length: 400 }, () => SQUARE) }],
        190,
        4,
        1200,
    );

    it("returns a small window of a large layout", () => {
        const { start, end } = visibleRange(layout.blocks, 0, 800);
        expect(end - start).toBeLessThan(layout.blocks.length);
        expect(start).toBe(0);
    });

    it("covers every block intersecting the viewport", () => {
        const scrollTop = 4000;
        const viewport = 800;
        const { start, end } = visibleRange(layout.blocks, scrollTop, viewport, 0);
        const rendered = layout.blocks.slice(start, end);
        const intersecting = layout.blocks.filter(
            (b) => b.top + b.height >= scrollTop && b.top <= scrollTop + viewport,
        );
        for(const b of intersecting){
            expect(rendered).toContain(b);
        }
    });

    it("clamps past the end of the list", () => {
        const { start, end } = visibleRange(layout.blocks, 10_000_000, 800);
        expect(start).toBe(layout.blocks.length);
        expect(end).toBe(layout.blocks.length);
    });
});
