/**
 * Is a font family actually installed on this machine?
 *
 * Nothing is bundled — a font the user picks either exists on the system or
 * silently falls back to the next family in the stack, and a picker that shows
 * "JetBrains Mono" selected while rendering DejaVu Sans Mono is lying. So the
 * setting is probed rather than assumed.
 *
 * `document.fonts.check` is the obvious API and it is not usable here: it
 * answers for the *font set of the document*, and engines disagree about
 * whether an uninstalled local family counts. Measuring does not — a family
 * that is not there resolves to the fallback and produces exactly the
 * fallback's width.
 */
const PROBE = "mmmmmmmmmmlliWWWWWWW0123";
const SIZE = "72px";
/** Two fallbacks with very different metrics: a family that happens to match
 *  one of them is unlikely to match the other. */
const FALLBACKS = ["monospace", "serif"];

/** Generic families are never "missing" — the engine always resolves them. */
const GENERIC = new Set([
    "monospace", "serif", "sans-serif", "cursive", "fantasy", "system-ui",
    "ui-monospace", "ui-sans-serif", "ui-serif", "ui-rounded",
]);

let cache: Map<string, boolean> | null = null;

/** First family of a CSS font stack, unquoted. */
export function primaryFamily(stack: string): string{
    const first = stack.split(",")[0] ?? "";
    return first.trim().replace(/^["']|["']$/g, "");
}

export function isFontAvailable(stack: string): boolean{
    const family = primaryFamily(stack);
    if(family === "" || GENERIC.has(family) || family.startsWith("-apple-system")
        || family === "BlinkMacSystemFont"){
        return true;
    }
    if(cache === null){
        cache = new Map();
    }
    const hit = cache.get(family);
    if(hit !== undefined){
        return hit;
    }
    const ctx = typeof document.createElement === "function"
        ? document.createElement("canvas").getContext("2d")
        : null;
    if(ctx === null){
        // jsdom, or a canvas-less environment. Claiming "missing" here would
        // paint every font in the picker with an install hint.
        return true;
    }
    const available = FALLBACKS.some((fallback) => {
        ctx.font = `${SIZE} ${fallback}`;
        const base = ctx.measureText(PROBE).width;
        ctx.font = `${SIZE} "${family}", ${fallback}`;
        return ctx.measureText(PROBE).width !== base;
    });
    cache.set(family, available);
    return available;
}
