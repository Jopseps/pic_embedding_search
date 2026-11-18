import { describe, expect, it } from "vitest";
import { fmtBytes, fmtTimeLeft, fmtTransfer, RateTracker } from "./transfer";

const MB = 1024 ** 2;

describe("RateTracker", () => {
    it("says nothing until it has seen a couple of seconds", () => {
        const t = new RateTracker();
        expect(t.push(0, 100 * MB, 0)).toBeNull();
        expect(t.push(5 * MB, 100 * MB, 500)).toBeNull();
    });

    it("measures speed and time left", () => {
        const t = new RateTracker();
        t.push(0, 100 * MB, 0);
        const r = t.push(20 * MB, 100 * MB, 2000);
        expect(r?.bytesPerSec).toBe(10 * MB);
        expect(r?.etaSec).toBe(8);
    });

    it("smooths over a window, not the whole transfer", () => {
        const t = new RateTracker();
        t.push(0, 1000 * MB, 0);
        t.push(500 * MB, 1000 * MB, 5000);   // a fast start
        t.push(500 * MB, 1000 * MB, 14000);  // then a stall
        const r = t.push(500 * MB, 1000 * MB, 20000);
        expect(r).toBeNull();   // nothing moved in the last 10 s: no speed to quote
    });

    it("starts over when the numbers go backwards", () => {
        const t = new RateTracker();
        t.push(0, 100 * MB, 0);
        t.push(50 * MB, 100 * MB, 3000);
        expect(t.push(1 * MB, 100 * MB, 3500)).toBeNull();
    });

    it("has no time left when the total is unknown", () => {
        const t = new RateTracker();
        t.push(0, 0, 0);
        const r = t.push(10 * MB, 0, 2000);
        expect(r?.etaSec).toBeNull();
        expect(fmtTransfer(r!)).toBe("5 MB/s");
    });
});

describe("formatting", () => {
    it("writes sizes and times people read", () => {
        expect(fmtBytes(512 * MB)).toBe("512 MB");
        expect(fmtBytes(1.5 * 1024 ** 3)).toBe("1.50 GB");
        expect(fmtTimeLeft(20)).toBe("less than a minute");
        expect(fmtTimeLeft(180)).toBe("about 3 min");
        expect(fmtTimeLeft(4800)).toBe("about 80 min");
        expect(fmtTimeLeft(7500)).toBe("about 2 h 5 min");
        expect(fmtTimeLeft(7200)).toBe("about 2 h");
    });
});
