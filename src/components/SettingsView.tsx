import { memo, useEffect, useMemo, useState } from "react";
import { useStore } from "../lib/store";
import {
    ACCENT_PRESETS,
    CELL_RADII,
    DRAG_SLOP_RANGE,
    EMBEDDING_MODELS,
    FONTS,
    GROUP_BY_OPTIONS,
    HOLD_TIMES,
    OCR_ENGINES,
    OCR_LANGUAGES,
    PAGE_SIZES,
    SEARCH_DEBOUNCE_RANGE,
    SELECTION_BORDERS,
    SORTED_SEARCH_KEEPS,
    SORT_OPTIONS,
    TINT_PRESETS,
    UI_SCALES,
    accentPresetFor,
    modelById,
    tintPresetFor,
} from "../lib/catalog";
import { fmtCount, fmtEta, fmtGb } from "../lib/format";
import { isFontAvailable } from "../lib/fontProbe";
import { isMockMode } from "../lib/api";
import { Box, Button, Chip, Radio, Slider, Toggle } from "./ui";
import type { Density, SortKey, ThemePref } from "../lib/types";

/** Embed-only throughput on the reference GPU (RTX 4070 laptop). Used for the
 *  pre-flight estimate only — the live panel shows the measured rate. */
const PREFLIGHT_IMG_PER_SEC = 25;

const THEMES: ThemePref[] = ["dark", "light", "system"];
const DENSITIES: { v: Density; label: string }[] = [
    { v: 0, label: "Compact" },
    { v: 1, label: "Comfortable" },
    { v: 2, label: "Large" },
];

type SectionId =
    | "folders" | "model" | "ocr" | "search" | "order" | "appearance" | "accessibility"
    | "gestures" | "shortcuts" | "storage";

/**
 * The nav rail, and the index the filter box searches. `keywords` exists
 * because the words a user types are not the words on the headings — "dark",
 * "font" and "zoom" all have to find something, and matching only on titles
 * makes the box look broken the first time it is used.
 */
const SECTIONS: { id: SectionId; label: string; keywords: string }[] = [
    { id: "folders", label: "Folders", keywords: "watched folder path recursive scan index add remove screenshots" },
    { id: "model", label: "Search model", keywords: "embedding siglip jina clip openclip vector re-index reindex turkish multilingual vram gpu" },
    { id: "ocr", label: "Text in images", keywords: "ocr tesseract rapidocr easyocr language turkish english screenshot text recognition" },
    { id: "search", label: "Search behaviour", keywords: "results page size limit how many debounce delay typing wait weight balance text visual ocr rrf fusion hybrid" },
    { id: "order", label: "Dates & order", keywords: "sort order date newest oldest name size group month day year header timeline scrubber undated taken modified" },
    { id: "appearance", label: "Appearance", keywords: "theme dark light system font jetbrains mono typeface density grid size look colour color accent hue tint warm cool border radius corner selection" },
    { id: "accessibility", label: "Accessibility", keywords: "scale zoom bigger larger text size contrast motion animation reduce focus keyboard a11y" },
    { id: "gestures", label: "Mouse & gestures", keywords: "hold press long delay select drag slop threshold click paint sweep pointer shaky" },
    { id: "shortcuts", label: "Shortcuts", keywords: "keyboard key mouse gesture shift ctrl select paint drag hold escape arrow" },
    { id: "storage", label: "Storage", keywords: "cache thumbnail disk space index size clear delete" },
];

function matchesFilter(section: { label: string; keywords: string }, q: string): boolean{
    const needle = q.trim().toLowerCase();
    if(needle === ""){
        return true;
    }
    const hay = `${section.label} ${section.keywords}`.toLowerCase();
    // Every word has to hit something, so "font size" narrows rather than
    // widening the way an any-word match would.
    return needle.split(/\s+/).every((word) => hay.includes(word));
}

export const SettingsView = memo(function SettingsView(){
    const setView = useStore((s) => s.setView);
    const loadStorage = useStore((s) => s.loadStorage);
    const [active, setActive] = useState<SectionId>("folders");
    const [filter, setFilter] = useState("");

    useEffect(() => {
        void loadStorage();
    }, [loadStorage]);

    const hits = useMemo(
        () => SECTIONS.filter((s) => matchesFilter(s, filter)),
        [filter],
    );
    // A filter shows everything it matched, in nav order; with the box empty
    // the rail is a tab bar. One section at a time is what makes the rail worth
    // having — scroll-spy over one long page just moves the scrolling around.
    const searching = filter.trim() !== "";
    const shown = searching ? hits.map((s) => s.id) : [active];

    return (
        <div className="flex min-w-0 flex-1 overflow-hidden">
            <nav className="flex w-[calc(196px*var(--ui-scale))] flex-shrink-0 flex-col gap-1 overflow-y-auto border-r border-edge bg-panel px-3 py-[calc(14px*var(--ui-scale))]">
                <button
                    type="button"
                    onClick={() => setView("library")}
                    className="mb-2 cursor-pointer rounded-md px-2 py-[calc(6px*var(--ui-scale))] text-left text-[calc(12.5px*var(--ui-scale))] text-fg-dim hover:bg-hover hover:text-fg"
                >
                    ← Back to library
                </button>

                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter settings…"
                    aria-label="Filter settings"
                    className="mb-2 w-full rounded-md border border-edge bg-raised px-2 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
                />

                {SECTIONS.map((s) => {
                    const hit = hits.some((h) => h.id === s.id);
                    const on = searching ? hit : active === s.id;
                    return (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                                setFilter("");
                                setActive(s.id);
                            }}
                            aria-current={on ? "page" : undefined}
                            className={
                                "cursor-pointer rounded-md px-2 py-[calc(7px*var(--ui-scale))] text-left text-[calc(12.5px*var(--ui-scale))] transition-colors " +
                                (on
                                    ? "bg-accent-muted text-accent-text"
                                    : searching
                                        ? "text-fg-faint hover:bg-hover"
                                        : "text-fg-dim hover:bg-hover hover:text-fg")
                            }
                        >
                            {s.label}
                        </button>
                    );
                })}
            </nav>

            <div className="min-w-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-[calc(640px*var(--ui-scale))] px-6 pt-7 pb-20">
                    {isMockMode ? (
                        <div className="mb-7 rounded-lg border border-edge bg-raised p-3 text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-dim">
                            Running against the built-in fixture library — the Python sidecar is not
                            connected, so folder picking and re-indexing are simulated.
                        </div>
                    ) : null}

                    {searching && shown.length === 0 ? (
                        <div className="text-[calc(12.5px*var(--ui-scale))] text-fg-faint">
                            Nothing matches “{filter}”.
                        </div>
                    ) : null}

                    {shown.includes("folders") ? <FoldersSection /> : null}
                    {shown.includes("model") ? <ModelSection /> : null}
                    {shown.includes("ocr") ? <OcrSection /> : null}
                    {shown.includes("search") ? <SearchSection /> : null}
                    {shown.includes("order") ? <OrderSection /> : null}
                    {shown.includes("appearance") ? <AppearanceSection /> : null}
                    {shown.includes("accessibility") ? <AccessibilitySection /> : null}
                    {shown.includes("gestures") ? <GestureSection /> : null}
                    {shown.includes("shortcuts") ? <ShortcutsSection /> : null}
                    {shown.includes("storage") ? <StorageSection /> : null}
                </div>
            </div>
        </div>
    );
});

function Group(props: { title: string; hint?: string; children: React.ReactNode }){
    return (
        <div className="mb-8">
            <div className="mb-[calc(3px*var(--ui-scale))] text-[calc(13px*var(--ui-scale))] font-semibold">{props.title}</div>
            {props.hint !== undefined ? (
                <div className="mb-3 text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-faint">{props.hint}</div>
            ) : null}
            {props.children}
        </div>
    );
}

function FoldersSection(){
    const folders = useStore((s) => s.folders);
    const toggleRecursive = useStore((s) => s.toggleRecursive);
    const removeFolder = useStore((s) => s.removeFolder);
    const confirming = useStore((s) => s.removeFolderConfirm);
    const requestRemove = useStore((s) => s.requestRemoveFolder);
    const cancelRemove = useStore((s) => s.cancelRemoveFolder);
    const addFolder = useStore((s) => s.addFolder);

    return (
        <Group
            title="Watched folders"
            hint="Folders indexed for search. Screenshots are detected automatically and get an OCR pass. Removing a folder takes its photos out of the library; the files on disk are never touched."
        >
            {folders.map((f) => (
                <div key={f.path} className="flex items-center gap-[calc(10px*var(--ui-scale))] border-b border-edge py-[calc(10px*var(--ui-scale))]">
                    <div className="min-w-0 flex-1">
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[calc(12.5px*var(--ui-scale))]">
                            {f.path}
                        </div>
                        <div className="mt-[calc(2px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] text-fg-faint">
                            {fmtCount(f.count)} images
                        </div>
                    </div>
                    {confirming === f.path ? (
                        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">
                            <span className="max-w-[calc(260px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg-dim">
                                Remove {fmtCount(f.count)} images from the library? The files stay on disk.
                            </span>
                            <button
                                type="button"
                                onClick={() => void removeFolder(f.path)}
                                className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border-none bg-danger px-3 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-white hover:opacity-90"
                            >
                                Remove
                            </button>
                            <button
                                type="button"
                                autoFocus
                                onClick={cancelRemove}
                                className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-3 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg hover:bg-hover"
                            >
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <>
                            <Toggle
                                label="Recursive"
                                on={f.recursive}
                                onClick={() => void toggleRecursive(f.path)}
                            />
                            <button
                                type="button"
                                onClick={() => requestRemove(f.path)}
                                aria-label={`Stop watching ${f.path}`}
                                title="Stop watching and remove its photos from the library (files stay on disk)"
                                className="flex-shrink-0 cursor-pointer px-1 py-[calc(2px*var(--ui-scale))] text-[calc(14px*var(--ui-scale))] text-fg-faint hover:text-danger"
                            >
                                ✕
                            </button>
                        </>
                    )}
                </div>
            ))}
            <Button onClick={() => void addFolder()} className="mt-3">+ Add folder</Button>
        </Group>
    );
}

function ModelSection(){
    const modelId = useStore((s) => s.settings.modelId);
    const pendingId = useStore((s) => s.pendingModelId);
    const reindex = useStore((s) => s.reindex);
    const select = useStore((s) => s.selectModel);
    const confirm = useStore((s) => s.confirmModelChange);
    const cancel = useStore((s) => s.cancelModelChange);
    // The library size, not `indexing.total` — that is 0 unless a scan happens
    // to be running, so the warning used to read "~1 minutes for 0 images".
    const libraryTotal = useStore((s) => s.counts.library);
    const activeName = useStore((s) => modelById(s.settings.modelId)?.name ?? s.settings.modelId);

    const pending = pendingId === null ? null : (modelById(pendingId) ?? null);
    // A pre-flight guess only: nothing has been measured yet. Once batches land
    // the panel below switches to the rate the sidecar actually reports.
    const etaMin = Math.max(1, Math.round(libraryTotal / PREFLIGHT_IMG_PER_SEC / 60));

    return (
        <Group
            title="Search model"
            hint="The embedding model used to understand your images. Changing it requires re-embedding every image — old vectors are kept, so switching back is instant."
        >
            {EMBEDDING_MODELS.map((m) => {
                const selected = m.id === modelId;
                return (
                    <button
                        key={m.id}
                        type="button"
                        onClick={() => select(m.id)}
                        disabled={reindex.active}
                        className={
                            "mb-[calc(6px*var(--ui-scale))] flex w-full cursor-pointer items-center gap-[calc(10px*var(--ui-scale))] rounded-lg border px-3 py-[calc(11px*var(--ui-scale))] text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 " +
                            (selected
                                ? "border-accent bg-accent-muted"
                                : "border-edge bg-raised hover:bg-hover")
                        }
                    >
                        <Radio selected={selected} />
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 text-[calc(13px*var(--ui-scale))] font-medium">
                                {m.name}
                                {!m.multilingual ? (
                                    <span
                                        title="Cannot answer Turkish queries"
                                        className="rounded bg-hover px-[calc(5px*var(--ui-scale))] py-px text-[calc(10px*var(--ui-scale))] font-normal text-fg-faint"
                                    >
                                        EN only
                                    </span>
                                ) : null}
                            </div>
                            <div className="mt-px text-[calc(11.5px*var(--ui-scale))] text-fg-faint">{m.desc}</div>
                        </div>
                    </button>
                );
            })}

            {pending !== null && !reindex.active ? (
                <div className="mt-[calc(10px*var(--ui-scale))] rounded-lg border border-edge bg-danger-muted p-[calc(14px*var(--ui-scale))]">
                    <div className="mb-1 text-[calc(12.5px*var(--ui-scale))] font-semibold text-fg">Re-index required</div>
                    <div className="mb-[calc(10px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-dim">
                        Switching to {pending.name} means every image needs to be re-embedded —
                        the two models produce incompatible vectors. Roughly ~{etaMin} minute
                        {etaMin === 1 ? "" : "s"} for {fmtCount(libraryTotal)} images.{" "}
                        <span className="text-fg">Search keeps working</span> the whole time —
                        {" "}{activeName} answers queries until the new model is ready.
                    </div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={confirm}
                            className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border-none bg-danger px-[calc(14px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-white hover:opacity-90"
                        >
                            Re-index now
                        </button>
                        <button
                            type="button"
                            onClick={cancel}
                            className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-[calc(14px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg hover:bg-hover"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : null}

            {reindex.active ? (
                <div className="mt-[calc(10px*var(--ui-scale))] rounded-lg border border-edge bg-raised p-[calc(14px*var(--ui-scale))]">
                    <div className="mb-2 text-[calc(12.5px*var(--ui-scale))] text-fg">
                        Re-indexing with {reindex.modelName}… {Math.round(reindex.progress)}%
                        {reindex.total > 0 ? (
                            <span className="text-fg-faint">
                                {" "}({fmtCount(reindex.current)} / {fmtCount(reindex.total)})
                            </span>
                        ) : null}
                    </div>
                    <div className="mb-2 h-[calc(6px*var(--ui-scale))] overflow-hidden rounded-[calc(3px*var(--ui-scale))] bg-hover">
                        <div
                            className="h-full bg-accent transition-[width]"
                            style={{ width: `${reindex.progress}%` }}
                        />
                    </div>
                    {/* Not "unavailable": the outgoing model keeps every vector
                        it had until the incoming one has full coverage. */}
                    <div className="text-[calc(11.5px*var(--ui-scale))] text-fg-faint">
                        Still searching with {activeName}
                        {reindex.rate > 0 ? ` · ${reindex.rate.toFixed(1)} img/s · ${fmtEta(reindex.etaSec)} left` : ""}
                    </div>
                </div>
            ) : null}
        </Group>
    );
}

function OcrSection(){
    const engineId = useStore((s) => s.settings.ocrEngineId);
    const langs = useStore((s) => s.settings.ocrLangs);
    const setEngine = useStore((s) => s.setOcrEngine);
    const toggleLang = useStore((s) => s.toggleOcrLang);
    const hint = useStore((s) => s.ocrStatus?.hint ?? null);
    const loadOcrStatus = useStore((s) => s.loadOcrStatus);

    useEffect(() => {
        void loadOcrStatus();
    }, [loadOcrStatus]);

    return (
        <Group
            title="OCR engine and languages"
            hint="Extracts text from screenshots so words printed inside them become searchable."
        >
            {hint !== null ? (
                <div className="mb-[calc(12px*var(--ui-scale))] rounded-lg border border-edge bg-raised px-3 py-[calc(9px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg-dim" data-selectable>
                    {hint}
                </div>
            ) : null}
            {OCR_ENGINES.map((e) => {
                const selected = e.id === engineId;
                return (
                    <button
                        key={e.id}
                        type="button"
                        onClick={() => setEngine(e.id)}
                        className={
                            "mb-[calc(5px*var(--ui-scale))] flex w-full cursor-pointer items-center gap-[calc(10px*var(--ui-scale))] rounded-lg px-3 py-[calc(9px*var(--ui-scale))] text-left transition-colors " +
                            (selected ? "bg-accent-muted" : "hover:bg-hover")
                        }
                    >
                        <Radio selected={selected} />
                        <div>
                            <div className="text-[calc(12.5px*var(--ui-scale))]">{e.label}</div>
                            <div className="mt-px text-[calc(11.5px*var(--ui-scale))] text-fg-faint">{e.desc}</div>
                        </div>
                    </button>
                );
            })}

            <div className="mt-[calc(14px*var(--ui-scale))] mb-2 text-[calc(11.5px*var(--ui-scale))] text-fg-faint">LANGUAGES</div>
            <div className="flex flex-wrap gap-2">
                {OCR_LANGUAGES.map((l) => (
                    <button
                        key={l.code}
                        type="button"
                        onClick={() => toggleLang(l.code)}
                        className="flex cursor-pointer items-center gap-[calc(6px*var(--ui-scale))] rounded-[calc(7px*var(--ui-scale))] border border-edge bg-raised px-[calc(10px*var(--ui-scale))] py-[calc(6px*var(--ui-scale))] hover:bg-hover"
                    >
                        <Box checked={langs.includes(l.code)} />
                        <span className="text-[calc(12px*var(--ui-scale))]">{l.label}</span>
                    </button>
                ))}
            </div>
        </Group>
    );
}

function Label(props: { children: React.ReactNode }){
    return (
        <div className="mb-[calc(6px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] tracking-[0.05em] text-fg-faint">
            {props.children}
        </div>
    );
}

/** One accent choice: the colour itself, at the lightness and chroma the dark
 *  theme uses, so the row of them reads as the palette it actually is. */
function Swatch(props: { hue: number; active: boolean; label: string; onClick: () => void }){
    return (
        <button
            type="button"
            onClick={props.onClick}
            aria-label={props.label}
            aria-pressed={props.active}
            title={props.label}
            className={
                "flex h-[calc(26px*var(--ui-scale))] w-[calc(26px*var(--ui-scale))] cursor-pointer items-center justify-center rounded-full border-2 transition-colors " +
                (props.active ? "border-fg" : "border-transparent hover:border-edge")
            }
        >
            <span
                className="block h-[calc(18px*var(--ui-scale))] w-[calc(18px*var(--ui-scale))] rounded-full"
                style={{ background: `oklch(68% 0.15 ${props.hue})` }}
            />
        </button>
    );
}

function ColourSection(){
    const accentHue = useStore((s) => s.settings.accentHue);
    const tintHue = useStore((s) => s.settings.tintHue);
    const tintStrength = useStore((s) => s.settings.tintStrength);
    const set = useStore((s) => s.setSetting);
    const activeAccent = accentPresetFor(accentHue);
    const activeTint = tintPresetFor(tintHue, tintStrength);

    return (
        <>
            <Label>ACCENT</Label>
            <div className="mb-[calc(8px*var(--ui-scale))] flex flex-wrap gap-[calc(6px*var(--ui-scale))]">
                {ACCENT_PRESETS.map((a) => (
                    <Swatch
                        key={a.id}
                        hue={a.hue}
                        label={a.label}
                        active={activeAccent === a.id}
                        onClick={() => set("accentHue", a.hue)}
                    />
                ))}
            </div>
            <div className="mb-5">
                <Slider
                    label="Accent hue"
                    value={accentHue}
                    min={0}
                    max={359}
                    readout={`${accentHue}°`}
                    onChange={(v) => set("accentHue", v)}
                />
                <div className="mt-[calc(6px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                    A hue, not a colour: every theme keeps its own lightness and chroma for
                    the accent, so the same choice stays readable in light, dark and high
                    contrast. Delete stays red — it is a warning, not a preference.
                </div>
            </div>

            <Label>SURFACE TINT</Label>
            <div className="mb-[calc(8px*var(--ui-scale))] flex flex-wrap gap-[calc(6px*var(--ui-scale))]">
                {TINT_PRESETS.map((t) => (
                    <Chip
                        key={t.id}
                        label={t.label}
                        active={activeTint === t.id}
                        onClick={() => {
                            set("tintHue", t.hue);
                            set("tintStrength", t.strength);
                        }}
                    />
                ))}
            </div>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label="Tint hue"
                    value={tintHue}
                    min={0}
                    max={359}
                    readout={`${tintHue}°`}
                    onChange={(v) => set("tintHue", v)}
                />
            </div>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label="Tint strength"
                    value={tintStrength}
                    min={0}
                    max={300}
                    step={10}
                    readout={`${tintStrength}%`}
                    onChange={(v) => set("tintStrength", v)}
                />
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                The greys are not grey — every panel, border and label carries a trace of
                colour, and this is where it points. 100% is the shipped slate, 0% is a
                true neutral. High contrast ignores it on purpose.
            </div>
        </>
    );
}

function GridLookSection(){
    const selectionBorder = useStore((s) => s.settings.selectionBorder);
    const cellRadius = useStore((s) => s.settings.cellRadius);
    const set = useStore((s) => s.setSetting);

    return (
        <>
            <Label>SELECTION BORDER</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {SELECTION_BORDERS.map((b) => (
                    <Chip
                        key={b.v}
                        label={b.label}
                        active={selectionBorder === b.v}
                        onClick={() => set("selectionBorder", b.v)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                The accent frame a selected photo pulls in behind. It stops at the width of
                the grid gutter: any wider and a swept row reads as one block of accent
                with photos floating in it.
            </div>

            <Label>PHOTO CORNERS</Label>
            <div className="mb-5 flex gap-[calc(6px*var(--ui-scale))]">
                {CELL_RADII.map((r) => (
                    <Chip
                        key={r.v}
                        label={r.label}
                        active={cellRadius === r.v}
                        onClick={() => set("cellRadius", r.v)}
                    />
                ))}
            </div>
        </>
    );
}

function SearchSection(){
    const pageSize = useStore((s) => s.settings.pageSize);
    const debounce = useStore((s) => s.settings.searchDebounceMs);
    const textWeight = useStore((s) => s.settings.textWeight);
    const set = useStore((s) => s.setSetting);

    return (
        <Group
            title="Search behaviour"
            hint="How much comes back, how quickly a query fires, and what the two halves of a hybrid search are worth against each other."
        >
            <Label>RESULTS PER QUERY</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {PAGE_SIZES.map((n) => (
                    <Chip
                        key={n}
                        label={String(n)}
                        active={pageSize === n}
                        onClick={() => set("pageSize", n)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                Rows fetched per request. The grid loads the next page as you near the end,
                so this trades a few larger requests against more smaller ones — it no
                longer caps what you can reach.
            </div>

            <Label>TYPING DELAY</Label>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label="Search debounce"
                    value={debounce}
                    min={SEARCH_DEBOUNCE_RANGE.min}
                    max={SEARCH_DEBOUNCE_RANGE.max}
                    step={20}
                    readout={`${debounce} ms`}
                    onChange={(v) => set("searchDebounceMs", v)}
                />
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                How long typing has to stop before the query is sent. 0 embeds the query on
                every keystroke — the GPU can take it; a slow disk under a cold cache may
                not.
            </div>

            <Label>TEXT VS VISUAL</Label>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label="Text versus visual weighting"
                    value={textWeight}
                    min={0}
                    max={100}
                    step={5}
                    readout={textWeight === 50 ? "balanced" : `${textWeight}%`}
                    onChange={(v) => set("textWeight", v)}
                />
            </div>
            <div className="text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                Left favours what the photo <em>looks</em> like, right favours words read out
                of it by OCR. This weights the two ranked lists, never their scores — cosine
                and BM25 share no scale, and blending them directly is noise.
            </div>
        </Group>
    );
}

function OrderSection(){
    const sort = useStore((s) => s.settings.sort);
    const groupBy = useStore((s) => s.settings.groupBy);
    const keep = useStore((s) => s.settings.sortedSearchKeep);
    const setSort = useStore((s) => s.setSort);
    const searching = useStore((s) => s.query.trim() !== "");
    const set = useStore((s) => s.setSetting);

    return (
        <Group
            title="Dates and order"
            hint="How the library is ordered, how date headers group it, and what a sorted search keeps."
        >
            <Label>LIBRARY ORDER</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex flex-wrap gap-[calc(6px*var(--ui-scale))]">
                {SORT_OPTIONS.filter((o) => o.key !== "relevance").map((o) => (
                    <Chip
                        key={o.key}
                        label={o.short}
                        active={sort === o.key}
                        onClick={() => {
                            // Here it always means the *library* order. With a
                            // query typed, `setSort` would take it as that
                            // query's session-only order, so the setting is
                            // written directly and the search left alone.
                            if(searching){
                                set("sort", o.key as SortKey);
                            }else{
                                setSort(o.key as SortKey);
                            }
                        }}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                Also in the top bar. A date comes from the photo&apos;s EXIF, then from a date in its
                filename (<span className="font-mono">Screenshot_20260530_213645.png</span>), then
                from when the file was last modified — the viewer says &ldquo;Modified&rdquo;
                rather than &ldquo;Taken&rdquo; for those. Photos with none sort last.
            </div>

            <Label>GROUP DATE HEADERS BY</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {GROUP_BY_OPTIONS.map((g) => (
                    <Chip
                        key={g.key}
                        label={g.label}
                        active={groupBy === g.key}
                        onClick={() => set("groupBy", g.key)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                Headers appear whenever the grid is sorted by date — browsing or searching.
                The scrubber on the right edge always jumps by month.
            </div>

            <Label>SORTED SEARCH KEEPS</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {SORTED_SEARCH_KEEPS.map((n) => (
                    <Chip
                        key={n}
                        label={`Top ${n}`}
                        active={keep === n}
                        onClick={() => set("sortedSearchKeep", n)}
                    />
                ))}
            </div>
            <div className="text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                Search ranks every photo in the library, so sorting a query by date, name or
                size first keeps this many of the best matches, then reorders them.
            </div>
        </Group>
    );
}

function GestureSection(){
    const holdMs = useStore((s) => s.settings.holdMs);
    const dragSlop = useStore((s) => s.settings.dragSlop);
    const set = useStore((s) => s.setSetting);

    return (
        <Group
            title="Mouse and gestures"
            hint="The two numbers that decide what a press on a photo means."
        >
            <Label>HOLD TO SELECT</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {HOLD_TIMES.map((h) => (
                    <Chip
                        key={h.v}
                        label={`${h.label} · ${h.v} ms`}
                        active={holdMs === h.v}
                        onClick={() => set("holdMs", h.v)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                Press and keep holding for this long and the photo is selected instead of
                opened. Keep moving and the hold flows straight into a paint sweep.
            </div>

            <Label>DRAG THRESHOLD</Label>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label="Drag threshold"
                    value={dragSlop}
                    min={DRAG_SLOP_RANGE.min}
                    max={DRAG_SLOP_RANGE.max}
                    readout={`${dragSlop} px`}
                    onChange={(v) => set("dragSlop", v)}
                />
            </div>
            <div className="text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                How far the pointer may drift and still count as a click. Raise it if a
                photo starts a selection sweep when you meant to open it.
            </div>
        </Group>
    );
}

function AppearanceSection(){
    const theme = useStore((s) => s.settings.theme);
    const setTheme = useStore((s) => s.setTheme);
    const density = useStore((s) => s.density);
    const setDensity = useStore((s) => s.setDensity);
    const fontId = useStore((s) => s.settings.fontId);
    const setFont = useStore((s) => s.setFont);

    // Probed once per mount: the answer cannot change while the window is open,
    // and each probe is two canvas measurements.
    const installed = useMemo(
        () => new Map(FONTS.map((f) => [f.id, isFontAvailable(f.stack)])),
        [],
    );

    return (
        <Group title="Appearance">
            <Label>THEME</Label>
            <div className="mb-5 flex gap-[calc(6px*var(--ui-scale))]">
                {THEMES.map((t) => (
                    <Chip
                        key={t}
                        label={t[0]!.toUpperCase() + t.slice(1)}
                        active={theme === t}
                        onClick={() => setTheme(t)}
                    />
                ))}
            </div>

            <Label>FONT</Label>
            <div className="mb-[calc(10px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                No font is bundled — nothing is ever downloaded — so these are the families
                installed on this machine. A missing one falls back to the system monospace.
            </div>
            <div className="mb-5">
                {FONTS.map((f) => {
                    const selected = f.id === fontId;
                    const here = installed.get(f.id) ?? true;
                    return (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setFont(f.id)}
                            className={
                                "mb-[calc(5px*var(--ui-scale))] flex w-full cursor-pointer items-center gap-[calc(10px*var(--ui-scale))] rounded-lg px-3 py-[calc(9px*var(--ui-scale))] text-left transition-colors " +
                                (selected ? "bg-accent-muted" : "hover:bg-hover")
                            }
                        >
                            <Radio selected={selected} />
                            <div className="min-w-0">
                                <div
                                    className="flex items-center gap-2 text-[calc(12.5px*var(--ui-scale))]"
                                    style={{ fontFamily: here ? f.stack : undefined }}
                                >
                                    {f.label}
                                    {!here ? (
                                        <span className="rounded bg-hover px-[calc(5px*var(--ui-scale))] py-px font-sans text-[calc(10px*var(--ui-scale))] text-fg-faint">
                                            not installed
                                        </span>
                                    ) : null}
                                </div>
                                <div className="mt-px font-mono text-[calc(11px*var(--ui-scale))] text-fg-faint">
                                    {here ? f.desc : `Install: ${f.desc}`}
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>

            <ColourSection />

            <Label>DEFAULT GRID DENSITY</Label>
            <div className="flex gap-[calc(6px*var(--ui-scale))]">
                {DENSITIES.map((d) => (
                    <Chip
                        key={d.v}
                        label={d.label}
                        active={density === d.v}
                        onClick={() => setDensity(d.v)}
                    />
                ))}
            </div>
            <div className="mt-2 mb-5 text-[calc(11.5px*var(--ui-scale))] text-fg-faint">
                Ctrl + scroll over the grid changes this without coming here.
            </div>

            <GridLookSection />
        </Group>
    );
}

function AccessibilitySection(){
    const uiScale = useStore((s) => s.settings.uiScale);
    const setUiScale = useStore((s) => s.setUiScale);
    const reduceMotion = useStore((s) => s.settings.reduceMotion);
    const setReduceMotion = useStore((s) => s.setReduceMotion);
    const highContrast = useStore((s) => s.settings.highContrast);
    const setHighContrast = useStore((s) => s.setHighContrast);
    const fontId = useStore((s) => s.settings.fontId);
    const font = FONTS.find((f) => f.id === fontId);

    return (
        <Group
            title="Accessibility"
            hint="These apply to the whole app and persist across restarts."
        >
            <Label>INTERFACE SIZE</Label>
            <div className="mb-[calc(10px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {UI_SCALES.map((s) => (
                    <Chip
                        key={s}
                        label={`${s}%`}
                        active={uiScale === s}
                        onClick={() => setUiScale(s)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                Text, controls, month headers and photo rows all grow together — the grid's
                row heights are computed in JavaScript, so they take the same factor the
                stylesheet does. Currently {uiScale}% of the base size
                {font !== undefined ? `, in ${font.label}` : ""}.
            </div>

            <div className="mb-[calc(10px*var(--ui-scale))] flex items-center justify-between border-b border-edge pb-[calc(10px*var(--ui-scale))]">
                <div className="min-w-0 pr-4">
                    <div className="text-[calc(12.5px*var(--ui-scale))]">High contrast</div>
                    <div className="mt-px text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                        Stronger borders and brighter text, on top of whichever theme is
                        showing — light and dark both have one.
                    </div>
                </div>
                <Toggle
                    label=""
                    ariaLabel="High contrast"
                    on={highContrast}
                    onClick={() => setHighContrast(!highContrast)}
                />
            </div>

            <div className="mb-[calc(10px*var(--ui-scale))] flex items-center justify-between border-b border-edge pb-[calc(10px*var(--ui-scale))]">
                <div className="min-w-0 pr-4">
                    <div className="text-[calc(12.5px*var(--ui-scale))]">Reduce motion</div>
                    <div className="mt-px text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                        Stops the loading shimmer, the spinners and every transition.
                        Off follows the system preference; on forces it here.
                    </div>
                </div>
                <Toggle
                    label=""
                    ariaLabel="Reduce motion"
                    on={reduceMotion}
                    onClick={() => setReduceMotion(!reduceMotion)}
                />
            </div>

            <div className="text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                Keyboard focus is always drawn with a visible ring — arrow keys move it
                through the grid, Space selects, Enter opens. See Shortcuts.
            </div>
        </Group>
    );
}

const SHORTCUTS: { group: string; rows: { keys: string; what: string }[] }[] = [
    {
        group: "Search and navigation",
        rows: [
            { keys: "/", what: "Focus the search box" },
            { keys: "Esc", what: "Leave fullscreen, close the lightbox, clear the query, then the selection" },
            { keys: "← → ↑ ↓", what: "Move focus through the grid" },
            { keys: "Enter", what: "Open the focused photo" },
            { keys: "Space", what: "Select or deselect the focused photo" },
        ],
    },
    {
        group: "Zoom",
        rows: [
            { keys: "Ctrl + scroll", what: "Grid density, or the photo in the lightbox" },
            { keys: "Ctrl + = / −", what: "Same, from the keyboard" },
            { keys: "Ctrl + 0", what: "Back to the default density" },
        ],
    },
    {
        group: "Lightbox",
        rows: [
            { keys: "← →", what: "Previous / next photo" },
            { keys: "F", what: "Fullscreen — image only, no chrome" },
            { keys: "Double-click", what: "Zoom in on the point under the pointer" },
        ],
    },
    {
        group: "Selecting with the mouse",
        rows: [
            { keys: "Click", what: "Open the photo" },
            { keys: "Hold 0.4s", what: "Select it instead of opening" },
            { keys: "Drag", what: "Paint-select everything the pointer crosses" },
            { keys: "Ctrl + drag", what: "Paint in reverse — deselect what it crosses" },
            { keys: "Shift + click", what: "Select the range from the last photo touched" },
            { keys: "Shift during a drag", what: "Everything from where the press started to here" },
            { keys: "Drag a selected photo", what: "Carry the selection onto a collection, or out to the desktop" },
        ],
    },
];

function ShortcutsSection(){
    return (
        <Group
            title="Shortcuts"
            hint="Everything the app responds to. The keys themselves are fixed; the two timings behind the mouse gestures are in Mouse & gestures."
        >
            {SHORTCUTS.map((g) => (
                <div key={g.group} className="mb-5">
                    <Label>{g.group.toUpperCase()}</Label>
                    {g.rows.map((r) => (
                        <div
                            key={r.keys}
                            className="flex items-baseline gap-3 border-b border-edge py-[calc(7px*var(--ui-scale))]"
                        >
                            <span className="w-[calc(150px*var(--ui-scale))] flex-shrink-0 font-mono text-[calc(11.5px*var(--ui-scale))] text-accent-text">
                                {r.keys}
                            </span>
                            <span className="text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-dim">
                                {r.what}
                            </span>
                        </div>
                    ))}
                </div>
            ))}
        </Group>
    );
}

function StorageSection(){
    const storage = useStore((s) => s.storage);
    const confirm = useStore((s) => s.clearCacheConfirm);
    const clearCache = useStore((s) => s.clearCache);
    const cancel = useStore((s) => s.cancelClearCache);

    return (
        <Group title="Storage">
            <div className="flex justify-between py-[calc(6px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg-dim">
                <span>Thumbnail cache</span>
                <span className="tabular-nums">{fmtGb(storage.thumbnailCacheGb)}</span>
            </div>
            <div className="mb-3 flex justify-between border-b border-edge py-[calc(6px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg-dim">
                <span>Search index</span>
                <span className="tabular-nums">{fmtGb(storage.indexGb)}</span>
            </div>
            {confirm ? (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[calc(12px*var(--ui-scale))] text-fg-dim">
                        Clear {fmtGb(storage.thumbnailCacheGb)} of cached thumbnails? They will be
                        regenerated on demand.
                    </span>
                    <button
                        type="button"
                        onClick={() => void clearCache()}
                        className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border-none bg-danger px-3 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-white hover:opacity-90"
                    >
                        Confirm
                    </button>
                    <button
                        type="button"
                        onClick={cancel}
                        className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-3 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg hover:bg-hover"
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <Button onClick={() => void clearCache()}>Clear thumbnail cache</Button>
            )}
        </Group>
    );
}
