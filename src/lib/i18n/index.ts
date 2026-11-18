/**
 * Translation core. A message is a template with `{name}` placeholders; a key
 * is looked up in the table of the current language, and a missing Turkish
 * key falls back to English rather than showing a key name.
 *
 * Plurals: a template may hold two forms split by `|`, picked by `n` (English:
 * `n === 1` takes the first). Turkish does not pluralise after a number, so its
 * templates simply have one form and the picker returns it.
 *
 * No store, no api and no React in here: the setup screen (`Boot.tsx`) must be
 * able to use it before either exists.
 */

import type { LanguagePref } from "../types";
import { en } from "./en";
import { tr } from "./tr";

export type Lang = "en" | "tr";
export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
export type Params = Record<string, string | number>;

const TABLES: Record<Lang, Partial<Messages>> = { en, tr };

export const LANGUAGES: { code: Lang; label: string }[] = [
    { code: "en", label: "English" },
    { code: "tr", label: "Türkçe" },
];

/** What "automatic" means: the system language when it is one we have, else English. */
export function resolveLanguage(pref: LanguagePref, systemLanguage: string): Lang{
    if(pref === "en" || pref === "tr"){
        return pref;
    }
    return systemLanguage.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function systemLanguage(): string{
    return typeof navigator === "undefined" ? "en" : (navigator.language ?? "en");
}

/** The language `t()` answers in. Moved by the store when the setting does. */
let current: Lang = resolveLanguage("auto", systemLanguage());

export function setCurrentLanguage(lang: Lang): void{
    current = lang;
}

export function currentLanguage(): Lang{
    return current;
}

/** The BCP 47 tag numbers, sizes and dates are formatted with. */
export function currentLocale(): string{
    return current === "tr" ? "tr-TR" : "en-US";
}

export function translate(key: MessageKey, params?: Params, lang: Lang = current): string{
    let text = TABLES[lang][key] ?? en[key];
    if(text.includes("|") && params !== undefined && typeof params.n === "number"){
        const forms = text.split("|");
        text = forms[Math.min(params.n === 1 ? 0 : 1, forms.length - 1)] as string;
    }
    if(params === undefined){
        return text;
    }
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
        const value = params[name];
        return value === undefined ? whole : String(value);
    });
}

/** `t("sidebar.library")` in the current language. For code outside React. */
export function t(key: MessageKey, params?: Params): string{
    return translate(key, params);
}
