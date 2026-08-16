// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import App from "../App";
import { useStore } from "./store";

/**
 * The click / hold / paint / range / drag-out state machine, mounted for real.
 *
 * Playwright is off limits here, so a jsdom mount is the only thing that
 * exercises the wiring rather than the geometry — `gridHit.test.ts` covers the
 * maths and `store.test.ts` covers the reducers, and neither would notice a
 * hold that selects a photo *and* opens the lightbox on top of it.
 *
 * jsdom reports a zero rect for everything, which works in our favour: content
 * coordinates collapse onto client coordinates, so a point is just a point.
 */
function stubLayoutBox(width = 1200, height = 800){
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get(){ return width; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get(){ return height; },
    });
}

const INITIAL = useStore.getState();

/** Inside the first row, first cell. */
const FIRST = { clientX: 20, clientY: 60 };

beforeEach(() => {
    stubLayoutBox();
    HTMLElement.prototype.scrollTo = () => {};
    vi.stubGlobal(
        "ResizeObserver",
        class{
            observe(){}
            unobserve(){}
            disconnect(){}
        },
    );
    vi.stubGlobal("matchMedia", (q: string) => ({
        matches: false,
        media: q,
        addEventListener(){},
        removeEventListener(){},
    }));
    useStore.setState(INITIAL, true);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function mountApp(){
    render(<App />);
    await waitFor(() => expect(useStore.getState().foldersLoaded).toBe(true));
    await waitFor(() => expect(useStore.getState().results.length).toBeGreaterThan(0));
}

function anyCell(){
    return screen.getAllByRole("button", { name: /^Select$/ })[0]!;
}

/** Real timers, not fake ones: the boot path is promise-driven and faking the
 *  clock around it deadlocks `waitFor`. */
async function wait(ms: number){
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

/** Long enough for the previous gesture's swallow-click listener to be removed,
 *  so one test cannot eat the next one's click. */
const SETTLE = 350;

describe("grid gestures", () => {
    it("a quick press opens the lightbox", async () => {
        await mountApp();
        const cell = anyCell();
        fireEvent.pointerDown(cell, { button: 0, ...FIRST });
        fireEvent.pointerUp(window, FIRST);
        fireEvent.click(cell.parentElement!, FIRST);
        expect(useStore.getState().lightboxIndex).not.toBeNull();
    });

    it("a 400ms hold selects the photo and does not open it", async () => {
        await mountApp();
        const first = useStore.getState().results[0]!;
        const cell = anyCell();

        fireEvent.pointerDown(cell, { button: 0, ...FIRST });
        await wait(450);
        expect([...useStore.getState().selectedIds]).toEqual([first.id]);
        expect(useStore.getState().anchorId).toBe(first.id);

        fireEvent.pointerUp(window, FIRST);
        // The click the browser sends after the release must be swallowed, or
        // the hold both selects and opens.
        fireEvent.click(cell.parentElement!, FIRST);
        expect(useStore.getState().lightboxIndex).toBeNull();
        expect([...useStore.getState().selectedIds]).toEqual([first.id]);
    });

    it("sweeping selects every photo the pointer crosses, live", async () => {
        await mountApp();
        const first = useStore.getState().results[0]!;

        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        fireEvent.pointerMove(window, { clientX: 600, clientY: 70 });
        // Live, not on release: the selection is already there mid-drag.
        const mid = [...useStore.getState().selectedIds];
        expect(mid.length).toBeGreaterThan(1);
        expect(mid).toContain(first.id);

        fireEvent.pointerUp(window, { clientX: 600, clientY: 70 });
        expect([...useStore.getState().selectedIds]).toEqual(mid);
        expect(useStore.getState().lightboxIndex).toBeNull();
    });

    it("a sweep adds to what was already selected", async () => {
        await mountApp();
        useStore.getState().setSelection([999_999]);

        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        fireEvent.pointerMove(window, { clientX: 400, clientY: 70 });
        fireEvent.pointerUp(window, { clientX: 400, clientY: 70 });

        expect(useStore.getState().selectedIds.has(999_999)).toBe(true);
        expect(useStore.getState().selectedIds.size).toBeGreaterThan(1);
    });

    it("Ctrl+sweep deselects what it crosses", async () => {
        await mountApp();
        // Paint a stretch, then erase part of it with the same gesture + Ctrl.
        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        fireEvent.pointerMove(window, { clientX: 600, clientY: 70 });
        fireEvent.pointerUp(window, { clientX: 600, clientY: 70 });
        const painted = useStore.getState().selectedIds.size;
        expect(painted).toBeGreaterThan(2);

        await wait(SETTLE);
        fireEvent.pointerDown(anyCell(), { button: 0, ctrlKey: true, ...FIRST });
        fireEvent.pointerMove(window, { clientX: 300, clientY: 70, ctrlKey: true });
        fireEvent.pointerUp(window, { clientX: 300, clientY: 70 });
        expect(useStore.getState().selectedIds.size).toBeLessThan(painted);
    });

    it("Shift+press selects the whole range from the anchor", async () => {
        await mountApp();
        const flatIds = useStore.getState().results.map((p) => p.id);

        // Anchor on the first photo with a hold.
        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        await wait(450);
        fireEvent.pointerUp(window, FIRST);
        expect(useStore.getState().anchorId).toBe(flatIds[0]);

        await wait(SETTLE);
        // Shift onto a photo further along the same row.
        fireEvent.pointerDown(anyCell(), { button: 0, shiftKey: true, clientX: 500, clientY: 70 });
        fireEvent.pointerUp(window, { clientX: 500, clientY: 70 });

        const selected = [...useStore.getState().selectedIds];
        expect(selected.length).toBeGreaterThan(1);
        // A range is contiguous in layout order.
        const positions = selected.map((id) => flatIds.indexOf(id)).sort((a, b) => a - b);
        expect(positions[0]).toBe(0);
        expect(positions[positions.length - 1]).toBe(positions.length - 1);
    });

    it("a Shift drag shrinks the range as well as growing it", async () => {
        await mountApp();
        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        await wait(450);
        fireEvent.pointerUp(window, FIRST);
        await wait(SETTLE);

        fireEvent.pointerDown(anyCell(), { button: 0, shiftKey: true, clientX: 600, clientY: 70 });
        const wide = useStore.getState().selectedIds.size;
        fireEvent.pointerMove(window, { clientX: 250, clientY: 70, shiftKey: true });
        const narrow = useStore.getState().selectedIds.size;
        fireEvent.pointerUp(window, { clientX: 250, clientY: 70 });
        expect(narrow).toBeLessThan(wide);
    });

    it("Shift pressed mid-drag ranges from where the press started", async () => {
        await mountApp();
        const flatIds = useStore.getState().results.map((p) => p.id);

        // A plain sweep to the right first. This also moves the store's anchor
        // to the last photo it crossed, which is what makes the assertion
        // below meaningful: a range measured from *that* would keep them.
        fireEvent.pointerDown(anyCell(), { button: 0, clientX: 500, clientY: 70 });
        fireEvent.pointerMove(window, { clientX: 900, clientY: 70 });
        const painted = [...useStore.getState().selectedIds];
        expect(painted.length).toBeGreaterThan(1);
        const rightmost = Math.max(...painted.map((id) => flatIds.indexOf(id)));

        // Shift goes down with the button still held, and the sweep becomes a
        // range from the press to the pointer.
        fireEvent.pointerMove(window, { clientX: 40, clientY: 70, shiftKey: true });
        fireEvent.pointerUp(window, { clientX: 40, clientY: 70 });

        const ranged = [...useStore.getState().selectedIds]
            .map((id) => flatIds.indexOf(id))
            .sort((a, b) => a - b);
        expect(ranged.length).toBeGreaterThan(1);
        expect(ranged[ranged.length - 1]! - ranged[0]!).toBe(ranged.length - 1);
        // The photos the sweep had already painted off to the right are gone:
        // the range runs from the press, not from the store's anchor and not
        // from wherever the sweep happened to stop.
        expect(ranged[ranged.length - 1]!).toBeLessThan(rightmost);
    });

    it("a hold that keeps moving flows straight into a sweep", async () => {
        await mountApp();
        const first = useStore.getState().results[0]!;

        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        await wait(450);
        expect([...useStore.getState().selectedIds]).toEqual([first.id]);

        // The finger never came up. The hold used to disarm the gesture here,
        // so the rest of the drag did nothing at all.
        fireEvent.pointerMove(window, { clientX: 600, clientY: 70 });
        const swept = [...useStore.getState().selectedIds];
        expect(swept.length).toBeGreaterThan(1);
        expect(swept).toContain(first.id);
        // And it must not carry the photo it just marked instead of painting.
        expect(useStore.getState().dragOut.active).toBe(false);

        fireEvent.pointerUp(window, { clientX: 600, clientY: 70 });
    });

    it("a hold that deselects sweeps in reverse", async () => {
        await mountApp();
        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        fireEvent.pointerMove(window, { clientX: 600, clientY: 70 });
        fireEvent.pointerUp(window, { clientX: 600, clientY: 70 });
        const painted = useStore.getState().selectedIds.size;
        expect(painted).toBeGreaterThan(2);
        await wait(SETTLE);

        // Holding an already-selected photo takes it out; the sweep that grows
        // from that hold has to keep taking, not put the whole row back.
        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        await wait(450);
        fireEvent.pointerMove(window, { clientX: 600, clientY: 70 });
        fireEvent.pointerUp(window, { clientX: 600, clientY: 70 });
        expect(useStore.getState().selectedIds.size).toBeLessThan(painted);
    });

    it("dragging a selected photo carries it instead of painting", async () => {
        await mountApp();
        // Select one photo by holding it, then drag from it.
        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        await wait(450);
        fireEvent.pointerUp(window, FIRST);
        const selected = [...useStore.getState().selectedIds];
        await wait(SETTLE);

        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        fireEvent.pointerMove(window, { clientX: 600, clientY: 70 });
        expect(useStore.getState().dragOut.active).toBe(true);
        expect(useStore.getState().dragOut.count).toBe(selected.length);
        // The sweep must not have painted anything on the way.
        expect([...useStore.getState().selectedIds]).toEqual(selected);

        fireEvent.pointerUp(window, { clientX: 600, clientY: 70 });
        expect(useStore.getState().dragOut.active).toBe(false);
    });

    it("clicking the background clears the selection", async () => {
        await mountApp();
        fireEvent.pointerDown(anyCell(), { button: 0, ...FIRST });
        await wait(450);
        fireEvent.pointerUp(window, FIRST);
        expect(useStore.getState().selectedIds.size).toBe(1);

        await wait(SETTLE);
        const empty = { clientX: 20, clientY: 999_999 };
        fireEvent.pointerDown(anyCell(), { button: 0, ...empty });
        fireEvent.pointerUp(window, empty);
        expect(useStore.getState().selectedIds.size).toBe(0);
    });
});
