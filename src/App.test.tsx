// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import App from "./App";
import { useStore } from "./lib/store";
import { api } from "./lib/api";

/**
 * Mount tests. These are the only checks that prove the app *renders* rather
 * than merely compiles — tsc and vite never execute a component.
 *
 * jsdom has no layout engine, so clientWidth is 0 and the justified grid would
 * lay out nothing. Stubbing the two size properties is what makes the grid
 * observable at all.
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
    // jsdom implements no scrolling API at all.
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
    // Boot does three async loads; wait until the library actually has rows.
    await waitFor(() => expect(useStore.getState().foldersLoaded).toBe(true));
    await waitFor(() => expect(useStore.getState().results.length).toBeGreaterThan(0));
}

describe("App", () => {
    it("mounts and renders photo cells from the mock library", async () => {
        await mountApp();
        const cells = await screen.findAllByRole("button", { name: /^Select$/ });
        expect(cells.length).toBeGreaterThan(0);
    });

    it("applies the resolved theme to the document element", async () => {
        await mountApp();
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });

    it("renders the sidebar, search input and indexing indicator", async () => {
        await mountApp();
        expect(screen.getByPlaceholderText(/Search your photos/i)).toBeTruthy();
        expect(screen.getByText("LIBRARY")).toBeTruthy();
        expect(screen.getByText("COLLECTIONS")).toBeTruthy();
        expect(screen.getByText(/Indexing|Up to date/)).toBeTruthy();
    });

    it("virtualizes — renders far fewer cells than the library holds", async () => {
        await mountApp();
        const total = useStore.getState().results.length;
        const rendered = screen.getAllByRole("button", { name: /^Select$/ }).length;
        expect(total).toBeGreaterThan(300);
        expect(rendered).toBeLessThan(total / 2);
    });

    it("shows search results and a result count", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setQuery("table");
        });
        await waitFor(() => expect(useStore.getState().searching).toBe(false));
        expect(screen.getByText("Search results")).toBeTruthy();
        await waitFor(() => expect(screen.getByText(/result.*·.*ms/)).toBeTruthy());
    });

    it("shows the empty-search state for a query that matches nothing", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setQuery("zzzzzznotathing");
        });
        await waitFor(() =>
            expect(screen.getByText(/No results for/)).toBeTruthy(),
        );
    });

    it("opens the lightbox on a cell click and pages with the arrow controls", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().openLightbox(0);
        });
        const position = await screen.findByText(/^1 \/ \d+$/);
        expect(position).toBeTruthy();

        await act(async () => {
            screen.getByLabelText("Next").click();
        });
        expect(screen.getByText(/^2 \/ \d+$/)).toBeTruthy();
    });

    it("surfaces the selection bar once a photo is selected", async () => {
        await mountApp();
        const first = useStore.getState().results[0]!;
        await act(async () => {
            useStore.getState().toggleSelect(first.id);
        });
        expect(screen.getByText("1 selected")).toBeTruthy();
        expect(screen.getByText(/Add to collection/)).toBeTruthy();
    });

    it("puts the selection into a collection through the menu", async () => {
        await mountApp();
        const first = useStore.getState().results[0]!;
        await act(async () => {
            useStore.getState().toggleSelect(first.id);
            useStore.getState().toggleCollectionMenu();
        });
        // The menu lists what the backend returned at boot, not a literal. The
        // name is on screen twice now — the sidebar row and the menu entry.
        const target = useStore.getState().collections[0]!;
        expect(screen.getAllByText(target.name).length).toBe(2);

        await act(async () => {
            await useStore.getState().addSelectionToCollection(target.id);
        });
        const after = useStore.getState().results.find((p) => p.id === first.id)!;
        expect(after.collections).toContain(target.id);
        // Adding closes the menu and drops the selection, or the bar sticks
        // around over a selection that has already been dealt with.
        expect(useStore.getState().collectionMenuOpen).toBe(false);
        expect(useStore.getState().selectedIds.size).toBe(0);
    });

    it("restores the filters a saved search was saved with", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setQuery("table");
            useStore.getState().toggleTypeFilter("Screenshot");
        });
        await act(async () => {
            await useStore.getState().saveCurrentSearch();
        });
        const saved = useStore.getState().savedSearches.at(-1)!;
        expect(saved.filters.types).toEqual(["Screenshot"]);

        await act(async () => {
            useStore.getState().clearAllFilters();
            useStore.getState().setQuery("");
        });
        await act(async () => {
            useStore.getState().runSavedSearch(saved);
        });
        expect(useStore.getState().query).toBe("table");
        expect(useStore.getState().filters.types).toEqual(["Screenshot"]);
    });

    it("renders settings with the real model catalog, not the design placeholders", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setView("settings");
        });
        expect(screen.getByText("SigLIP 2 so400m")).toBeTruthy();
        expect(screen.getByText("RapidOCR")).toBeTruthy();
        expect(screen.getByText("Turkish")).toBeTruthy();
        // The design draft offered these; neither is valid for this app.
        expect(screen.queryByText("Apple Vision")).toBeNull();
        expect(screen.queryByText("CLIP ViT-B/32")).toBeNull();
    });

    it("blocks search and warns while a model change re-indexes", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().selectModel("jina-clip-v2");
            useStore.getState().confirmModelChange();
        });
        expect(useStore.getState().reindex.active).toBe(true);
        expect(screen.getByText(/Search unavailable while re-indexing/)).toBeTruthy();
        const input = screen.getByPlaceholderText(/re-indexing/i) as HTMLInputElement;
        expect(input.disabled).toBe(true);
    });

    it("shows the empty-library state when no folders are watched", async () => {
        vi.spyOn(api, "listFolders").mockResolvedValue([]);
        vi.spyOn(api, "search").mockResolvedValue({
            items: [],
            total: 0,
            tookMs: 1,
            cursor: null,
        });
        render(<App />);
        await waitFor(() => expect(useStore.getState().foldersLoaded).toBe(true));
        expect(await screen.findByText("No folders yet")).toBeTruthy();
    });

    it("recovers from a backend failure instead of pinning to the loading state", async () => {
        vi.spyOn(api, "listFolders").mockRejectedValue(new Error("connection refused"));
        vi.spyOn(api, "search").mockRejectedValue(new Error("connection refused"));
        render(<App />);

        // The gate must still flip, or gridMode() stays "loading" forever.
        await waitFor(() => expect(useStore.getState().foldersLoaded).toBe(true));
        const banner = await screen.findByText(/Cannot reach the indexing service/);
        expect(banner).toBeTruthy();
        expect(within(banner.parentElement!).getByText("Retry")).toBeTruthy();
    });
});
