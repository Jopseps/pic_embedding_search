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
async function open(){
    render(<App />);
    await waitFor(() => expect(useStore.getState().results.length).toBeGreaterThan(0));
    const photo = useStore.getState().results[0]!;
    await act(async () => {
        useStore.getState().openLightbox(0);
    });
    const labels = screen.getAllByText(`${photo.width}×${photo.height}`);
    // The lightbox mounts after the grid, so its copy is the last one.
    const picture = labels[labels.length - 1]!.closest("div")!;
    return { picture, stage: picture.parentElement! };
}

async function openStage(){
    return (await open()).stage;
}

/** A press and its release. The close handler needs both ends — a bare click
 *  leaves the press unrecorded and nothing happens, for the wrong reason. */
function press(el: Element, at: { clientX: number; clientY: number }, to = at){
    fireEvent.pointerDown(el, { button: 0, ...at });
    fireEvent.pointerUp(el, to);
    fireEvent.click(el, to);
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

    /** WebKitGTK — the webview Tauri uses on Linux — reports deltaMode 1 with a
     *  deltaY of 1–3 per notch where Chrome reports ~100 pixels. Scaling by the
     *  raw number makes a notch there worth a fiftieth of the same notch here,
     *  which is the whole reason line mode is treated as discrete. */
    it("treats one line-mode notch as a full step", async () => {
        const stage = await openStage();
        stubPictureBox();
        fireEvent.wheel(stage, { deltaY: -1, deltaMode: 1, clientX: 600, clientY: 350 });
        expect(await screen.findByText(/115% · reset/)).toBeTruthy();
    });

    /** A trackpad streams dozens of tiny deltas a second. A flat step per event
     *  ran the scale to MAX_SCALE in half a swipe — twenty of these used to
     *  land on 800%. */
    it("does not slam to the top on a trackpad swipe", async () => {
        const stage = await openStage();
        stubPictureBox();
        for(let i = 0; i < 20; i++){
            fireEvent.wheel(stage, { deltaY: -4, clientX: 600, clientY: 350 });
        }
        expect(await screen.findByText(/112% · reset/)).toBeTruthy();
    });

    it("zooms and resets from the keyboard", async () => {
        await openStage();
        fireEvent.keyDown(window, { key: "+" });
        expect(await screen.findByText(/140% · reset/)).toBeTruthy();
        fireEvent.keyDown(window, { key: "0" });
        expect(screen.queryByText(/reset/)).toBeNull();
    });
});

describe("Lightbox backdrop", () => {
    it("closes when the backdrop is clicked", async () => {
        const stage = await openStage();
        press(stage, { clientX: 60, clientY: 60 });
        expect(useStore.getState().lightboxIndex).toBeNull();
    });

    it("stays open when the picture is clicked", async () => {
        const { picture } = await open();
        press(picture, { clientX: 600, clientY: 350 });
        expect(useStore.getState().lightboxIndex).toBe(0);
    });

    it("stays open when a control is clicked", async () => {
        await open();
        press(screen.getByLabelText("Next"), { clientX: 900, clientY: 350 });
        expect(useStore.getState().lightboxIndex).toBe(1);
    });

    /** A pan that started on the backdrop is a drag, not a click — releasing it
     *  must not take the photo away. */
    it("stays open when the press travelled", async () => {
        const stage = await openStage();
        press(stage, { clientX: 100, clientY: 100 }, { clientX: 160, clientY: 100 });
        expect(useStore.getState().lightboxIndex).toBe(0);
    });

    /** In fullscreen the backdrop is nearly the whole screen, so this drops one
     *  rung down the Esc ladder rather than losing the photo outright. */
    it("leaves fullscreen instead of closing", async () => {
        const stage = await openStage();
        await act(async () => {
            useStore.getState().toggleLightboxFullscreen();
        });
        press(stage, { clientX: 60, clientY: 60 });
        expect(useStore.getState().lightboxFullscreen).toBe(false);
        expect(useStore.getState().lightboxIndex).toBe(0);
    });
});
