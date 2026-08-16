import { memo } from "react";
import type { Photo } from "../lib/types";
import { api } from "../lib/api";

/** Diagonal hatch stands in for image bytes when no thumbnail exists yet
 *  (mock mode, or a file the sidecar has not thumbnailed). */
const PLACEHOLDER =
    "repeating-linear-gradient(135deg,var(--surface-hover),var(--surface-hover) 12px,var(--surface-raised) 12px,var(--surface-raised) 24px)";

/** How far the image pulls in when selected — the accent behind it becomes the
 *  border. A setting (`--sel-border`, written by App), scaled like every other
 *  size here, and capped in `SELECTION_BORDERS` at `GRID_GAP`: two adjacent
 *  selected cells put two of these plus the gutter side by side, so a fatter
 *  one turns a swept row into a single accent field with photos floating in
 *  it. */
const BORDER = "calc(var(--sel-border)*var(--ui-scale))";
/** Outer corner. The inner image rounds at half of it, the way a 3px inset
 *  inside a 6px corner has always read. */
const RADIUS = "calc(var(--cell-radius)*var(--ui-scale))";
const INNER_RADIUS = "calc(var(--cell-radius)*var(--ui-scale)*0.5)";

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
                // The selection border is the gap itself: the image insets and
                // this fill shows through it. A uniform inset rather than a
                // scale() because a scaled wide-short cell gets a thick border
                // top-and-bottom and a thin one left-and-right.
                background: selected ? "var(--accent)" : undefined,
                borderRadius: RADIUS,
            }}
            onClick={onOpen}
            onMouseEnter={() => onHover(true)}
            onMouseLeave={() => onHover(false)}
            className="relative flex-shrink-0 cursor-pointer overflow-hidden"
        >
            {/* No transition on `inset`: it animates layout, not composite, and
                Select-all puts every mounted cell through it in one frame. */}
            <div
                className="absolute overflow-hidden"
                style={{
                    borderRadius: INNER_RADIUS,
                    inset: selected ? BORDER : 0,
                    background: PLACEHOLDER,
                    // Focus is a ring on the image. Against the accent frame an
                    // accent ring would vanish, so a selected cell focuses light.
                    outline: focused
                        ? `calc(2px*var(--ui-scale)) solid var(${selected ? "--accent-text" : "--accent"})`
                        : "2px solid transparent",
                    outlineOffset: "calc(-2px*var(--ui-scale))",
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
                    <div className="absolute bottom-[calc(6px*var(--ui-scale))] left-[calc(6px*var(--ui-scale))] rounded-[calc(3px*var(--ui-scale))] bg-black/40 px-[calc(5px*var(--ui-scale))] py-px font-mono text-[calc(10px*var(--ui-scale))] leading-[1.4] text-[#ddd]">
                        {photo.width}×{photo.height}
                    </div>
                )}

                {photo.isScreenshot && photo.hasOcr ? (
                    <div
                        title="Text inside this screenshot is searchable"
                        className="absolute top-[calc(6px*var(--ui-scale))] right-[calc(6px*var(--ui-scale))] rounded-[calc(3px*var(--ui-scale))] bg-black/50 px-[calc(6px*var(--ui-scale))] py-[calc(3px*var(--ui-scale))] font-mono text-[calc(10px*var(--ui-scale))] leading-none tracking-[0.05em] text-white"
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
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[calc(11px*var(--ui-scale))] text-white">
                        {photo.filename}
                    </div>
                </div>

                {/* Selection wash, on top of the frame rather than instead of
                    it. Deliberately faint: the frame carries the state, and at
                    0.28 a pale photo disappeared under it. Non-interactive so
                    it never eats a pointermove the sweep needs. */}
                {selected ? (
                    <div
                        className="pointer-events-none absolute inset-0"
                        style={{ background: "var(--accent)", opacity: 0.1 }}
                    />
                ) : null}

                <button
                    type="button"
                    aria-label={selected ? "Deselect" : "Select"}
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleSelect();
                    }}
                    className="absolute top-[calc(6px*var(--ui-scale))] left-[calc(6px*var(--ui-scale))] flex h-[calc(18px*var(--ui-scale))] w-[calc(18px*var(--ui-scale))] items-center justify-center rounded border-[calc(1.5px*var(--ui-scale))] border-white transition-opacity duration-100"
                    style={{
                        opacity: showCheckbox ? 1 : 0,
                        pointerEvents: showCheckbox ? "auto" : "none",
                        background: selected ? "var(--accent)" : "rgb(0 0 0 / 0.35)",
                    }}
                >
                    {/* Drawn, not typed. A ✓ text node is the one thing in a cell
                        a stray text selection can grab, and it sits under the
                        pointer for the whole length of a sweep. */}
                    {selected ? (
                        <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" className="h-3 w-3">
                            <path
                                d="M2.5 6.3 4.9 8.6 9.5 3.6"
                                stroke="white"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    ) : null}
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
