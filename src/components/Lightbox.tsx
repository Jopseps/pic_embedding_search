import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import type { Photo } from "../lib/types";

const MAX_W = 1100;
const MAX_H = 720;

export function Lightbox(props: { flat: Photo[] }){
    const index = useStore((s) => s.lightboxIndex);
    const stripVisible = useStore((s) => s.lightboxStripVisible);
    const ocrExpanded = useStore((s) => s.ocrExpanded);
    const close = useStore((s) => s.closeLightbox);
    const step = useStore((s) => s.stepLightbox);
    const toggleStrip = useStore((s) => s.toggleLightboxStrip);
    const toggleOcr = useStore((s) => s.toggleOcrExpanded);
    const findSimilar = useStore((s) => s.findSimilar);
    const showToast = useStore((s) => s.showToast);

    const photo = index === null ? undefined : props.flat[index];
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

    useEffect(() => {
        setNatural(null);
    }, [photo?.id]);

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

    return (
        <div className="fixed inset-0 z-[100] flex flex-col bg-black/[0.97]">
            <div className="flex flex-shrink-0 items-center justify-between px-5 py-4">
                <button
                    type="button"
                    onClick={close}
                    aria-label="Close"
                    className="cursor-pointer text-[18px] text-white opacity-85 hover:opacity-100"
                >
                    ✕
                </button>
                <span className="text-[12.5px] tabular-nums text-white/60">
                    {index + 1} / {props.flat.length}
                </span>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center gap-4 px-5">
                <button
                    type="button"
                    onClick={() => step(-1, props.flat.length)}
                    aria-label="Previous"
                    className="flex-shrink-0 cursor-pointer p-[10px] text-[26px] text-white opacity-70 hover:opacity-100"
                >
                    ◀
                </button>

                <div className="flex h-full min-w-0 flex-1 items-center justify-center">
                    {full !== null ? (
                        <img
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
                        />
                    ) : (
                        <div
                            className="flex items-center justify-center rounded"
                            style={{
                                width: previewW,
                                height: previewH,
                                maxWidth: "100%",
                                maxHeight: "100%",
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

                <button
                    type="button"
                    onClick={() => step(1, props.flat.length)}
                    aria-label="Next"
                    className="flex-shrink-0 cursor-pointer p-[10px] text-[26px] text-white opacity-70 hover:opacity-100"
                >
                    ▶
                </button>
            </div>

            {stripVisible ? (
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

                    <div className="flex flex-wrap gap-2">
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
                        <GhostAction
                            label="Add to collection"
                            onClick={() => showToast("Added to collection")}
                        />
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={toggleStrip}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 cursor-pointer rounded-md bg-white/10 px-3 py-[6px] text-[11px] text-white/50 hover:text-white/80"
                >
                    Show info ▴
                </button>
            )}
        </div>
    );
}

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
