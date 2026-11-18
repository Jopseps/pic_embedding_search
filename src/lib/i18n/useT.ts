import { useCallback } from "react";
import { useStore } from "../store";
import { translate, type MessageKey, type Params } from "./index";

/**
 * `t` bound to the language on screen. Components use this rather than the
 * global `t()`, because reading the language from the store is what makes them
 * re-render when it changes.
 */
export function useT(){
    const lang = useStore((s) => s.lang);
    return useCallback((key: MessageKey, params?: Params) => translate(key, params, lang), [lang]);
}
