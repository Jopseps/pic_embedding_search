import { describe, expect, it } from "vitest";
import { MockApi } from "./api";
import type { SearchQuery } from "./types";

/** The mock has to order and page the way the sidecar does, or the browser
 *  loop — where most UI work happens — shows an order the app never will. */
function query(overrides: Partial<SearchQuery> = {}): SearchQuery{
    return {
        q: "",
        view: null,
        collection: null,
        filters: { datePreset: null, dateFrom: null, dateTo: null, folders: [], types: [], dims: null },
        limit: 1000,
        ...overrides,
    };
}

describe("MockApi order", () => {
    it("browses newest first with undated photos last", async () => {
        const res = await new MockApi().search(query());
        const dates = res.items.map((p) => p.takenAt);
        const firstUndated = dates.indexOf(null);
        expect(firstUndated).toBeGreaterThan(0);
        expect(dates.slice(firstUndated).every((d) => d === null)).toBe(true);
        const dated = dates.slice(0, firstUndated) as string[];
        expect([...dated].sort().reverse()).toEqual(dated);
    });

    it("keeps undated photos last oldest-first too", async () => {
        const res = await new MockApi().search(query({ sort: "date-asc" }));
        expect(res.items.at(-1)?.takenAt).toBe(null);
        expect(res.items[0]?.takenAt).not.toBe(null);
    });

    it("keeps only the top matches when a query is re-sorted", async () => {
        const api = new MockApi();
        await api.putSettings({ sortedSearchKeep: 5 });
        const res = await api.search(query({ q: "a", sort: "name-asc" }));
        expect(res.total).toBeLessThanOrEqual(5);
    });

    it("filters an inclusive day range", async () => {
        const api = new MockApi();
        const all = (await api.search(query())).items;
        const day = (all[3]?.takenAt ?? "").slice(0, 10);
        const res = await api.search(query({
            filters: { ...query().filters, dateFrom: day, dateTo: day },
        }));
        expect(res.items.length).toBeGreaterThan(0);
        expect(res.items.every((p) => p.takenAt?.startsWith(day))).toBe(true);
    });

    it("counts months in grid order for the scrubber", async () => {
        const api = new MockApi();
        const t = await api.timeline(query());
        const months = t.buckets.map((b) => b.month);
        expect([...months].sort().reverse()).toEqual(months);
        expect(t.undated).toBeGreaterThan(0);
        expect((await api.timeline(query({ sort: "name-asc" }))).buckets).toEqual([]);
    });
});
