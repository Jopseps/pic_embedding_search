import type { DateSource, GroupBy } from "./types";

export function fmtCount(n: number): string{
    return n.toLocaleString("en-US");
}

export function fmtEta(sec: number): string{
    if(!Number.isFinite(sec) || sec < 0){
        return "—";
    }
    if(sec < 60){
        return `${Math.round(sec)}s`;
    }
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${s}s`;
}

export function fmtGb(gb: number): string{
    if(gb < 0.01){
        return "0 MB";
    }
    if(gb < 1){
        return `${Math.round(gb * 1024)} MB`;
    }
    return `${gb.toFixed(1)} GB`;
}

/** A wire date, or null when it is missing or unparseable. The wire form is
 *  naive local wall-clock, which `new Date` reads as local — so everything
 *  below formats with local getters, never `toISOString`, which would shift a
 *  photo taken just after midnight onto the day before. */
function parse(iso: string | null): Date | null{
    if(iso === null){
        return null;
    }
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(iso: string | null): string{
    const d = parse(iso);
    if(d === null){
        return "—";
    }
    return d.toLocaleString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string | null): string{
    const d = parse(iso);
    if(d === null){
        return "—";
    }
    return d.toLocaleString("en-US", {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
}

/** "Taken" for a real capture date, "Modified" for one that is only the
 *  file's mtime — the lightbox does not pass a guess off as a fact. */
export function dateVerb(source: DateSource | null): string{
    return source === "mtime" ? "Modified" : "Taken";
}

export function monthLabel(iso: string | null): string{
    return groupLabel(iso, "month");
}

/** A date header. `Undated` sorts last, so it is always the final section. */
export function groupLabel(iso: string | null, by: GroupBy): string{
    const d = parse(iso);
    if(d === null){
        return "Undated";
    }
    if(by === "year"){
        return String(d.getFullYear());
    }
    if(by === "day"){
        return d.toLocaleString("en-US", {
            weekday: "short", day: "numeric", month: "long", year: "numeric",
        });
    }
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
}

/** `2026-05` → "May 2026", for the scrubber's bubble. */
export function monthKeyLabel(key: string): string{
    return groupLabel(`${key}-01T12:00:00`, "month");
}
