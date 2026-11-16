import type { Photo } from "./types";

/**
 * Deterministic fixture library, ported from the Claude Design source so the
 * app runs standalone before the Python sidecar exists. The mock adapter in
 * api.ts is the only consumer; nothing else imports this.
 *
 * `tags` is mock-only — it stands in for the semantic embedding, which is what
 * actually matches queries in the real backend.
 */
export interface MockPhoto extends Photo{
    tags: string[];
    /** NaN when undated, so every date comparison against it is false — the
     *  same way a NULL `taken_at` drops out of the sidecar's date filters. */
    takenMs: number;
    /** Mock-only stand-in for `images.size_bytes`, for the size sort. */
    sizeBytes: number;
}

/** `2026-05-30T21:36:45` — naive local wall-clock, the sidecar's wire form. */
function localIso(d: Date): string{
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const PHOTO_TAGS = [
    "table", "kitchen", "wood", "beach", "sunset", "mountain", "dog", "cat",
    "portrait", "friends", "food", "coffee", "city street", "night", "car",
    "flower", "garden", "masa", "plaj", "lake", "forest", "bike", "concert",
    "wedding", "kahve", "yemek", "deniz",
];

const SHOT_TAGS = [
    "dark code editor", "terminal", "stack trace", "build failed", "browser tab",
    "chat thread", "spreadsheet", "slide deck", "design tool", "settings panel",
    "dashboard", "pull request", "table", "hata", "terminal penceresi",
];

const PHOTO_ASPECTS = [1.5, 1.3333, 1, 0.8, 0.6667, 1.2];
const SHOT_ASPECTS = [1.7778, 2.3333, 0.5625, 1.6, 1.7778];

const OCR_SAMPLES = [
    "Build failed: 3 errors",
    "TypeError: Cannot read properties of undefined",
    "npm run dev — ready on port 3000",
    "Total due: $84.20",
    "Are you sure you want to delete this file?",
    "function App(){ return <div/> }",
    "Sign in to continue",
    "42 unread messages",
    "Bağlantı hatası: sunucuya ulaşılamıyor",
    "Ödeme tutarı: ₺1.240,00",
];

export const MOCK_FOLDERS = [
    "~/Pictures",
    "~/Pictures/Screenshots",
    "~/Downloads",
    "~/Desktop",
];

const COUNT = 420;

/** Stable pseudo-random in [0,1) — same shape the design used, so the fixture
 *  library looks identical between runs and across machines. */
function rnd(i: number, k: number): number{
    return Math.abs(Math.sin(i * 12.9898 + k * 78.233)) % 1;
}

function pick<T>(arr: readonly T[], r: number): T{
    const v = arr[Math.floor(r * arr.length) % arr.length];
    return v as T;
}

function pad(n: number): string{
    return String(n).padStart(2, "0");
}

export function buildMockLibrary(): MockPhoto[]{
    const items: MockPhoto[] = [];
    const now = Date.now();

    for(let i = 0; i < COUNT; i++){
        const isScreenshot = rnd(i, 1) < 0.36;
        const aspect = pick(isScreenshot ? SHOT_ASPECTS : PHOTO_ASPECTS, rnd(i, 2));
        const pool = isScreenshot ? SHOT_TAGS : PHOTO_TAGS;

        const t1 = pick(pool, rnd(i, 3));
        let t2 = pick(pool, rnd(i, 4));
        if(t2 === t1){
            t2 = pool[(pool.indexOf(t1) + 1) % pool.length] as string;
        }

        const folder = isScreenshot
            ? (rnd(i, 5) < 0.8 ? "~/Pictures/Screenshots" : "~/Desktop")
            : (MOCK_FOLDERS[Math.floor(rnd(i, 5) * 3)] as string);

        // A few rows are undated, so the "Undated" section and the undated-last
        // ordering are exercised in the browser loop too.
        const undated = i % 53 === 17;
        const takenMs = undated ? NaN : now - Math.floor(i * 1.9 + rnd(i, 6) * 2) * 86_400_000;
        const d = new Date(undated ? now : takenMs);
        const height = isScreenshot ? 1080 : 3024;
        const width = Math.round(height * aspect);

        const filename = isScreenshot
            ? `Screenshot ${d.toISOString().slice(0, 10)} at ${pad(Math.floor(rnd(i, 7) * 24))}.${pad(Math.floor(rnd(i, 8) * 60))}.${pad(Math.floor(rnd(i, 9) * 60))}.png`
            : `IMG_${4000 + i}.jpg`;

        const collections = i % 9 === 0 ? ["refs"] : (i % 11 === 0 ? ["memes"] : []);

        items.push({
            id: i,
            path: `${folder}/${filename}`,
            filename,
            folder,
            width,
            height,
            mime: isScreenshot ? "image/png" : "image/jpeg",
            takenAt: undated ? null : localIso(d),
            dateSource: undated ? null : (isScreenshot ? "filename" : (i % 5 === 0 ? "mtime" : "exif")),
            takenMs,
            sizeBytes: Math.round(width * height * (isScreenshot ? 0.4 : 0.9) * (0.6 + rnd(i, 10))),
            isScreenshot,
            hasOcr: isScreenshot,
            ocrText: isScreenshot ? (OCR_SAMPLES[i % OCR_SAMPLES.length] as string) : null,
            snippet: null,
            isDupe: i % 7 === 3,
            collections,
            tags: [t1, t2],
        });
    }

    return items;
}
