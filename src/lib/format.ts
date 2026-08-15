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

export function fmtDate(iso: string | null): string{
    if(iso === null){
        return "—";
    }
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())){
        return "—";
    }
    return d.toISOString().slice(0, 10);
}

export function monthLabel(iso: string | null): string{
    if(iso === null){
        return "Undated";
    }
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())){
        return "Undated";
    }
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
}
