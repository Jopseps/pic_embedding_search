import type {
    EditorFont,
    EmbeddingModel,
    GroupBy,
    OcrEngine,
    OcrLanguage,
    SearchSort,
    SortKey,
    UiScale,
} from "./types";

/**
 * The Claude Design source shipped placeholder catalogs (CLIP-only models, and
 * an "Apple Vision" OCR engine that does not exist on Linux). These are the real
 * ones, per ARCHITECTURE.md § Decision log.
 *
 * Adding a model is one entry here plus one entry in the sidecar's registry —
 * never a refactor. `multilingual: false` models cannot answer Turkish queries,
 * which the UI surfaces rather than silently degrading.
 */
export const EMBEDDING_MODELS: EmbeddingModel[] = [
    {
        id: "siglip2-so400m-patch14-384",
        name: "SigLIP 2 so400m",
        desc: "Best quality · ~150 img/s · ~1.7 GB VRAM",
        multilingual: true,
        dim: 1152,
    },
    {
        id: "jina-clip-v2",
        name: "jina-clip-v2",
        desc: "89 languages · Matryoshka dims · ~1.6 GB VRAM",
        multilingual: true,
        dim: 1024,
    },
    {
        id: "siglip2-base-patch16-224",
        name: "SigLIP 2 base",
        desc: "Fast indexing · ~500 img/s · ~0.5 GB VRAM",
        multilingual: true,
        dim: 768,
    },
    {
        id: "openclip-vit-l14",
        name: "OpenCLIP ViT-L/14",
        desc: "English only · fastest · ~1.2 GB VRAM",
        multilingual: false,
        dim: 768,
    },
];

export const DEFAULT_MODEL_ID = "siglip2-so400m-patch14-384";

export const OCR_ENGINES: OcrEngine[] = [
    {
        id: "tesseract",
        label: "Tesseract",
        desc: "CPU · real tur+eng · strongest on crisp UI text",
    },
    {
        id: "rapidocr",
        label: "RapidOCR",
        desc: "ONNX · better on photos · Turkish diacritics degrade",
    },
    {
        id: "easyocr",
        label: "EasyOCR",
        desc: "PyTorch · 80+ languages · separate install",
    },
];

/**
 * Tesseract, not RapidOCR: its `-l tur+eng` is the only one of the three that
 * reads Turkish correctly today. RapidOCR's bundled PP-OCRv4 dictionary has no
 * `ş ğ ı İ`. The sidecar falls back through the registry if the chosen engine
 * is not installed, so a stale preference degrades rather than breaking.
 */
export const DEFAULT_OCR_ENGINE_ID = "tesseract";

export const OCR_LANGUAGES: OcrLanguage[] = [
    { code: "en", label: "English" },
    { code: "tr", label: "Turkish" },
    { code: "de", label: "German" },
    { code: "es", label: "Spanish" },
    { code: "fr", label: "French" },
    { code: "ja", label: "Japanese" },
];

/** English + Turkish on by default — a hard requirement, see CLAUDE.md. */
export const DEFAULT_OCR_LANGS = ["en", "tr"];

/**
 * UI fonts. Nothing is bundled and nothing is fetched — this app is offline by
 * design, and a webfont that silently fails to load is exactly the failure mode
 * the rest of the codebase goes out of its way to avoid. Each entry names a
 * family that has to be installed on the machine, with a fallback chain behind
 * it; `SettingsView` checks `document.fonts` and marks the missing ones.
 */
export const MONO_FALLBACK = "ui-monospace, Menlo, Consolas, monospace";

export const FONTS: EditorFont[] = [
    {
        id: "jetbrains-mono",
        label: "JetBrains Mono",
        stack: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
        mono: true,
        desc: "pacman -S ttf-jetbrains-mono",
    },
    {
        id: "fira-code",
        label: "Fira Code",
        stack: '"Fira Code", ui-monospace, Menlo, Consolas, monospace',
        mono: true,
        desc: "pacman -S ttf-fira-code",
    },
    {
        id: "cascadia-code",
        label: "Cascadia Code",
        stack: '"Cascadia Code", ui-monospace, Menlo, Consolas, monospace',
        mono: true,
        desc: "pacman -S ttf-cascadia-code",
    },
    {
        id: "ibm-plex-mono",
        label: "IBM Plex Mono",
        stack: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
        mono: true,
        desc: "pacman -S ttf-ibm-plex",
    },
    {
        id: "system-mono",
        label: "System monospace",
        stack: "ui-monospace, Menlo, Consolas, monospace",
        mono: true,
        desc: "Whatever the system calls monospace — always available",
    },
    {
        id: "system-sans",
        label: "System sans",
        stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif',
        mono: false,
        desc: "The pre-1.0 look — always available",
    },
];

export const DEFAULT_FONT_ID = "jetbrains-mono";

/** Percent. Presets rather than a slider: four layouts that have been looked
 *  at beats a continuous range where 137% overflows a panel nobody tested. */
export const UI_SCALES: UiScale[] = [100, 115, 130, 150];

export const DEFAULT_UI_SCALE = 100;

export function fontById(id: string): EditorFont | undefined{
    return FONTS.find((f) => f.id === id);
}

/** Target row heights for the three density steps. */
export const GRID_ROW_HEIGHTS = [130, 190, 270] as const;

export const GRID_GAP = 4;

/**
 * Accent hues, in OKLCH degrees.
 *
 * A hue and nothing else. `--accent`, `--accent-muted` and `--accent-text` keep
 * their per-theme lightness and chroma — dark, light and both high-contrast
 * variants each have numbers that were chosen against their own background —
 * and the setting rotates all twelve of them at once. Picking a raw colour
 * instead would mean four sets of numbers per choice, and a "custom" colour
 * that reads on dark and vanishes on light.
 */
export const ACCENT_PRESETS: { id: string; label: string; hue: number }[] = [
    { id: "blue", label: "Blue", hue: 255 },
    { id: "indigo", label: "Indigo", hue: 285 },
    { id: "violet", label: "Violet", hue: 310 },
    { id: "magenta", label: "Magenta", hue: 340 },
    { id: "rose", label: "Rose", hue: 15 },
    { id: "amber", label: "Amber", hue: 70 },
    { id: "green", label: "Green", hue: 145 },
    { id: "teal", label: "Teal", hue: 195 },
];

export const DEFAULT_ACCENT_HUE = 255;

/**
 * Surface tints. The greys are not grey — every surface, the border and all
 * three text tokens carry 0.002–0.005 chroma at hue 250, which is what makes
 * them read as slate rather than as concrete. These presets point that trace
 * somewhere else and the strength setting scales it.
 */
export const TINT_PRESETS: { id: string; label: string; hue: number; strength: number }[] = [
    { id: "neutral", label: "Neutral", hue: 250, strength: 0 },
    { id: "slate", label: "Slate", hue: 250, strength: 100 },
    { id: "cool", label: "Cool", hue: 230, strength: 220 },
    { id: "warm", label: "Warm", hue: 70, strength: 200 },
];

export const DEFAULT_TINT_HUE = 250;
export const DEFAULT_TINT_STRENGTH = 100;

/** Selected-cell frame, px at 100% scale. Never wider than `GRID_GAP`: two
 *  selected cells side by side put two of these plus the gutter together, and
 *  past that a swept row is one accent field with photos floating in it. */
export const SELECTION_BORDERS: { v: number; label: string }[] = [
    { v: 2, label: "Thin" },
    { v: 3, label: "Medium" },
    { v: GRID_GAP, label: "Thick" },
];

export const DEFAULT_SELECTION_BORDER = 3;

export const CELL_RADII: { v: number; label: string }[] = [
    { v: 0, label: "Square" },
    { v: 6, label: "Soft" },
    { v: 12, label: "Round" },
];

export const DEFAULT_CELL_RADIUS = 6;

/** Press-and-hold delay. Below ~250ms a slow click selects instead of opening,
 *  which is the failure mode worth protecting against. */
export const HOLD_TIMES: { v: number; label: string }[] = [
    { v: 250, label: "Quick" },
    { v: 400, label: "Normal" },
    { v: 650, label: "Relaxed" },
];

export const DEFAULT_HOLD_MS = 400;
export const DEFAULT_DRAG_SLOP = 5;
export const DRAG_SLOP_RANGE = { min: 2, max: 16 } as const;

export const PAGE_SIZES = [100, 200, 500] as const;

export const DEFAULT_PAGE_SIZE = 200;
export const DEFAULT_SEARCH_DEBOUNCE_MS = 220;
export const SEARCH_DEBOUNCE_RANGE = { min: 0, max: 800 } as const;

/** 50 = both legs of the hybrid search weighted equally, which is the plain
 *  unweighted RRF. See `rrf_merge` in the sidecar. */
export const DEFAULT_TEXT_WEIGHT = 50;

export const DEFAULT_SORT: SortKey = "date-desc";
export const DEFAULT_GROUP_BY: GroupBy = "month";
export const DEFAULT_SORTED_SEARCH_KEEP = 100;
export const SORTED_SEARCH_KEEPS = [50, 100, 200, 500] as const;

/** The sort menu, in the order it lists them. `relevance` shows only while a
 *  query is active. `short` is the label on the closed button. */
export const SORT_OPTIONS: { key: SearchSort; label: string; short: string }[] = [
    { key: "relevance", label: "Relevance", short: "Relevance" },
    { key: "date-desc", label: "Date — newest first", short: "Newest" },
    { key: "date-asc", label: "Date — oldest first", short: "Oldest" },
    { key: "name-asc", label: "Name — A to Z", short: "Name A–Z" },
    { key: "name-desc", label: "Name — Z to A", short: "Name Z–A" },
    { key: "size-desc", label: "Size — largest first", short: "Largest" },
    { key: "size-asc", label: "Size — smallest first", short: "Smallest" },
];

export const GROUP_BY_OPTIONS: { key: GroupBy; label: string }[] = [
    { key: "day", label: "Day" },
    { key: "month", label: "Month" },
    { key: "year", label: "Year" },
];

export function isDateSort(sort: SearchSort): sort is "date-desc" | "date-asc"{
    return sort === "date-desc" || sort === "date-asc";
}

export function accentPresetFor(hue: number): string | null{
    return ACCENT_PRESETS.find((a) => a.hue === hue)?.id ?? null;
}

export function tintPresetFor(hue: number, strength: number): string | null{
    // Strength 0 is neutral whatever the hue says — no chroma, no direction.
    if(strength === 0){
        return "neutral";
    }
    return TINT_PRESETS.find((t) => t.hue === hue && t.strength === strength)?.id ?? null;
}

export function modelById(id: string): EmbeddingModel | undefined{
    return EMBEDDING_MODELS.find((m) => m.id === id);
}

export function ocrEngineById(id: string): OcrEngine | undefined{
    return OCR_ENGINES.find((e) => e.id === id);
}
