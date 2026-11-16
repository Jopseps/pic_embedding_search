// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GridCell } from "./GridCell";
import type { Photo } from "../lib/types";

afterEach(cleanup);

const photo: Photo = {
    id: 1, path: "/p/1.png", filename: "1.png", folder: "/p", width: 100, height: 100,
    mime: "image/png", takenAt: null, dateSource: null, isScreenshot: false, hasOcr: false,
    ocrText: null, snippet: null, isDupe: false, collections: [],
};

function cell(selected: boolean){
    const { container } = render(
        <GridCell
            photo={photo} width={120} height={80} selected={selected} focused={false}
            hovered={false} anySelected={selected} onOpen={() => {}}
            onToggleSelect={() => {}} onHover={() => {}}
        />,
    );
    return container.firstElementChild as HTMLElement;
}

describe("selected cell", () => {
    it("is framed in the accent, by pulling the image in rather than growing the cell", () => {
        const outer = cell(true);
        expect(outer.style.background).toContain("var(--accent)");
        // Same box as an unselected cell: no neighbour moves.
        expect(outer.style.width).toBe("120px");
        expect(outer.style.height).toBe("80px");
        const inner = outer.firstElementChild as HTMLElement;
        expect(inner.style.inset).toContain("--sel-border");
        expect(inner.style.inset).toContain("--ui-scale");
    });

    it("draws a canvas-coloured hairline between the photo and the frame", () => {
        const outer = cell(true);
        const hairline = Array.from(outer.querySelectorAll<HTMLElement>("div"))
            .find((el) => el.style.boxShadow.includes("--surface-canvas"));
        expect(hairline).toBeDefined();
    });

    it("has neither when unselected", () => {
        const outer = cell(false);
        expect(outer.style.background).toBe("");
        expect(outer.querySelector("[style*='--surface-canvas']")).toBeNull();
    });
});
