import { memo, useCallback, useEffect, useRef, useState } from "react";
import { describeError, useStore } from "../lib/store";
import { api } from "../lib/api";
import { dateVerb, fmtDateTime } from "../lib/format";
import type { Photo } from "../lib/types";

const MAX_W = 1100;
const MAX_H = 720;

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Per wheel notch. Multiplicative, so zooming in and back out returns exactly
 *  to fit rather than drifting. */
const ZOOM_STEP = 1.15;
/** A pixel-mode delta at least this big is a mouse notch, not a trackpad. */
const NOTCH_PX = 50;
/** Trackpad only: `exp(-delta * ZOOM_K)`, so a swipe's stream of small deltas
 *  adds up to about one notch rather than multiplying by a full step thirty
 *  times a second. */
const ZOOM_K = 0.0014;
/** No single event may do more than this, whatever the driver reports. */
const MAX_STEP = 1.6;
/** Keyboard `+` / `-`. Coarser than a wheel notch: it is one keypress. */
const KEY_STEP = 1.4;
/** Double-click on a fitted photo goes straight here. */
const DBL_SCALE = 2.5;

/** Scale and pan move together. Keeping them in one value is what lets the
 *  cursor-anchored maths run in a single pure updater — computing the offset
 *  inside the scale updater ran it twice under a double-invoked render, and
 *  the offset step compounds. */
interface View{
    /** Multiple of the fitted size. 1 means "fills the stage". */
    s: number;
    x: number;
    y: number;
}

function clamp(v: number, lo: number, hi: number): number{
    return Math.min(hi, Math.max(lo, v));
}

/**
 * How much one wheel event zooms.
 *
 * Line mode *means* notches: WebKitGTK — the webview Tauri uses on Linux —
 * reports deltaMode 1 with a deltaY of 1–3 per notch, where Chrome reports
 * ~100 pixels. Scaling by the raw number there would make a notch worth a
 * fiftieth of the same notch in Chrome. So a notch is a notch on both, and
 * only the trackpad's stream of small pixel deltas is treated as continuous.
 */
function wheelFactor(e: WheelEvent): number{
    if(e.deltaMode !== 0 || Math.abs(e.deltaY) >= NOTCH_PX){
        return e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    }
    return clamp(Math.exp(-e.deltaY * ZOOM_K), 1 / MAX_STEP, MAX_STEP);
}

/** Everything that is not the backdrop. A press on one of these is aimed at
 *  something, so it must not be read as "clicked away from the photo". */
function isHeld(t: EventTarget | null): boolean{
    const el = t as HTMLElement | null;
    return el?.closest?.("button, a, input, textarea, [data-lb-keep]") != null;
}

/** Memoised: `App` owns the grid's scroll position, so it re-renders on
 *  every scroll frame, and `flat` only changes when the layout does. */
export const Lightbox = memo(function Lightbox(props: { flat: Photo[] }){
    const index = useStore((s) => s.lightboxIndex);
    const stripVisible = useStore((s) => s.lightboxStripVisible);
    const fullscreen = useStore((s) => s.lightboxFullscreen);
    const ocrExpanded = useStore((s) => s.ocrExpanded);
    const close = useStore((s) => s.closeLightbox);
    const step = useStore((s) => s.stepLightbox);
    const toggleStrip = useStore((s) => s.toggleLightboxStrip);
    const toggleFullscreen = useStore((s) => s.toggleLightboxFullscreen);
    const toggleOcr = useStore((s) => s.toggleOcrExpanded);
    const findSimilar = useStore((s) => s.findSimilar);
    const collections = useStore((s) => s.collections);
    const addPhotosToCollection = useStore((s) => s.addPhotosToCollection);
    const toggleSelect = useStore((s) => s.toggleSelect);
    const showToast = useStore((s) => s.showToast);

    const photo = index === null ? undefined : props.flat[index];
    const isSelected = useStore((s) => photo !== undefined && s.selectedIds.has(photo.id));
    const open = photo !== undefined;
    const rootRef = useRef<HTMLDivElement>(null);
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
    const [collectionsOpen, setCollectionsOpen] = useState(false);

    // Zoom is transient view state, not app state: it belongs to the image on
    // screen and is meaningless the moment a different one is shown.
    const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
    /** Animate the transform only when something other than the hand moved it.
     *  A wheel notch that eases into place lags the cursor it is anchored to. */
    const [smooth, setSmooth] = useState(false);
    /** State, not a ref: the cursor is rendered from it, and a ref mutation
     *  renders nothing — which is why `grabbing` never once appeared. */
    const [panning, setPanning] = useState(false);
    const stageRef = useRef<HTMLDivElement>(null);
    /** The `<img>`, or the placeholder that stands in for it when there is no
     *  file URL. A callback ref because those are two element types and one
     *  object ref cannot type-check against both. */
    const pictureRef = useRef<HTMLElement | null>(null);
    const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
    /** Where the press that may become a backdrop click started. */
    const press = useRef<{ x: number; y: number; backdrop: boolean } | null>(null);

    const setPicture = useCallback((el: HTMLElement | null) => {
        pictureRef.current = el;
    }, []);

    const resetZoom = useCallback(() => {
        setSmooth(true);
        setView({ s: 1, x: 0, y: 0 });
    }, []);

    useEffect(() => {
        setNatural(null);
        setCollectionsOpen(false);
        resetZoom();
    }, [photo?.id, resetZoom]);

    /**
     * How far the image may be pushed before its edge would come inside the
     * stage. Past that the photo can be flicked off screen entirely and the
     * only way back is the reset button — which is not a zoom, it is a way to
     * lose the picture.
     */
    const clampView = useCallback((v: View): View => {
        const stage = stageRef.current;
        const pic = pictureRef.current;
        if(stage === null || pic === null || v.s <= MIN_SCALE){
            return { s: v.s, x: 0, y: 0 };   // fit again: recentre exactly
        }
        // `offsetWidth` is the laid-out size and ignores the transform, so this
        // is the fitted size the scale multiplies.
        const maxX = Math.max(0, (pic.offsetWidth * v.s - stage.clientWidth) / 2);
        const maxY = Math.max(0, (pic.offsetHeight * v.s - stage.clientHeight) / 2);
        return { s: v.s, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
    }, []);

    /** Zoom by `factor` about a point given relative to the stage centre, which
     *  is where the image is anchored. `(0, 0)` is therefore "about the middle",
     *  which is what the keyboard wants. */
    const zoomAt = useCallback((factor: number, cx: number, cy: number, animate = false) => {
        setSmooth(animate);
        setView((v) => {
            const s = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
            const r = s / v.s;
            // Keep whatever pixel is under the cursor under the cursor.
            return clampView({ s, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r });
        });
    }, [clampView]);

    /** The cursor, in stage-centre coordinates. */
    const anchorOf = useCallback((clientX: number, clientY: number) => {
        const rect = stageRef.current?.getBoundingClientRect();
        if(rect === undefined){
            return { cx: 0, cy: 0 };
        }
        return {
            cx: clientX - rect.left - rect.width / 2,
            cy: clientY - rect.top - rect.height / 2,
        };
    }, []);

    /**
     * Wheel zoom, anchored on the cursor.
     *
     * Registered non-passively on the element: React's `onWheel` is passive, so
     * `preventDefault` there is ignored and the page scrolls behind the zoom.
     *
     * `index` is a dependency and must stay one. The component renders `null`
     * while the lightbox is closed, so at mount — which is app start, since App
     * always renders this — `stageRef` is empty and the effect bails. With an
     * empty dependency array it never runs again, and wheel zoom is dead for
     * the whole session: the listener is attached to a stage that did not exist
     * yet.
     */
    useEffect(() => {
        const stage = stageRef.current;
        if(stage === null){
            return;
        }
        function onWheel(e: WheelEvent){
            // The stage is the whole band between the arrows, most of which is
            // empty backdrop. Zooming from out there moves a photo the cursor
            // is nowhere near, which is what makes it feel arbitrary — so the
            // gesture only counts over the picture itself. The rect is the
            // *scaled* one, so the target grows as the photo does.
            const target = pictureRef.current ?? stage;
            const box = (target as HTMLElement).getBoundingClientRect();
            if(e.clientX < box.left || e.clientX > box.right
                || e.clientY < box.top || e.clientY > box.bottom){
                return;
            }
            e.preventDefault();
            const { cx, cy } = anchorOf(e.clientX, e.clientY);
            zoomAt(wheelFactor(e), cx, cy);
        }
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => stage.removeEventListener("wheel", onWheel);
    }, [index, anchorOf, zoomAt]);

    /** `+` / `-` / `0`, with or without the modifier. App's page-zoom guard
     *  swallows the modifier versions' default and then bows out while the
     *  lightbox is open, so both spellings arrive here. */
    useEffect(() => {
        if(index === null){
            return;
        }
        function onKey(e: KeyboardEvent){
            const tag = (e.target as HTMLElement | null)?.tagName ?? "";
            if(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"){
                return;
            }
            if(e.key === "+" || e.key === "="){
                zoomAt(KEY_STEP, 0, 0, true);
            }else if(e.key === "-" || e.key === "_"){
                zoomAt(1 / KEY_STEP, 0, 0, true);
            }else if(e.key === "0"){
                resetZoom();
            }else{
                return;
            }
            e.preventDefault();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [index, zoomAt, resetZoom]);

    /** The viewer is modal, so the app behind it must not be reachable: Tab
     *  would walk into the sidebar, and Enter on a button there would act on a
     *  screen nobody can see. Set by hand on the siblings — nothing here owns
     *  them — and undone by the same cleanup, or the whole app stays dead. */
    useEffect(() => {
        const root = rootRef.current;
        if(!open || root === null || root.parentElement === null){
            return;
        }
        const inerted = Array.from(root.parentElement.children).filter(
            (el) => el !== root && !el.hasAttribute("inert"),
        );
        inerted.forEach((el) => el.setAttribute("inert", ""));
        return () => inerted.forEach((el) => el.removeAttribute("inert"));
    }, [open]);

    /** A window that got smaller leaves the photo pushed further out than the
     *  new bounds allow, and the gap only closes on the next pan. */
    useEffect(() => {
        function onResize(){
            setSmooth(false);
            setView(clampView);
        }
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [clampView]);

    if(index === null || photo === undefined){
        return null;
    }

    const aspect = photo.height > 0 ? photo.width / photo.height : 1;
    let previewW = MAX_W;
    let previewH = MAX_W / aspect;
    if(previewH > MAX_H){
        previewH = MAX_H;
        previewW = MAX_H * aspect;
    }

    const full = api.fileUrl(photo.id);
    const zoomed = view.s > MIN_SCALE;
    // Fullscreen is image only: no header, no strip, no arrows.
    const chrome = !fullscreen;

    function onPointerDown(e: React.PointerEvent){
        if(!zoomed || e.button !== 0){
            return;
        }
        setSmooth(false);
        setPanning(true);
        drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
        e.currentTarget.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: React.PointerEvent){
        const d = drag.current;
        if(d === null){
            return;
        }
        setView((v) => clampView({
            s: v.s,
            x: d.ox + (e.clientX - d.x),
            y: d.oy + (e.clientY - d.y),
        }));
    }

    function onPointerUp(){
        drag.current = null;
        setPanning(false);
    }

    /** A fitted photo jumps to `DBL_SCALE` under the cursor; a zoomed one goes
     *  back to fit. Lives on the picture, not the stage — on the backdrop the
     *  first of the two clicks has already closed the lightbox. */
    function onPictureDoubleClick(e: React.MouseEvent){
        if(zoomed){
            resetZoom();
            return;
        }
        const { cx, cy } = anchorOf(e.clientX, e.clientY);
        zoomAt(DBL_SCALE, cx, cy, true);
    }

    function onRootPointerDown(e: React.PointerEvent){
        press.current = {
            x: e.clientX,
            y: e.clientY,
            backdrop: e.button === 0 && !isHeld(e.target),
        };
    }

    /**
     * Clicking away from the photo puts it away.
     *
     * Both ends of the click have to be on the backdrop: a pan that started on
     * the picture and released over the black would otherwise close the thing
     * the hand was steering. The travel check catches the other half of that —
     * a pan that started on the backdrop while zoomed is a drag, not a click.
     *
     * In fullscreen the backdrop is very nearly the whole screen, so this drops
     * one rung down the Esc ladder instead of closing outright, for the same
     * reason Esc does: a stray click must not lose the photo being looked at.
     */
    function onRootClick(e: React.MouseEvent){
        const p = press.current;
        press.current = null;
        if(p === null || !p.backdrop || isHeld(e.target)){
            return;
        }
        if(Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 4){
            return;
        }
        if(fullscreen){
            toggleFullscreen();
        }else{
            close();
        }
    }

    async function putInCollection(id: string){
        setCollectionsOpen(false);
        await addPhotosToCollection(id, [photo!.id]);
    }

    return (
        <div
            ref={rootRef}
            role="dialog"
            aria-modal="true"
            aria-label="Photo viewer"
            onPointerDown={onRootPointerDown}
            onClick={onRootClick}
            className="fixed inset-0 z-[100] flex flex-col bg-black/[0.97]"
        >
            {chrome ? (
                <div
                    data-lb-keep
                    className="flex flex-shrink-0 items-center justify-between px-5 py-4"
                >
                    <button
                        type="button"
                        onClick={close}
                        aria-label="Close"
                        className="cursor-pointer text-[calc(18px*var(--ui-scale))] text-white opacity-85 hover:opacity-100"
                    >
                        ✕
                    </button>
                    <div className="flex items-center gap-4">
                        {zoomed ? (
                            <button
                                type="button"
                                onClick={resetZoom}
                                className="cursor-pointer rounded bg-white/10 px-2 py-[calc(3px*var(--ui-scale))] text-[calc(11px*var(--ui-scale))] tabular-nums text-white/70 hover:text-white"
                            >
                                {Math.round(view.s * 100)}% · reset
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={toggleFullscreen}
                            title="Fullscreen (F)"
                            aria-label="Fullscreen"
                            className="cursor-pointer text-[calc(14px*var(--ui-scale))] text-white/60 hover:text-white"
                        >
                            ⛶
                        </button>
                        <span className="text-[calc(12.5px*var(--ui-scale))] tabular-nums text-white/60">
                            {index + 1} / {props.flat.length}
                        </span>
                    </div>
                </div>
            ) : null}

            <div className="flex min-h-0 flex-1 items-center justify-center gap-4 px-5">
                {chrome ? (
                    <button
                        type="button"
                        onClick={() => step(-1, props.flat.length)}
                        aria-label="Previous"
                        className="flex-shrink-0 cursor-pointer p-[calc(10px*var(--ui-scale))] text-[calc(26px*var(--ui-scale))] text-white opacity-70 hover:opacity-100"
                    >
                        ◀
                    </button>
                ) : null}

                <div
                    ref={stageRef}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    className="flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden"
                    style={{
                        cursor: zoomed ? (panning ? "grabbing" : "grab") : "default",
                        // Pointer-driven pan: left to the browser, a touch drag
                        // would be taken as a scroll and cancel it.
                        touchAction: "none",
                    }}
                >
                    {full !== null ? (
                        <img
                            ref={setPicture}
                            data-lb-keep
                            onDoubleClick={onPictureDoubleClick}
                            src={full}
                            alt={photo.filename}
                            onLoad={(e) =>
                                setNatural({
                                    w: e.currentTarget.naturalWidth,
                                    h: e.currentTarget.naturalHeight,
                                })
                            }
                            draggable={false}
                            className="max-h-full max-w-full rounded object-contain"
                            style={{
                                transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
                                // Only a reset animates. Easing a wheel notch or
                                // a pan makes the image trail the hand that is
                                // steering it, which reads as lag, not polish.
                                transition: smooth ? "transform 140ms ease-out" : "none",
                            }}
                        />
                    ) : (
                        <div
                            ref={setPicture}
                            data-lb-keep
                            onDoubleClick={onPictureDoubleClick}
                            className="flex items-center justify-center rounded"
                            style={{
                                width: previewW,
                                height: previewH,
                                maxWidth: "100%",
                                maxHeight: "100%",
                                transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
                                background:
                                    "repeating-linear-gradient(135deg,#26262a,#26262a 14px,#1c1c1f 14px,#1c1c1f 28px)",
                            }}
                        >
                            <span className="font-mono text-[calc(12px*var(--ui-scale))] text-white/35">
                                {photo.width}×{photo.height}
                            </span>
                        </div>
                    )}
                </div>

                {chrome ? (
                    <button
                        type="button"
                        onClick={() => step(1, props.flat.length)}
                        aria-label="Next"
                        className="flex-shrink-0 cursor-pointer p-[calc(10px*var(--ui-scale))] text-[calc(26px*var(--ui-scale))] text-white opacity-70 hover:opacity-100"
                    >
                        ▶
                    </button>
                ) : null}
            </div>

            {chrome && stripVisible ? (
                <div
                    data-lb-keep
                    className="flex-shrink-0 bg-gradient-to-t from-black/60 to-transparent px-6 pt-[calc(14px*var(--ui-scale))] pb-5"
                >
                    <div className="mb-2 flex items-center justify-between gap-4">
                        <div
                            data-selectable
                            className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[calc(12.5px*var(--ui-scale))] text-white/85"
                        >
                            {photo.filename} · {natural?.w ?? photo.width}×{natural?.h ?? photo.height} ·{" "}
                            <span title={photo.dateSource === "mtime" ? "No capture date in the file — this is when it was last modified" : undefined}>
                                {photo.takenAt === null ? "Undated" : `${dateVerb(photo.dateSource)} ${fmtDateTime(photo.takenAt)}`}
                            </span>{" "}
                            · {photo.folder}
                        </div>
                        <button
                            type="button"
                            onClick={toggleStrip}
                            className="flex-shrink-0 cursor-pointer text-[calc(11px*var(--ui-scale))] text-white/50 hover:text-white/80"
                        >
                            Hide ▾
                        </button>
                    </div>

                    {photo.hasOcr && photo.ocrText !== null ? (
                        <button
                            type="button"
                            onClick={toggleOcr}
                            title="Click to expand"
                            className="mb-3 block max-w-[calc(720px*var(--ui-scale))] cursor-pointer overflow-hidden text-left font-mono text-[calc(12px*var(--ui-scale))] text-ellipsis text-white/55 hover:text-white/75"
                            style={{ whiteSpace: ocrExpanded ? "normal" : "nowrap" }}
                        >
                            OCR: "{photo.ocrText}"
                        </button>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void findSimilar(photo)}
                            className="cursor-pointer rounded-lg border-none bg-accent px-4 py-[calc(9px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] font-semibold text-white hover:opacity-90"
                        >
                            Find similar
                        </button>
                        <GhostAction
                            label="Open"
                            onClick={() => {
                                api.openExternally(photo.id).then(
                                    () => showToast("Opening in default viewer…"),
                                    (err: unknown) => showToast(describeError(err)),
                                );
                            }}
                        />
                        <GhostAction
                            label="Reveal in files"
                            onClick={() => {
                                api.revealInFiles([photo.id]).then(
                                    () => showToast("Revealing in file manager…"),
                                    (err: unknown) => showToast(describeError(err)),
                                );
                            }}
                        />
                        <div className="relative">
                            <GhostAction
                                label={`Add to collection ${collectionsOpen ? "▾" : "▴"}`}
                                onClick={() => setCollectionsOpen((v) => !v)}
                            />
                            {collectionsOpen ? (
                                <div className="absolute bottom-full left-0 z-10 mb-2 min-w-[calc(170px*var(--ui-scale))] rounded-lg border border-white/15 bg-[#1c1c1f] p-1">
                                    {collections.length === 0 ? (
                                        <div className="px-2 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-white/40">
                                            No collections yet
                                        </div>
                                    ) : null}
                                    {collections.map((c) => (
                                        <button
                                            key={c.id}
                                            type="button"
                                            onClick={() => void putInCollection(c.id)}
                                            className="w-full cursor-pointer overflow-hidden rounded px-2 py-[calc(6px*var(--ui-scale))] text-left text-[calc(12.5px*var(--ui-scale))] text-ellipsis whitespace-nowrap text-white/75 hover:bg-white/10 hover:text-white"
                                        >
                                            {c.name}
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                        <button
                            type="button"
                            onClick={() => toggleSelect(photo.id)}
                            className="cursor-pointer text-[calc(11.5px*var(--ui-scale))] text-white/40 hover:text-white/70"
                        >
                            {isSelected ? "Deselect" : "Select"}
                        </button>
                    </div>
                </div>
            ) : null}

            {chrome && !stripVisible ? (
                <button
                    type="button"
                    onClick={toggleStrip}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 cursor-pointer rounded-md bg-white/10 px-3 py-[calc(6px*var(--ui-scale))] text-[calc(11px*var(--ui-scale))] text-white/50 hover:text-white/80"
                >
                    Show info ▴
                </button>
            ) : null}
        </div>
    );
});

function GhostAction(props: { label: string; onClick: () => void }){
    return (
        <button
            type="button"
            onClick={props.onClick}
            className="cursor-pointer rounded-lg border border-white/20 bg-white/[0.06] px-4 py-[calc(9px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-white hover:bg-white/10"
        >
            {props.label}
        </button>
    );
}
