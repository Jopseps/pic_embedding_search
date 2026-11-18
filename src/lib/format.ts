import { currentLocale, t } from "./i18n";
import type { DateSource, GroupBy } from "./types";

export function fmtCount(n: number): string{
    return n.toLocaleString(currentLocale());
}

/** `n` with exactly `digits` decimals, in the language's own separators. */
export function fmtDecimal(n: number, digits: number, minDigits: number = digits): string{
    return n.toLocaleString(currentLocale(), {
        minimumFractionDigits: minDigits,
        maximumFractionDigits: digits,
    });
}

export function fmtEta(sec: number): string{
    if(!Number.isFinite(sec) || sec < 0){
        return "—";
    }
    if(sec < 60){
        return t("format.seconds", { n: Math.round(sec) });
    }
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return t("format.minutesSeconds", { m, s });
}

export function fmtGb(gb: number): string{
    if(gb < 0.01){
        return t("format.megabytes", { n: 0 });
    }
    if(gb < 1){
        return t("format.megabytes", { n: fmtCount(Math.round(gb * 1024)) });
    }
    return t("format.gigabytes", { n: fmtDecimal(gb, 1) });
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
    return d.toLocaleString(currentLocale(), { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string | null): string{
    const d = parse(iso);
    if(d === null){
        return "—";
    }
    return d.toLocaleString(currentLocale(), {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
}

/** "Taken" for a real capture date, "Modified" for one that is only the
 *  file's mtime — the lightbox does not pass a guess off as a fact. */
export function dateLabel(source: DateSource | null, iso: string): string{
    return t(source === "mtime" ? "format.dateModifiedOn" : "format.dateTakenOn", { date: fmtDateTime(iso) });
}

export function monthLabel(iso: string | null): string{
    return groupLabel(iso, "month");
}

/** A date header. `Undated` sorts last, so it is always the final section. */
export function groupLabel(iso: string | null, by: GroupBy): string{
    const d = parse(iso);
    if(d === null){
        return t("format.undated");
    }
    if(by === "year"){
        return String(d.getFullYear());
    }
    if(by === "day"){
        return d.toLocaleString(currentLocale(), {
            weekday: "short", day: "numeric", month: "long", year: "numeric",
        });
    }
    return d.toLocaleString(currentLocale(), { month: "long", year: "numeric" });
}

/** `2026-05` → "May 2026", for the scrubber's bubble. */
export function monthKeyLabel(key: string): string{
    return groupLabel(`${key}-01T12:00:00`, "month");
}
