import { useCallback, useEffect, useRef, useState } from "react";
import { GRID_GAP } from "./catalog";
import { itemAt, itemsAlongSegment, rangeIds, type Point } from "./gridHit";
import { useStore } from "./store";
import { startFileDrag } from "./tauri";
import type { GridLayoutHandle } from "./useGridLayout";
import type { Photo } from "./types";

/** Movement past this many pixels means "drag", not "click". Below it a shaky
 *  hand still opens the lightbox. */
const DRAG_SLOP = 5;
/** Hold this long on a photo and it selects instead of opening. */
const LONG_PRESS_MS = 400;
/** Auto-scroll band at the top and bottom edge of the viewport. */
const EDGE = 48;
const EDGE_SPEED = 18;

/**
 * What a drag turned into, decided once at the moment the pointer passes
 * `DRAG_SLOP` and never revisited — a gesture that changed meaning halfway
 * through would select photos the hand had already left behind.
 */
type Mode = "none" | "paint" | "range" | "dragOut";

export interface GridGesture{
    canvasRef: React.RefObject<HTMLDivElement | null>;
    /** True while a paint sweep or a range drag is live, for the cursor. */
    sweeping: boolean;
    onPointerDown(e: React.PointerEvent): void;
}

function isTauriHost(): boolean{
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Both spellings, on purpose. `tauri dev` serves the stylesheet unprefixed to
 * WebKitGTK, which ignores the unprefixed property — so the CSS guard on #root
 * is not in force in the build the app is actually developed in.
 */
function suppressSelection(on: boolean){
    const style = document.body.style;
    for(const prop of ["user-select", "-webkit-user-select"]){
        if(on){
            style.setProperty(prop, "none");
        }else{
            style.removeProperty(prop);
        }
    }
}

/** A selection that started before the guard went up stays painted otherwise. */
function dropSelection(){
    if(typeof window.getSelection !== "function"){
        return;
    }
    window.getSelection()?.removeAllRanges();
}

/**
 * The last line of defence, engine-independent: a sweep across the grid must
 * never start a text selection over the checkmarks, the TEXT badges or the
 * month headers. Only the lightbox's OCR panel and real inputs opt back in.
 */
function onSelectStart(e: Event){
    const target = e.target as HTMLElement | null;
    if(target?.closest?.("input,textarea,[data-selectable]") != null){
        return;
    }
    e.preventDefault();
}

/**
 * One state machine for every gesture that starts with a press on the grid.
 *
 * | gesture | outcome |
 * |---|---|
 * | press, release under 5px | open the lightbox (the cell's own `onClick`) |
 * | press, hold 400ms | select that one photo — keep moving and it sweeps on |
 * | drag from an unselected photo | paint: select everything swept |
 * | Ctrl + drag | paint in reverse: deselect everything swept |
 * | Shift + press or drag | select the range from the anchor to here |
 * | drag from a *selected* photo | carry the selection: onto a collection, or out to the OS |
 *
 * They must be decided in one place. Split across the cell and the container,
 * the hold and the click both fire and the photo is selected *and* opened; that
 * is why anything but a plain click swallows the click the browser synthesises
 * on release.
 */
export function useGridGesture(grid: GridLayoutHandle): GridGesture{
    const canvasRef = useRef<HTMLDivElement>(null);
    const [sweeping, setSweeping] = useState(false);

    // Everything the drag needs lives in refs: the window listeners are bound
    // once and must not see a stale closure mid-gesture.
    const armed = useRef(false);
    const mode = useRef<Mode>("none");
    const origin = useRef<Point>({ x: 0, y: 0 });
    const last = useRef<Point>({ x: 0, y: 0 });
    const client = useRef<Point>({ x: 0, y: 0 });
    const originPhoto = useRef<Photo | null>(null);
    const paintMode = useRef<"add" | "remove">("add");
    /** Selection as it stood when a Shift drag began. A range must shrink as
     *  well as grow, so each move rebuilds base ∪ range rather than adding. */
    const base = useRef<number[]>([]);
    const dragIds = useRef<number[]>([]);
    const osDragStarted = useRef(false);
    const held = useRef(false);
    /** Which way a sweep that grows out of a fired hold paints. Decided by what
     *  the hold itself did, so a hold that deselected does not re-add. */
    const heldMode = useRef<"add" | "remove">("add");
    const timer = useRef<number | null>(null);
    const raf = useRef<number | null>(null);

    const layoutRef = useRef(grid.layout);
    layoutRef.current = grid.layout;

    /** Client point → content point. Read fresh every time: the canvas moves
     *  under the pointer while the sweep auto-scrolls. */
    const toContent = useCallback((cx: number, cy: number): Point | null => {
        const canvas = canvasRef.current;
        if(canvas === null){
            return null;
        }
        const r = canvas.getBoundingClientRect();
        return { x: cx - r.left, y: cy - r.top };
    }, []);

    const finish = useCallback(() => {
        if(timer.current !== null){
            window.clearTimeout(timer.current);
            timer.current = null;
        }
        if(raf.current !== null){
            cancelAnimationFrame(raf.current);
            raf.current = null;
        }
        armed.current = false;
        mode.current = "none";
        held.current = false;
        osDragStarted.current = false;
        setSweeping(false);
        useStore.getState().endDragOut();
        suppressSelection(false);
    }, []);

    /** Eat the click the browser fires after anything that was not a plain
     *  click, so the release does not also open the lightbox or toggle a cell
     *  on top of what the gesture just did. */
    const swallowClick = useCallback(() => {
        const el = grid.scrollRef.current;
        if(el === null){
            return;
        }
        function stop(e: MouseEvent){
            e.stopPropagation();
            e.preventDefault();
        }
        el.addEventListener("click", stop, { capture: true, once: true });
        // If no click follows — released outside, or the pointer was cancelled —
        // the listener would sit there and eat an unrelated click later.
        window.setTimeout(() => {
            el.removeEventListener("click", stop, { capture: true });
        }, 300);
    }, [grid.scrollRef]);

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            if(e.button !== 0 || grid.mode === "loading" || canvasRef.current === null){
                return;
            }
            // The scrollbar is inside the scroll container and fires pointerdown
            // like anything else — without this, dragging it paints.
            const el = grid.scrollRef.current;
            if(el !== null && e.clientX - el.getBoundingClientRect().left >= el.clientWidth){
                return;
            }
            const point = toContent(e.clientX, e.clientY);
            if(point === null){
                return;
            }

            const s = useStore.getState();
            const photo = itemAt(layoutRef.current.blocks, point.x, point.y, GRID_GAP);
            origin.current = point;
            last.current = point;
            client.current = { x: e.clientX, y: e.clientY };
            originPhoto.current = photo;
            armed.current = true;
            mode.current = "none";
            held.current = false;
            base.current = [...s.selectedIds];

            if(photo !== null && e.shiftKey){
                // Shift+click is a range on its own, before any movement — the
                // drag that may follow only extends it.
                mode.current = "range";
                s.setSelection(unique([
                    ...base.current,
                    ...rangeIds(layoutRef.current.flat, s.anchorId, photo.id),
                ]));
                // Same housekeeping `begin` does, because this entry point
                // skips it: without it a Shift drag paints the browser's own
                // text selection over the month headers.
                suppressSelection(true);
                dropSelection();
                setSweeping(true);
                swallowClick();
                return;
            }

            if(photo !== null){
                timer.current = window.setTimeout(() => {
                    timer.current = null;
                    held.current = true;
                    // Stays armed: a hold that keeps moving flows straight into
                    // a sweep. Disarming here made the hold a dead end — the
                    // hand was already down and going somewhere, and nothing
                    // happened for the rest of the gesture.
                    const store = useStore.getState();
                    heldMode.current = store.selectedIds.has(photo.id) ? "remove" : "add";
                    store.toggleSelect(photo.id);
                }, LONG_PRESS_MS);
            }
        },
        [grid.mode, grid.scrollRef, swallowClick, toContent],
    );

    // Bound once. Pointermove/up go on the window so a drag that leaves the
    // grid — auto-scroll, or a drag towards the sidebar — keeps tracking.
    useEffect(() => {
        function begin(e: PointerEvent){
            if(timer.current !== null){
                window.clearTimeout(timer.current);
                timer.current = null;
            }
            const s = useStore.getState();
            const photo = originPhoto.current;

            if(held.current){
                // The hold already committed: it selected (or deselected) the
                // photo under the finger, so the drag continues that, and never
                // becomes a drag-out of the thing it just marked.
                mode.current = "paint";
                paintMode.current = heldMode.current;
            }else if(e.shiftKey && photo !== null){
                mode.current = "range";
            }else if(e.ctrlKey || e.metaKey){
                // Ctrl is checked before the drag-out branch on purpose: an
                // erase sweep starts on a photo that is by definition selected,
                // so the other order makes it unreachable.
                mode.current = "paint";
                paintMode.current = "remove";
                if(photo !== null){
                    s.paintSelection([photo.id], "remove");
                }
            }else if(photo !== null && s.selectedIds.has(photo.id)){
                // Dragging something already selected carries it, the way every
                // file manager does. Painting from it would make the selection
                // impossible to drag anywhere.
                mode.current = "dragOut";
                dragIds.current = [...s.selectedIds];
                s.startDragOut(dragIds.current.length);
            }else{
                mode.current = "paint";
                paintMode.current = "add";
                if(photo !== null){
                    s.paintSelection([photo.id], "add");
                    s.setAnchor(photo.id);
                }
            }
            // Without this the sweep paints the browser's own text selection
            // over the month headers.
            suppressSelection(true);
            dropSelection();
            setSweeping(mode.current !== "dragOut");
            startEdgeScroll();
        }

        function apply(point: Point){
            const s = useStore.getState();
            if(mode.current === "paint"){
                const swept = itemsAlongSegment(
                    layoutRef.current.blocks, last.current, point, GRID_GAP,
                );
                if(swept.length > 0){
                    s.paintSelection(swept.map((p) => p.id), paintMode.current);
                    s.setAnchor(swept[swept.length - 1]!.id);
                }
            }else if(mode.current === "range"){
                const photo = itemAt(layoutRef.current.blocks, point.x, point.y, GRID_GAP);
                if(photo !== null){
                    s.setSelection(unique([
                        ...base.current,
                        ...rangeIds(layoutRef.current.flat, s.anchorId, photo.id),
                    ]));
                }
            }
            last.current = point;
        }

        function trackDragOut(){
            const s = useStore.getState();
            const { x, y } = client.current;
            // jsdom has no hit testing at all; there the in-app drop target is
            // simply never found, which is the honest answer for a layout that
            // does not exist.
            const el = typeof document.elementFromPoint === "function"
                ? document.elementFromPoint(x, y)
                : null;
            const row = el === null ? null : el.closest("[data-collection-id]");
            s.setDragOverCollection(row?.getAttribute("data-collection-id") ?? null);

            // Past the window edge the drop belongs to the OS, not to us. The
            // handoff happens exactly once: the plugin owns the pointer from
            // there on and a second call would start a competing drag.
            const outside = x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;
            if(outside && !osDragStarted.current && isTauriHost()){
                osDragStarted.current = true;
                const byId = new Map(layoutRef.current.flat.map((p) => [p.id, p.path]));
                const paths = dragIds.current
                    .map((id) => byId.get(id))
                    .filter((p): p is string => typeof p === "string");
                void startFileDrag(paths);
            }
        }

        function onMove(e: PointerEvent){
            if(!armed.current && mode.current === "none"){
                return;
            }
            client.current = { x: e.clientX, y: e.clientY };
            const point = toContent(e.clientX, e.clientY);
            if(point === null){
                return;
            }
            if(mode.current === "none"){
                const d = Math.hypot(point.x - origin.current.x, point.y - origin.current.y);
                if(d < DRAG_SLOP){
                    return;
                }
                begin(e);
                last.current = origin.current;
            }
            e.preventDefault();
            if(mode.current === "dragOut"){
                trackDragOut();
                return;
            }
            // A Shift range starts at pointerdown, before `begin` ever runs, so
            // the edge-scroll loop is started here rather than there.
            startEdgeScroll();
            apply(point);
        }

        function startEdgeScroll(){
            if(raf.current !== null){
                return;
            }
            const tick = () => {
                raf.current = null;
                if(mode.current === "none"){
                    return;
                }
                const el = grid.scrollRef.current;
                if(el !== null && mode.current !== "dragOut"){
                    const r = el.getBoundingClientRect();
                    const y = client.current.y;
                    const before = el.scrollTop;
                    if(y < r.top + EDGE){
                        el.scrollTop -= EDGE_SPEED;
                    }else if(y > r.bottom - EDGE){
                        el.scrollTop += EDGE_SPEED;
                    }
                    if(el.scrollTop !== before){
                        // The canvas moved under a stationary pointer, so the
                        // content point changed even though no move fired.
                        const point = toContent(client.current.x, client.current.y);
                        if(point !== null){
                            apply(point);
                        }
                    }
                }
                raf.current = requestAnimationFrame(tick);
            };
            raf.current = requestAnimationFrame(tick);
        }

        function onUp(){
            const s = useStore.getState();
            if(mode.current === "dragOut"){
                const target = s.dragOut.overCollection;
                if(target !== null){
                    void s.addPhotosToCollection(target, dragIds.current);
                }
                swallowClick();
            }else if(mode.current !== "none" || held.current){
                swallowClick();
            }else if(armed.current && originPhoto.current === null && s.selectedIds.size > 0){
                // A click on the background is an empty selection.
                s.clearSelection();
            }
            finish();
        }

        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        document.addEventListener("selectstart", onSelectStart);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            document.removeEventListener("selectstart", onSelectStart);
            finish();
        };
    }, [finish, grid.scrollRef, swallowClick, toContent]);

    return { canvasRef, sweeping, onPointerDown };
}

function unique(ids: number[]): number[]{
    return [...new Set(ids)];
}
