import { describe, expect, it } from "vitest";
import { buildMarks, markAt, markForIndex, yearTicks } from "./timeline";

const TIMELINE = {
    buckets: [
        { month: "2026-02", count: 4 },
        { month: "2026-01", count: 2 },
        { month: "2025-12", count: 4 },
    ],
    undated: 2,
};

describe("timeline marks", () => {
    it("lays months out by photo count, undated last", () => {
        const m = buildMarks(TIMELINE);
        expect(m.total).toBe(12);
        expect(m.marks.map((x) => [x.month, x.start])).toEqual([
            ["2026-02", 0], ["2026-01", 4], ["2025-12", 6], [null, 10],
        ]);
    });

    it("maps a rail position to the month under it", () => {
        const m = buildMarks(TIMELINE);
        expect(markAt(m, 0)?.month).toBe("2026-02");
        expect(markAt(m, 0.4)?.month).toBe("2026-01");
        expect(markAt(m, 0.99)?.month).toBe(null);
        // Past either end clamps rather than falling off the rail.
        expect(markAt(m, -1)?.month).toBe("2026-02");
        expect(markAt(m, 2)?.month).toBe(null);
    });

    it("finds the month a photo index is in", () => {
        const m = buildMarks(TIMELINE);
        expect(markForIndex(m, 5)?.month).toBe("2026-01");
        expect(markForIndex(m, 6)?.month).toBe("2025-12");
    });

    it("labels each year once, at its first month", () => {
        expect(yearTicks(buildMarks(TIMELINE))).toEqual([
            { year: "2026", fraction: 0 },
            { year: "2025", fraction: 0.5 },
        ]);
    });

    it("is empty for an empty timeline", () => {
        const m = buildMarks({ buckets: [], undated: 0 });
        expect(m.total).toBe(0);
        expect(markAt(m, 0.5)).toBe(null);
    });
});
