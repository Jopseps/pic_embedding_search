// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import App from "../App";
import { useStore } from "../lib/store";

/**
 * Regression guard for the wheel-zoom listener.
 *
 * It was attached in an effect with an empty dependency array, and the
 * component renders `null` while the lightbox is closed — so at app start the
 * stage did not exist, the effect bailed, and wheel zoom was dead for the whole
 * session with nothing in the console to say so. Only a mount test catches
 * that: the code reads correctly, it just never runs.
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

/** The mock adapter has no file URLs, so the stage renders its dimension
 *  placeholder — whose parent is the stage the listener hangs off. */
async function openStage(){
    render(<App />);
    await waitFor(() => expect(useStore.getState().results.length).toBeGreaterThan(0));
    const photo = useStore.getState().results[0]!;
    await act(async () => {
        useStore.getState().openLightbox(0);
    });
    const labels = screen.getAllByText(`${photo.width}×${photo.height}`);
    // The lightbox mounts after the grid, so its copy is the last one.
    return labels[labels.length - 1]!.closest("div")!.parentElement!;
}

describe("Lightbox zoom", () => {
    it("zooms on a plain wheel, with no modifier key", async () => {
        const stage = await openStage();
        fireEvent.wheel(stage, { deltaY: -100 });
        expect(await screen.findByText(/115% · reset/)).toBeTruthy();
    });

    it("stops at fit on the way out instead of shrinking past it", async () => {
        const stage = await openStage();
        fireEvent.wheel(stage, { deltaY: 100 });
        expect(screen.queryByText(/reset/)).toBeNull();
    });

    it("resets when the reset button is used", async () => {
        const stage = await openStage();
        fireEvent.wheel(stage, { deltaY: -100 });
        fireEvent.click(await screen.findByText(/115% · reset/));
        expect(screen.queryByText(/reset/)).toBeNull();
    });

    /** The stage is the whole band between the arrows and is mostly empty
     *  backdrop, so a wheel out there used to move a photo the cursor was
     *  nowhere near. Stubbed after the mount so the grid's own layout pass is
     *  not measured against this box. */
    function stubPictureBox(){
        Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
            configurable: true,
            value: () => ({
                left: 400, top: 200, right: 800, bottom: 500,
                width: 400, height: 300, x: 400, y: 200, toJSON(){},
            }),
        });
    }

    it("ignores a wheel that is outside the picture", async () => {
        const stage = await openStage();
        stubPictureBox();
        fireEvent.wheel(stage, { deltaY: -100, clientX: 60, clientY: 60 });
        expect(screen.queryByText(/reset/)).toBeNull();
    });

    it("still zooms when the wheel is over the picture", async () => {
        const stage = await openStage();
        stubPictureBox();
        fireEvent.wheel(stage, { deltaY: -100, clientX: 600, clientY: 350 });
        expect(await screen.findByText(/115% · reset/)).toBeTruthy();
    });
});
