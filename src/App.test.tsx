// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import App from "./App";
import { useStore } from "./lib/store";
import { api } from "./lib/api";
import { en } from "./lib/i18n/en";
import { tr } from "./lib/i18n/tr";

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

    it("swallows the page-zoom chords even while the search box has focus", async () => {
        await mountApp();
        const input = screen.getByPlaceholderText(/Search your photos/);
        input.focus();
        // `fireEvent` returns false when the default was prevented.
        for(const key of ["=", "+", "-", "0"]){
            expect(fireEvent.keyDown(input, { key, ctrlKey: true })).toBe(false);
        }
        // Typing the same characters plain is still typing.
        expect(fireEvent.keyDown(input, { key: "-" })).toBe(true);
    });

    it("leaves Space to a focused button instead of selecting a photo", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setFocusedIndex(0);
        });
        const button = screen.getByLabelText("Settings");
        button.focus();
        fireEvent.keyDown(button, { key: " " });
        expect(useStore.getState().selectedIds.size).toBe(0);
        fireEvent.keyDown(document.body, { key: " " });
        expect(useStore.getState().selectedIds.size).toBe(1);
    });

    it("does not select a skeleton while a search is loading", async () => {
        await mountApp();
        await act(async () => {
            useStore.setState({ focusedIndex: 0, searching: true });
        });
        fireEvent.keyDown(document.body, { key: " " });
        expect(useStore.getState().selectedIds.size).toBe(0);
    });

    it("makes the app behind the viewer inert while it is open", async () => {
        await mountApp();
        const topBar = screen.getByLabelText("Settings").closest("div.flex-shrink-0")!.parentElement!;
        expect(topBar.hasAttribute("inert")).toBe(false);
        await act(async () => {
            useStore.getState().openLightbox(0);
        });
        const dialog = screen.getByRole("dialog");
        const siblings = Array.from(dialog.parentElement!.children).filter((el) => el !== dialog);
        expect(siblings.length).toBeGreaterThan(0);
        expect(siblings.every((el) => el.hasAttribute("inert"))).toBe(true);
        await act(async () => {
            useStore.getState().closeLightbox();
        });
        expect(document.querySelectorAll("[inert]").length).toBe(0);
    });

    it("Esc in the new-collection box closes the box and keeps the query", async () => {
        await mountApp();
        await act(async () => {
            useStore.setState({ query: "masa" });
            useStore.getState().startAddCollection();
        });
        const box = screen.getAllByPlaceholderText("Collection name")[0]!;
        fireEvent.keyDown(box, { key: "Escape" });
        expect(useStore.getState().addingCollection).toBe(false);
        expect(useStore.getState().query).toBe("masa");
    });

    it("asks before moving to the trash: Cancel is focused, Esc cancels, nothing is deleted", async () => {
        await mountApp();
        // The top bar grabs focus for the search box 60 ms after launch.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 100));
        });
        const del = vi.spyOn(api, "deletePhotos").mockResolvedValue({ removed: 2, failed: [] });
        const ids = useStore.getState().results.slice(0, 2).map((p) => p.id);
        await act(async () => {
            useStore.setState({ selectedIds: new Set(ids) });
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
        });
        const dialog = screen.getByRole("alertdialog");
        expect(within(dialog).getByText("Move 2 photos to the trash?")).toBeTruthy();
        expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));

        fireEvent.keyDown(document.activeElement!, { key: "Escape" });
        expect(screen.queryByRole("alertdialog")).toBeNull();
        // Esc was Cancel only: it did not also clear the selection underneath.
        expect(useStore.getState().selectedIds.size).toBe(2);
        expect(del).not.toHaveBeenCalled();
    });

    it("the confirm button moves the selection to the trash", async () => {
        await mountApp();
        const del = vi.spyOn(api, "deletePhotos").mockResolvedValue({ removed: 1, failed: [] });
        const id = useStore.getState().results[0]!.id;
        await act(async () => {
            useStore.setState({ selectedIds: new Set([id]), deleteConfirm: true });
        });
        const dialog = screen.getByRole("alertdialog");
        expect(within(dialog).getByText("Move 1 photo to the trash?")).toBeTruthy();
        await act(async () => {
            fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));
        });
        expect(del).toHaveBeenCalledWith([id]);
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("shows the pause button in the real app too, and it calls the api", async () => {
        await mountApp();
        const pause = vi.spyOn(api, "setIndexingPaused").mockResolvedValue();
        await act(async () => {
            fireEvent.click(screen.getByText(/Indexing \d/));
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Pause indexing" }));
        });
        expect(pause).toHaveBeenCalledWith(true);
        expect(screen.getByText("Indexing paused")).toBeTruthy();
    });

    it("a browser file drop runs find-similar and shows the file's name", async () => {
        await mountApp();
        const root = document.querySelector("div.h-screen")!;
        const file = new File(["x"], "cat.jpg", { type: "image/jpeg" });
        await act(async () => {
            fireEvent.dragEnter(root, { dataTransfer: { files: [file] } });
        });
        expect(screen.getByText("Drop to find similar photos")).toBeTruthy();
        await act(async () => {
            fireEvent.drop(root, { dataTransfer: { files: [file] } });
        });
        await waitFor(() => expect(useStore.getState().similarTo?.filename).toBe("cat.jpg"));
        expect(screen.queryByText("Drop to find similar photos")).toBeNull();
        expect(await screen.findByText("Similar to cat.jpg")).toBeTruthy();
    });

    it("removing a watched folder asks first and says the files stay on disk", async () => {
        await mountApp();
        const remove = vi.spyOn(api, "removeFolder").mockResolvedValue();
        await act(async () => {
            useStore.getState().setView("settings");
        });
        await act(async () => {
            fireEvent.click(screen.getAllByLabelText(/^Stop watching /)[0]!);
        });
        expect(remove).not.toHaveBeenCalled();
        expect(screen.getByText(/images from the library\? The files stay on disk/)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Remove" }));
        });
        expect(remove).toHaveBeenCalledTimes(1);
    });
});

describe("Turkish interface", () => {
    const KEYS = new Set<string>(Object.keys(en));

    /** Every visible string on screen: text nodes plus the attributes a screen
     *  reader or a tooltip shows. */
    function visibleStrings(): string[]{
        const out: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for(let n = walker.nextNode(); n !== null; n = walker.nextNode()){
            out.push((n.textContent ?? "").trim());
        }
        for(const el of Array.from(document.body.querySelectorAll("[aria-label],[title],[placeholder]"))){
            for(const a of ["aria-label", "title", "placeholder"]){
                const v = el.getAttribute(a);
                if(v !== null){
                    out.push(v.trim());
                }
            }
        }
        return out.filter((s) => s !== "");
    }

    it("shows no raw key name anywhere, and says so in the page language", async () => {
        await mountApp();
        await act(async () => {
            useStore.getState().setLanguage("tr");
        });
        expect(document.documentElement.getAttribute("lang")).toBe("tr");
        const leaks = new Set(visibleStrings().filter((s) => KEYS.has(s)));
        expect([...leaks]).toEqual([]);

        // The library actually speaks Turkish, not English with Turkish settings.
        expect(screen.getByText("KİTAPLIK")).toBeTruthy();

        await act(async () => {
            useStore.getState().setView("settings");
        });
        for(const section of [
            "settings.section.folders", "settings.section.model", "settings.section.ocr",
            "settings.section.search", "settings.section.order", "settings.section.appearance",
            "settings.section.accessibility", "settings.section.gestures",
            "settings.section.shortcuts", "settings.section.storage",
        ] as const){
            await act(async () => {
                fireEvent.click(screen.getByRole("button", { name: tr[section] as string }));
            });
            const bad = visibleStrings().filter((s) => KEYS.has(s));
            expect({ section, bad }).toEqual({ section, bad: [] });
        }
        await act(async () => {
            useStore.getState().setLanguage("en");
        });
    });
});
