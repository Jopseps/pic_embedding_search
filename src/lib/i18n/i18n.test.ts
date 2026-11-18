import { describe, expect, it } from "vitest";
import { en } from "./en";
import { tr } from "./tr";
import { resolveLanguage, translate, type MessageKey } from "./index";

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(text: string): string[]{
    return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string).sort();
}

/** Each plural form, so `a|b` is checked form by form. */
function forms(text: string): string[]{
    return text.split("|");
}

describe("translation tables", () => {
    it("has no Turkish key the English file lacks", () => {
        const extra = Object.keys(tr).filter((k) => !(k in en));
        expect(extra).toEqual([]);
    });

    it("keeps every placeholder in a Turkish message", () => {
        const broken: string[] = [];
        for(const [key, text] of Object.entries(tr)){
            const source = en[key as MessageKey];
            if(source === undefined){
                continue;
            }
            const wanted = new Set(forms(source).flatMap(placeholders));
            // Every form may drop `n` (it only picks the form) but must keep the rest.
            for(const form of forms(text as string)){
                const have = new Set(placeholders(form));
                for(const name of wanted){
                    if(name !== "n" && !have.has(name)){
                        broken.push(`${key}: missing {${name}}`);
                    }
                }
                for(const name of have){
                    if(!wanted.has(name)){
                        broken.push(`${key}: unknown {${name}}`);
                    }
                }
            }
        }
        expect(broken).toEqual([]);
    });

    it("has no empty messages", () => {
        const empty = [...Object.entries(en), ...Object.entries(tr)]
            .filter(([, v]) => (v as string).trim() === "")
            .map(([k]) => k);
        expect(empty).toEqual([]);
    });

    it("keeps the same plural shape in both languages' English source pairs", () => {
        // An English pair `a|b` must give both forms the same placeholders.
        const bad = Object.entries(en)
            .filter(([, v]) => v.includes("|"))
            .filter(([, v]) => {
                const [a, b] = v.split("|") as [string, string];
                return placeholders(a).join() !== placeholders(b).join();
            })
            .map(([k]) => k);
        expect(bad).toEqual([]);
    });
});

describe("translate", () => {
    it("fills placeholders and leaves unknown ones visible", () => {
        expect(translate("folders.stopWatching", { path: "/a" }, "en")).toBe("Stop watching /a");
        expect(translate("folders.stopWatching", {}, "en")).toBe("Stop watching {path}");
    });

    it("picks the plural form from n", () => {
        expect(translate("trash.title", { n: 1 }, "en")).toBe("Move 1 photo to the trash?");
        expect(translate("trash.title", { n: 3 }, "en")).toBe("Move 3 photos to the trash?");
    });

    it("falls back to English for a key Turkish does not have yet", () => {
        const key = "trash.cancel" as MessageKey;
        const saved = tr[key];
        delete tr[key];
        try{
            expect(translate(key, undefined, "tr")).toBe("Cancel");
        }finally{
            if(saved !== undefined){
                tr[key] = saved;
            }
        }
    });
});

describe("resolveLanguage", () => {
    it("follows the system for automatic, and obeys a pinned language", () => {
        expect(resolveLanguage("auto", "tr-TR")).toBe("tr");
        expect(resolveLanguage("auto", "en-GB")).toBe("en");
        expect(resolveLanguage("auto", "de-DE")).toBe("en");
        expect(resolveLanguage("en", "tr-TR")).toBe("en");
        expect(resolveLanguage("tr", "en-US")).toBe("tr");
    });
});
