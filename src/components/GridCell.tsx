import { memo } from "react";
import type { Photo } from "../lib/types";
import { api } from "../lib/api";

/** Diagonal hatch stands in for image bytes when no thumbnail exists yet
 *  (mock mode, or a file the sidecar has not thumbnailed). */
const PLACEHOLDER =
    "repeating-linear-gradient(135deg,var(--surface-hover),var(--surface-hover) 12px,var(--surface-raised) 12px,var(--surface-raised) 24px)";

export interface GridCellProps{
    photo: Photo;
    width: number;
    height: number;
    selected: boolean;
    focused: boolean;
    hovered: boolean;
    anySelected: boolean;
    onOpen: () => void;
    onToggleSelect: () => void;
    onHover: (hovered: boolean) => void;
}

export const GridCell = memo(function GridCell(props: GridCellProps){
    const {
        photo, width, height, selected, focused, hovered, anySelected,
        onOpen, onToggleSelect, onHover,
    } = props;

    const thumb = api.thumbUrl(photo.id, height > 200 ? 512 : 256);
    const showCheckbox = selected || anySelected || hovered;

    return (
        <div
            style={{
                width,
                height,
                transform: hovered ? "translateY(-3px)" : "translateY(0)",
            }}
            onClick={onOpen}
            onMouseEnter={() => onHover(true)}
            onMouseLeave={() => onHover(false)}
            className="relative flex-shrink-0 cursor-pointer transition-transform duration-100"
        >
            <div
                className="absolute inset-0 overflow-hidden rounded-md"
                style={{
                    background: PLACEHOLDER,
                    outline: focused ? "2px solid var(--accent)" : "2px solid transparent",
                    outlineOffset: -2,
                }}
            >
                {thumb !== null ? (
                    <img
                        src={thumb}
                        alt={photo.filename}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        className="h-full w-full object-cover"
                    />
                ) : (
                    <div className="absolute bottom-[6px] left-[6px] rounded-[3px] bg-black/40 px-[5px] py-px font-mono text-[10px] leading-[1.4] text-[#ddd]">
                        {photo.width}×{photo.height}
                    </div>
                )}

                {photo.isScreenshot && photo.hasOcr ? (
                    <div
                        title="Text inside this screenshot is searchable"
                        className="absolute top-[6px] right-[6px] rounded-[3px] bg-black/50 px-[6px] py-[3px] font-mono text-[10px] leading-none tracking-[0.05em] text-white"
                    >
                        TEXT
                    </div>
                ) : null}

                <div
                    className="absolute inset-0 flex items-end p-2 transition-opacity duration-100"
                    style={{
                        background: "linear-gradient(to top,rgb(0 0 0 / 0.75),transparent 45%)",
                        opacity: hovered ? 1 : 0,
                    }}
                >
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-white">
                        {photo.filename}
                    </div>
                </div>

                <button
                    type="button"
                    aria-label={selected ? "Deselect" : "Select"}
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleSelect();
                    }}
                    className="absolute top-[6px] left-[6px] flex h-[18px] w-[18px] items-center justify-center rounded border-[1.5px] border-white transition-opacity duration-100"
                    style={{
                        opacity: showCheckbox ? 1 : 0,
                        pointerEvents: showCheckbox ? "auto" : "none",
                        background: selected ? "var(--accent)" : "rgb(0 0 0 / 0.35)",
                    }}
                >
                    {selected ? <span className="text-[12px] font-bold text-white">✓</span> : null}
                </button>
            </div>
        </div>
    );
});

export function SkeletonCell(props: { width: number; height: number }){
    return (
        <div
            style={{ width: props.width, height: props.height }}
            className="relative flex-shrink-0 overflow-hidden rounded-md bg-raised"
        >
            <div
                className="absolute top-0 left-0 h-full w-2/5"
                style={{
                    background: "linear-gradient(90deg,transparent,var(--surface-hover),transparent)",
                    animation: "shimmer 1.3s infinite",
                }}
            />
        </div>
    );
}
