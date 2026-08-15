import type { EmbeddingModel, OcrEngine, OcrLanguage } from "./types";

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
        id: "rapidocr",
        label: "RapidOCR",
        desc: "ONNX · GPU · strongest on UI screenshots",
    },
    {
        id: "tesseract",
        label: "Tesseract",
        desc: "CPU only · mature · weaker on anti-aliased text",
    },
    {
        id: "easyocr",
        label: "EasyOCR",
        desc: "PyTorch · GPU · 80+ languages",
    },
];

export const DEFAULT_OCR_ENGINE_ID = "rapidocr";

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

/** Target row heights for the three density steps. */
export const GRID_ROW_HEIGHTS = [130, 190, 270] as const;

export const GRID_GAP = 4;

export function modelById(id: string): EmbeddingModel | undefined{
    return EMBEDDING_MODELS.find((m) => m.id === id);
}

export function ocrEngineById(id: string): OcrEngine | undefined{
    return OCR_ENGINES.find((e) => e.id === id);
}
