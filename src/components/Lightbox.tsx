import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import type { Photo } from "../lib/types";

const MAX_W = 1100;
const MAX_H = 720;

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Per wheel notch. Multiplicative, so zooming in and back out returns exactly
 *  to fit rather than drifting. */
const ZOOM_STEP = 1.15;

interface Point{
    x: number;
    y: number;
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
    const addToCollection = useStore((s) => s.addSelectionToCollection);
    const toggleSelect = useStore((s) => s.toggleSelect);
    const showToast = useStore((s) => s.showToast);

    const photo = index === null ? undefined : props.flat[index];
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
    const [collectionsOpen, setCollectionsOpen] = useState(false);

    // Zoom is transient view state, not app state: it belongs to the image on
    // screen and is meaningless the moment a different one is shown.
    const [scale, setScale] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    /** Animate the transform only when something other than the hand moved it.
     *  A wheel notch that eases into place lags the cursor it is anchored to. */
    const [smooth, setSmooth] = useState(false);
    const stageRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

    const resetZoom = useCallback(() => {
        setSmooth(true);
        setScale(1);
        setOffset({ x: 0, y: 0 });
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
    const clampOffset = useCallback((o: Point, s: number): Point => {
        const stage = stageRef.current;
        const img = imgRef.current;
        if(stage === null || img === null){
            return o;
        }
        // `offsetWidth` is the laid-out size and ignores the transform, so this
        // is the fitted size the scale multiplies.
        const maxX = Math.max(0, (img.offsetWidth * s - stage.clientWidth) / 2);
        const maxY = Math.max(0, (img.offsetHeight * s - stage.clientHeight) / 2);
        return {
            x: Math.min(maxX, Math.max(-maxX, o.x)),
            y: Math.min(maxY, Math.max(-maxY, o.y)),
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
            const target = imgRef.current ?? stage;
            const box = (target as HTMLElement).getBoundingClientRect();
            if(e.clientX < box.left || e.clientX > box.right
                || e.clientY < box.top || e.clientY > box.bottom){
                return;
            }
            e.preventDefault();
            const rect = (stage as HTMLDivElement).getBoundingClientRect();
            // Cursor relative to the stage centre, which is where the image is
            // anchored — so the maths matches the transform below.
            const cx = e.clientX - rect.left - rect.width / 2;
            const cy = e.clientY - rect.top - rect.height / 2;

            setSmooth(false);
            setScale((prev) => {
                const next = Math.min(
                    MAX_SCALE,
                    Math.max(MIN_SCALE, e.deltaY < 0 ? prev * ZOOM_STEP : prev / ZOOM_STEP),
                );
                setOffset((o) => {
                    if(next <= MIN_SCALE){
                        return { x: 0, y: 0 };   // fit again: recentre exactly
                    }
                    // Keep whatever pixel is under the cursor under the cursor.
                    return clampOffset({
                        x: cx - (cx - o.x) * (next / prev),
                        y: cy - (cy - o.y) * (next / prev),
                    }, next);
                });
                return next;
            });
        }
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => stage.removeEventListener("wheel", onWheel);
    }, [index, clampOffset]);

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
    const zoomed = scale > MIN_SCALE;
    // Fullscreen is image only: no header, no strip, no arrows.
    const chrome = !fullscreen;

    function onPointerDown(e: React.PointerEvent){
        if(!zoomed){
            return;
        }
        setSmooth(false);
        drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        e.currentTarget.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: React.PointerEvent){
        const d = drag.current;
        if(d === null){
            return;
        }
        setOffset(clampOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }, scale));
    }

    function onPointerUp(){
        drag.current = null;
    }

    async function putInCollection(id: string){
        setCollectionsOpen(false);
        // The collection actions work on the selection, so make this photo it.
        useStore.setState({ selectedIds: new Set([photo!.id]) });
        await addToCollection(id);
    }

    return (
        <div className="fixed inset-0 z-[100] flex flex-col bg-black/[0.97]">
            {chrome ? (
                <div className="flex flex-shrink-0 items-center justify-between px-5 py-4">
                    <button
                        type="button"
                        onClick={close}
                        aria-label="Close"
                        className="cursor-pointer text-[18px] text-white opacity-85 hover:opacity-100"
                    >
                        ✕
                    </button>
                    <div className="flex items-center gap-4">
                        {zoomed ? (
                            <button
                                type="button"
                                onClick={resetZoom}
                                className="cursor-pointer rounded bg-white/10 px-2 py-[3px] text-[11px] tabular-nums text-white/70 hover:text-white"
                            >
                                {Math.round(scale * 100)}% · reset
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={toggleFullscreen}
                            title="Fullscreen (F)"
                            aria-label="Fullscreen"
                            className="cursor-pointer text-[14px] text-white/60 hover:text-white"
                        >
                            ⛶
                        </button>
                        <span className="text-[12.5px] tabular-nums text-white/60">
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
                        className="flex-shrink-0 cursor-pointer p-[10px] text-[26px] text-white opacity-70 hover:opacity-100"
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
                    onDoubleClick={resetZoom}
                    className="flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden"
                    style={{ cursor: zoomed ? (drag.current ? "grabbing" : "grab") : "default" }}
                >
                    {full !== null ? (
                        <img
                            ref={imgRef}
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
                                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                                // Only a reset animates. Easing a wheel notch or
                                // a pan makes the image trail the hand that is
                                // steering it, which reads as lag, not polish.
                                transition: smooth ? "transform 140ms ease-out" : "none",
                            }}
                        />
                    ) : (
                        <div
                            className="flex items-center justify-center rounded"
                            style={{
                                width: previewW,
                                height: previewH,
                                maxWidth: "100%",
                                maxHeight: "100%",
                                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                                background:
                                    "repeating-linear-gradient(135deg,#26262a,#26262a 14px,#1c1c1f 14px,#1c1c1f 28px)",
                            }}
                        >
                            <span className="font-mono text-[12px] text-white/35">
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
                        className="flex-shrink-0 cursor-pointer p-[10px] text-[26px] text-white opacity-70 hover:opacity-100"
                    >
                        ▶
                    </button>
                ) : null}
            </div>

            {chrome && stripVisible ? (
                <div className="flex-shrink-0 bg-gradient-to-t from-black/60 to-transparent px-6 pt-[14px] pb-5">
                    <div className="mb-2 flex items-center justify-between gap-4">
                        <div
                            data-selectable
                            className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12.5px] text-white/85"
                        >
                            {photo.filename} · {natural?.w ?? photo.width}×{natural?.h ?? photo.height} ·{" "}
                            {fmtDate(photo.takenAt)} · {photo.folder}
                        </div>
                        <button
                            type="button"
                            onClick={toggleStrip}
                            className="flex-shrink-0 cursor-pointer text-[11px] text-white/50 hover:text-white/80"
                        >
                            Hide ▾
                        </button>
                    </div>

                    {photo.hasOcr && photo.ocrText !== null ? (
                        <button
                            type="button"
                            onClick={toggleOcr}
                            title="Click to expand"
                            className="mb-3 block max-w-[720px] cursor-pointer overflow-hidden text-left font-mono text-[12px] text-ellipsis text-white/55 hover:text-white/75"
                            style={{ whiteSpace: ocrExpanded ? "normal" : "nowrap" }}
                        >
                            OCR: "{photo.ocrText}"
                        </button>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void findSimilar(photo)}
                            className="cursor-pointer rounded-lg border-none bg-accent px-4 py-[9px] text-[12.5px] font-semibold text-white hover:opacity-90"
                        >
                            Find similar
                        </button>
                        <GhostAction
                            label="Open"
                            onClick={() => {
                                void api.openExternally(photo.id);
                                showToast("Opening in default viewer…");
                            }}
                        />
                        <GhostAction
                            label="Reveal in files"
                            onClick={() => {
                                void api.revealInFiles([photo.id]);
                                showToast("Revealing in file manager…");
                            }}
                        />
                        <div className="relative">
                            <GhostAction
                                label={`Add to collection ${collectionsOpen ? "▾" : "▴"}`}
                                onClick={() => setCollectionsOpen((v) => !v)}
                            />
                            {collectionsOpen ? (
                                <div className="absolute bottom-full left-0 z-10 mb-2 min-w-[170px] rounded-lg border border-white/15 bg-[#1c1c1f] p-1">
                                    {collections.length === 0 ? (
                                        <div className="px-2 py-[6px] text-[12px] text-white/40">
                                            No collections yet
                                        </div>
                                    ) : null}
                                    {collections.map((c) => (
                                        <button
                                            key={c.id}
                                            type="button"
                                            onClick={() => void putInCollection(c.id)}
                                            className="w-full cursor-pointer overflow-hidden rounded px-2 py-[6px] text-left text-[12.5px] text-ellipsis whitespace-nowrap text-white/75 hover:bg-white/10 hover:text-white"
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
                            className="cursor-pointer text-[11.5px] text-white/40 hover:text-white/70"
                        >
                            Select
                        </button>
                    </div>
                </div>
            ) : null}

            {chrome && !stripVisible ? (
                <button
                    type="button"
                    onClick={toggleStrip}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 cursor-pointer rounded-md bg-white/10 px-3 py-[6px] text-[11px] text-white/50 hover:text-white/80"
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
            className="cursor-pointer rounded-lg border border-white/20 bg-white/[0.06] px-4 py-[9px] text-[12.5px] text-white hover:bg-white/10"
        >
            {props.label}
        </button>
    );
}
