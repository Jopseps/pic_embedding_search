// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
        // One page, not the whole fixture library: `pageSize` is a setting and
        // the mock adapter pages like the sidecar does.
        expect(total).toBe(useStore.getState().settings.pageSize);
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

    it("closes the collection menu when the selection empties", async () => {
        await mountApp();
        const first = useStore.getState().results[0]!;
        await act(async () => {
            useStore.getState().toggleSelect(first.id);
            useStore.getState().toggleCollectionMenu();
        });
        expect(useStore.getState().collectionMenuOpen).toBe(true);

        // The bar unmounts at zero, so a menu left open reappears already open.
        await act(async () => {
            useStore.getState().toggleSelect(first.id);
        });
        expect(useStore.getState().collectionMenuOpen).toBe(false);
    });

    it("does not sweep the selection into a collection named from the sidebar", async () => {
        await mountApp();
        const first = useStore.getState().results[0]!;
        await act(async () => {
            useStore.getState().toggleSelect(first.id);
            // Sidebar path: the menu is closed, so naming one asks for an
            // empty collection, not one holding whatever is selected.
            useStore.getState().startAddCollection();
            useStore.getState().setNewCollectionName("Empty");
        });
        await act(async () => {
            await useStore.getState().commitCollection();
        });
        const after = useStore.getState().results.find((p) => p.id === first.id)!;
        const made = useStore.getState().collections.find((c) => c.name === "Empty")!;
        expect(after.collections).not.toContain(made.id);
        expect(useStore.getState().selectedIds.size).toBe(1);
    });

    it("arms before deleting a collection", async () => {
        await mountApp();
        const target = useStore.getState().collections[0]!;
        await act(async () => {
            await useStore.getState().deleteCollection(target.id);
        });
        // First click arms only — losing a collection loses its membership.
        expect(useStore.getState().pendingCollectionDelete).toBe(target.id);
        expect(useStore.getState().collections).toContainEqual(target);

        await act(async () => {
            await useStore.getState().deleteCollection(target.id);
        });
        expect(useStore.getState().collections).not.toContainEqual(target);
        expect(useStore.getState().pendingCollectionDelete).toBeNull();
    });

    it("restores the previous search when leaving \"find similar\"", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setQuery("table");
            useStore.getState().toggleTypeFilter("Screenshot");
        });
        await act(async () => {
            await useStore.getState().runSearch();
        });
        const wasShowing = useStore.getState().results.map((p) => p.id);

        await act(async () => {
            await useStore.getState().findSimilar(useStore.getState().results[0]!);
        });
        expect(useStore.getState().similarTo).not.toBeNull();
        expect(useStore.getState().query).toBe("");

        await act(async () => {
            useStore.getState().exitSimilar();
        });
        // Not the All tab: the search the user came from, filters included.
        expect(useStore.getState().query).toBe("table");
        expect(useStore.getState().filters.types).toEqual(["Screenshot"]);
        expect(useStore.getState().similarTo).toBeNull();
        expect(useStore.getState().results.map((p) => p.id)).toEqual(wasShowing);
    });

    it("keeps one origin when find-similar is used twice in a row", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setQuery("table");
        });
        await act(async () => {
            await useStore.getState().runSearch();
        });
        await act(async () => {
            await useStore.getState().findSimilar(useStore.getState().results[0]!);
        });
        // Chaining must not overwrite the origin with the similar-results view,
        // or Esc lands somewhere the user was never at.
        await act(async () => {
            await useStore.getState().findSimilar(useStore.getState().results[0]!);
        });
        await act(async () => {
            useStore.getState().exitSimilar();
        });
        expect(useStore.getState().query).toBe("table");
    });

    it("shows the library count in the sidebar, not the result count", async () => {
        await mountApp();
        const library = useStore.getState().counts.library;
        expect(library).toBeGreaterThan(0);

        await act(async () => {
            useStore.getState().setQuery("nothing-matches-this-xyzzy");
        });
        await act(async () => {
            await useStore.getState().runSearch();
        });
        // The count that used to move with every keystroke.
        expect(useStore.getState().total).toBe(0);
        expect(useStore.getState().counts.library).toBe(library);
    });

    it("keeps search working while a model swap runs", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().selectModel("jina-clip-v2");
        });
        await act(async () => {
            await useStore.getState().confirmModelChange();
        });
        expect(useStore.getState().reindex.active).toBe(true);

        await act(async () => {
            useStore.getState().setQuery("table");
        });
        await act(async () => {
            await useStore.getState().runSearch();
        });
        // The old model still holds every vector it had — searching it is the
        // whole reason the swap does not delete anything.
        expect(useStore.getState().results.length).toBeGreaterThan(0);
    });

    it("exits fullscreen before closing the lightbox", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().openLightbox(0);
            useStore.getState().toggleLightboxFullscreen();
        });
        expect(useStore.getState().lightboxFullscreen).toBe(true);

        await act(async () => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        // First Escape leaves fullscreen; the photo is still open.
        expect(useStore.getState().lightboxFullscreen).toBe(false);
        expect(useStore.getState().lightboxIndex).not.toBeNull();

        await act(async () => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(useStore.getState().lightboxIndex).toBeNull();
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
        // Settings shows one section at a time now, so each catalog is behind
        // its own nav entry rather than one long scroll.
        await act(async () => {
            fireEvent.click(screen.getByText("Search model"));
        });
        expect(screen.getByText("SigLIP 2 so400m")).toBeTruthy();
        expect(screen.queryByText("CLIP ViT-B/32")).toBeNull();

        await act(async () => {
            fireEvent.click(screen.getByText("Text in images"));
        });
        expect(screen.getByText("RapidOCR")).toBeTruthy();
        expect(screen.getByText("Turkish")).toBeTruthy();
        // The design draft offered this; it does not exist on Linux.
        expect(screen.queryByText("Apple Vision")).toBeNull();
    });

    it("filters the settings nav and shows every section that matches", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setView("settings");
        });
        const filter = screen.getByPlaceholderText("Filter settings…");
        await act(async () => {
            fireEvent.change(filter, { target: { value: "contrast" } });
        });
        // Accessibility owns the word; nothing from the default Folders section
        // is on screen any more.
        expect(screen.getByText("High contrast")).toBeTruthy();
        expect(screen.queryByText("Watched folders")).toBeNull();
    });

    it("renders the colour, gesture and search settings and applies what they change", async () => {
        // These three sections only mount when their nav item is active or the
        // filter matches them, so without this they are typechecked and never
        // once rendered.
        await mountApp();
        await act(async () => {
            useStore.getState().setView("settings");
        });
        const filter = screen.getByPlaceholderText("Filter settings…");

        await act(async () => {
            fireEvent.change(filter, { target: { value: "accent" } });
        });
        const hue = screen.getByLabelText("Accent hue") as HTMLInputElement;
        expect(screen.getByLabelText("Teal")).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByLabelText("Teal"));
        });
        expect(useStore.getState().settings.accentHue).toBe(195);
        expect(hue.value).toBe("195");

        await act(async () => {
            fireEvent.change(filter, { target: { value: "hold" } });
        });
        await act(async () => {
            fireEvent.change(
                screen.getByLabelText("Drag threshold"), { target: { value: "9" } },
            );
        });
        expect(useStore.getState().settings.dragSlop).toBe(9);

        await act(async () => {
            fireEvent.change(filter, { target: { value: "page size" } });
        });
        await act(async () => {
            fireEvent.change(
                screen.getByLabelText("Text versus visual weighting"),
                { target: { value: "80" } },
            );
        });
        expect(useStore.getState().settings.textWeight).toBe(80);
    });

    it("scales the whole UI, grid included, from the accessibility setting", async () => {
        await mountApp();
        const before = useStore.getState().settings.uiScale;
        expect(document.documentElement.style.getPropertyValue("--ui-scale"))
            .toBe(String(before / 100));
        await act(async () => {
            useStore.getState().setUiScale(150);
        });
        expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1.5");
    });

    it("puts the colour settings on the root element, where every theme reads them", async () => {
        await mountApp();
        const root = document.documentElement;
        expect(root.style.getPropertyValue("--accent-hue")).toBe("255");

        await act(async () => {
            useStore.getState().setSetting("accentHue", 145);
            useStore.getState().setSetting("tintStrength", 0);
            useStore.getState().setSetting("selectionBorder", 2);
        });
        // A hue and a multiplier, not a colour: the theme blocks in tokens.css
        // keep their own lightness and chroma, so one write covers dark, light
        // and both high-contrast variants.
        expect(root.style.getPropertyValue("--accent-hue")).toBe("145");
        expect(root.style.getPropertyValue("--tint-c")).toBe("0");
        expect(root.style.getPropertyValue("--sel-border")).toBe("2px");
    });

    it("says which model is still answering while a model change re-indexes", async () => {
        await mountApp();
        // A different target from the swap test above: `MockApi` is a module
        // singleton, so a model it already switched to is a no-op here.
        await act(async () => {
            useStore.getState().selectModel("siglip2-base-patch16-224");
        });
        await act(async () => {
            await useStore.getState().confirmModelChange();
        });
        expect(useStore.getState().reindex.active).toBe(true);
        expect(screen.getByText(/Still searching with/)).toBeTruthy();
        // The search box stays usable — the old vectors are all still there.
        const input = screen.getByPlaceholderText(/re-indexing in the background/i) as HTMLInputElement;
        expect(input.disabled).toBe(false);

        // And it finishes. With a sidecar `model-changed` ends the swap; in a
        // browser nothing else would, so the banner would sit at 0% forever
        // and `tickIndexing` — which bails while `reindex.active` — with it.
        await waitFor(
            () => expect(useStore.getState().reindex.active).toBe(false),
            { timeout: 6000 },
        );
        expect(useStore.getState().settings.modelId).toBe("siglip2-base-patch16-224");
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

    /**
     * The page-zoom guard. jsdom has no page zoom, so what is checkable here is
     * that the handler is bound and that it reads the wheel event the way every
     * webview reports it — which is the half that was wrong: `deltaMode` is
     * lines, not pixels, in WebKitGTK.
     */
    it("steps the grid density on ctrl+wheel rather than scaling the app", async () => {
        // `setDensity` persists, and the mock backend keeps what it was given
        // for the whole file — boot reads it back, so a neighbouring test that
        // zoomed would decide where this one starts.
        await api.putSettings({ density: 1 });
        await mountApp();
        expect(useStore.getState().density).toBe(1);

        await act(async () => {
            window.dispatchEvent(new WheelEvent("wheel", {
                deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true,
            }));
        });
        expect(useStore.getState().density).toBe(2);

        await act(async () => {
            window.dispatchEvent(new WheelEvent("wheel", {
                deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true,
            }));
        });
        expect(useStore.getState().density).toBe(1);
    });

    it("reads a line-mode wheel, which is what the Linux webview sends", async () => {
        await api.putSettings({ density: 1 });
        await mountApp();
        // deltaMode 1 with deltaY 3 is one notch in WebKitGTK. Treated as
        // pixels it needs fifteen notches per step and reads as a dead control.
        await act(async () => {
            window.dispatchEvent(new WheelEvent("wheel", {
                deltaY: -3, deltaMode: 1, ctrlKey: true, bubbles: true, cancelable: true,
            }));
        });
        expect(useStore.getState().density).toBe(2);
    });

    it("leaves the grid alone when the lightbox is open, so the image zooms", async () => {
        await api.putSettings({ density: 1 });
        await mountApp();
        await act(async () => {
            useStore.getState().openLightbox(0);
        });
        await act(async () => {
            window.dispatchEvent(new WheelEvent("wheel", {
                deltaY: -400, ctrlKey: true, bubbles: true, cancelable: true,
            }));
        });
        expect(useStore.getState().density).toBe(1);
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
