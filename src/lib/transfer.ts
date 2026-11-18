/**
 * Sizes, speeds and time-left for a download. Pure, and free of the store and
 * the api module, so the boot screen (which may import neither) can use it.
 */

export function fmtBytes(n: number): string{
    if(n >= 1024 ** 3){
        return `${(n / 1024 ** 3).toFixed(2)} GB`;
    }
    return `${Math.round(n / 1024 ** 2)} MB`;
}

export function fmtRate(bytesPerSec: number): string{
    return `${fmtBytes(bytesPerSec)}/s`;
}

/** "less than a minute", "about 3 min", "about 1 h 20 min". */
export function fmtTimeLeft(sec: number): string{
    if(sec < 60){
        return "less than a minute";
    }
    const min = Math.round(sec / 60);
    if(min < 90){
        return `about ${min} min`;
    }
    const rest = min % 60;
    return `about ${Math.floor(min / 60)} h${rest === 0 ? "" : ` ${rest} min`}`;
}

export interface Transfer{
    bytesPerSec: number;
    /** Null while the total is unknown. */
    etaSec: number | null;
}

/** Speed is measured over this long, so a stall or a burst does not make the
 *  time-left jump around. */
const WINDOW_MS = 10_000;
/** Too short a stretch says nothing about speed. */
const MIN_SPAN_MS = 1_500;

export class RateTracker{
    private samples: { t: number; done: number }[] = [];

    reset(): void{
        this.samples = [];
    }

    /** Record progress; returns the smoothed speed and time left, or null until
     *  there is enough history to say. */
    push(done: number, total: number, now: number = Date.now()): Transfer | null{
        const last = this.samples[this.samples.length - 1];
        if(last !== undefined && done < last.done){
            this.samples = [];   // a new transfer started
        }
        this.samples.push({ t: now, done });
        while(this.samples.length > 2 && (this.samples[1] as { t: number }).t <= now - WINDOW_MS){
            this.samples.shift();
        }
        const first = this.samples[0] as { t: number; done: number };
        const span = now - first.t;
        if(span < MIN_SPAN_MS || done <= first.done){
            return null;
        }
        const bytesPerSec = ((done - first.done) / span) * 1000;
        return {
            bytesPerSec,
            etaSec: total > done ? (total - done) / bytesPerSec : null,
        };
    }
}

/** "312 MB/s · about 3 min left", the second half only when known. */
export function fmtTransfer(t: Transfer): string{
    return t.etaSec === null
        ? fmtRate(t.bytesPerSec)
        : `${fmtRate(t.bytesPerSec)} · ${fmtTimeLeft(t.etaSec)} left`;
}
