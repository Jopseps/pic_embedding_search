// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The drop listener's one job beyond plumbing: a photo dragged out of the grid
 * and back over the window is the app's own drag and must not search.
 */
let deliver: (payload: unknown) => void = () => {};
const startDrag = vi.fn();

vi.mock("@tauri-apps/api/webview", () => ({
    getCurrentWebview: () => ({
        onDragDropEvent: async (cb: (e: { payload: unknown }) => void) => {
            deliver = (payload) => cb({ payload });
            return () => {};
        },
    }),
}));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({
    startDrag: (...args: unknown[]) => startDrag(...args),
}));

const POS = { x: 1, y: 1 };

afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    startDrag.mockReset();
});

function handlers(){
    return { enter: vi.fn(), leave: vi.fn(), drop: vi.fn() };
}

describe("listenFileDrop", () => {
    it("does nothing outside the desktop shell", async () => {
        const { listenFileDrop } = await import("./tauri");
        const h = handlers();
        const off = await listenFileDrop(h);
        expect(typeof off).toBe("function");
        deliver({ type: "drop", paths: ["/x.jpg"], position: POS });
        expect(h.drop).not.toHaveBeenCalled();
    });

    it("forwards enter, leave and drop, and ignores the per-move over events", async () => {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
        const { listenFileDrop } = await import("./tauri");
        const h = handlers();
        await listenFileDrop(h);
        deliver({ type: "enter", paths: ["/x.jpg"], position: POS });
        deliver({ type: "over", position: POS });
        deliver({ type: "leave" });
        deliver({ type: "drop", paths: ["/x.jpg", "/y.jpg"], position: POS });
        expect(h.enter).toHaveBeenCalledTimes(1);
        expect(h.leave).toHaveBeenCalledTimes(1);
        expect(h.drop).toHaveBeenCalledWith(["/x.jpg", "/y.jpg"]);
    });

    it("ignores the app's own drag coming back in and clears the overlay", async () => {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
        vi.useFakeTimers();
        const { listenFileDrop, startFileDrag, ownDragInFlight } = await import("./tauri");
        let end: () => void = () => {};
        startDrag.mockImplementation(async (_opts: unknown, cb: () => void) => {
            end = cb;
        });
        const h = handlers();
        await listenFileDrop(h);

        await startFileDrag(["/lib/a.jpg"]);
        expect(ownDragInFlight()).toBe(true);
        deliver({ type: "enter", paths: ["/lib/a.jpg"], position: POS });
        deliver({ type: "drop", paths: ["/lib/a.jpg"], position: POS });
        expect(h.enter).not.toHaveBeenCalled();
        expect(h.drop).not.toHaveBeenCalled();
        expect(h.leave).toHaveBeenCalledTimes(2);   // the overlay can never stick

        // The plugin reports the end; a drop landing just after is still ours.
        end();
        deliver({ type: "drop", paths: ["/lib/a.jpg"], position: POS });
        expect(h.drop).not.toHaveBeenCalled();

        // Afterwards a real external drop works again.
        vi.advanceTimersByTime(1000);
        expect(ownDragInFlight()).toBe(false);
        deliver({ type: "drop", paths: ["/other/b.png"], position: POS });
        expect(h.drop).toHaveBeenCalledWith(["/other/b.png"]);
    });

    it("stops ignoring on its own if the plugin never reports the end", async () => {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
        vi.useFakeTimers();
        const { startFileDrag, ownDragInFlight } = await import("./tauri");
        startDrag.mockImplementation(async () => {});
        await startFileDrag(["/lib/a.jpg"]);
        expect(ownDragInFlight()).toBe(true);
        vi.advanceTimersByTime(61_000);
        expect(ownDragInFlight()).toBe(false);
    });
});
