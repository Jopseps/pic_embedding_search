import { memo, useEffect, useMemo, useState } from "react";
import { useStore } from "../lib/store";
import {
    ACCENT_PRESETS,
    CELL_RADII,
    DRAG_SLOP_RANGE,
    EMBEDDING_MODELS,
    FONTS,
    GROUP_BY_OPTIONS,
    HOLD_TIMES,
    OCR_ENGINES,
    OCR_LANGUAGES,
    PAGE_SIZES,
    SEARCH_DEBOUNCE_RANGE,
    SELECTION_BORDERS,
    SORTED_SEARCH_KEEPS,
    SORT_OPTIONS,
    TINT_PRESETS,
    UI_SCALES,
    accentPresetFor,
    modelById,
    tintPresetFor,
} from "../lib/catalog";
import { fmtCount, fmtDecimal, fmtEta, fmtGb } from "../lib/format";
import { isFontAvailable } from "../lib/fontProbe";
import { isMockMode } from "../lib/api";
import { fmtBytes, fmtTransfer } from "../lib/transfer";
import { currentLocale, LANGUAGES, type MessageKey } from "../lib/i18n";
import { useT } from "../lib/i18n/useT";
import { Box, Button, Chip, Radio, Slider, Toggle } from "./ui";
import type { Density, SortKey, ThemePref } from "../lib/types";

/** Embed-only throughput on the reference GPU (RTX 4070 laptop). Used for the
 *  pre-flight estimate only — the live panel shows the measured rate. */
const PREFLIGHT_IMG_PER_SEC = 25;

const THEMES: ThemePref[] = ["dark", "light", "system"];
const DENSITIES: { v: Density; label: MessageKey }[] = [
    { v: 0, label: "density.compact" },
    { v: 1, label: "density.comfortable" },
    { v: 2, label: "density.large" },
];

type SectionId =
    | "folders" | "model" | "ocr" | "search" | "order" | "appearance" | "accessibility"
    | "gestures" | "shortcuts" | "storage";

/**
 * The nav rail, and the index the filter box searches. `keywords` exists
 * because the words a user types are not the words on the headings — "dark",
 * "font" and "zoom" all have to find something, and matching only on titles
 * makes the box look broken the first time it is used.
 */
const SECTIONS: { id: SectionId; label: MessageKey; keywords: MessageKey }[] = [
    { id: "folders", label: "settings.section.folders", keywords: "settings.keywords.folders" },
    { id: "model", label: "settings.section.model", keywords: "settings.keywords.model" },
    { id: "ocr", label: "settings.section.ocr", keywords: "settings.keywords.ocr" },
    { id: "search", label: "settings.section.search", keywords: "settings.keywords.search" },
    { id: "order", label: "settings.section.order", keywords: "settings.keywords.order" },
    { id: "appearance", label: "settings.section.appearance", keywords: "settings.keywords.appearance" },
    { id: "accessibility", label: "settings.section.accessibility", keywords: "settings.keywords.accessibility" },
    { id: "gestures", label: "settings.section.gestures", keywords: "settings.keywords.gestures" },
    { id: "shortcuts", label: "settings.section.shortcuts", keywords: "settings.keywords.shortcuts" },
    { id: "storage", label: "settings.section.storage", keywords: "settings.keywords.storage" },
];

function matchesFilter(section: { label: string; keywords: string }, q: string): boolean{
    const locale = currentLocale();
    const needle = q.trim().toLocaleLowerCase(locale);
    if(needle === ""){
        return true;
    }
    const hay = `${section.label} ${section.keywords}`.toLocaleLowerCase(locale);
    // Every word has to hit something, so "font size" narrows rather than
    // widening the way an any-word match would.
    return needle.split(/\s+/).every((word) => hay.includes(word));
}

export const SettingsView = memo(function SettingsView(){
    const t = useT();
    const setView = useStore((s) => s.setView);
    const loadStorage = useStore((s) => s.loadStorage);
    const [active, setActive] = useState<SectionId>("folders");
    const [filter, setFilter] = useState("");

    useEffect(() => {
        void loadStorage();
    }, [loadStorage]);

    const hits = useMemo(
        () => SECTIONS.filter((s) => matchesFilter({ label: t(s.label), keywords: t(s.keywords) }, filter)),
        [filter, t],
    );
    // A filter shows everything it matched, in nav order; with the box empty
    // the rail is a tab bar. One section at a time is what makes the rail worth
    // having — scroll-spy over one long page just moves the scrolling around.
    const searching = filter.trim() !== "";
    const shown = searching ? hits.map((s) => s.id) : [active];

    return (
        <div className="flex min-w-0 flex-1 overflow-hidden">
            <nav className="flex w-[calc(196px*var(--ui-scale))] flex-shrink-0 flex-col gap-1 overflow-y-auto border-r border-edge bg-panel px-3 py-[calc(14px*var(--ui-scale))]">
                <button
                    type="button"
                    onClick={() => setView("library")}
                    className="mb-2 cursor-pointer rounded-md px-2 py-[calc(6px*var(--ui-scale))] text-left text-[calc(12.5px*var(--ui-scale))] text-fg-dim hover:bg-hover hover:text-fg"
                >
                    {t("settings.back")}
                </button>

                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t("settings.filterPlaceholder")}
                    aria-label={t("settings.filterAria")}
                    className="mb-2 w-full rounded-md border border-edge bg-raised px-2 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
                />

                {SECTIONS.map((s) => {
                    const hit = hits.some((h) => h.id === s.id);
                    const on = searching ? hit : active === s.id;
                    return (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                                setFilter("");
                                setActive(s.id);
                            }}
                            aria-current={on ? "page" : undefined}
                            className={
                                "cursor-pointer rounded-md px-2 py-[calc(7px*var(--ui-scale))] text-left text-[calc(12.5px*var(--ui-scale))] transition-colors " +
                                (on
                                    ? "bg-accent-muted text-accent-text"
                                    : searching
                                        ? "text-fg-faint hover:bg-hover"
                                        : "text-fg-dim hover:bg-hover hover:text-fg")
                            }
                        >
                            {t(s.label)}
                        </button>
                    );
                })}
            </nav>

            <div className="min-w-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-[calc(640px*var(--ui-scale))] px-6 pt-7 pb-20">
                    {isMockMode ? (
                        <div className="mb-7 rounded-lg border border-edge bg-raised p-3 text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-dim">
                            {t("settings.mockNotice")}
                        </div>
                    ) : null}

                    {searching && shown.length === 0 ? (
                        <div className="text-[calc(12.5px*var(--ui-scale))] text-fg-faint">
                            {t("settings.noMatch", { filter })}
                        </div>
                    ) : null}

                    {shown.includes("folders") ? <FoldersSection /> : null}
                    {shown.includes("model") ? <ModelSection /> : null}
                    {shown.includes("ocr") ? <OcrSection /> : null}
                    {shown.includes("search") ? <SearchSection /> : null}
                    {shown.includes("order") ? <OrderSection /> : null}
                    {shown.includes("appearance") ? <AppearanceSection /> : null}
                    {shown.includes("accessibility") ? <AccessibilitySection /> : null}
                    {shown.includes("gestures") ? <GestureSection /> : null}
                    {shown.includes("shortcuts") ? <ShortcutsSection /> : null}
                    {shown.includes("storage") ? <StorageSection /> : null}
                </div>
            </div>
        </div>
    );
});

function Group(props: { title: string; hint?: string; children: React.ReactNode }){
    return (
        <div className="mb-8">
            <div className="mb-[calc(3px*var(--ui-scale))] text-[calc(13px*var(--ui-scale))] font-semibold">{props.title}</div>
            {props.hint !== undefined ? (
                <div className="mb-3 text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-faint">{props.hint}</div>
            ) : null}
            {props.children}
        </div>
    );
}

function FoldersSection(){
    const t = useT();
    const folders = useStore((s) => s.folders);
    const toggleRecursive = useStore((s) => s.toggleRecursive);
    const removeFolder = useStore((s) => s.removeFolder);
    const confirming = useStore((s) => s.removeFolderConfirm);
    const requestRemove = useStore((s) => s.requestRemoveFolder);
    const cancelRemove = useStore((s) => s.cancelRemoveFolder);
    const addFolder = useStore((s) => s.addFolder);

    return (
        <Group
            title={t("folders.title")}
            hint={t("folders.hint")}
        >
            {folders.map((f) => (
                <div key={f.path} className="flex items-center gap-[calc(10px*var(--ui-scale))] border-b border-edge py-[calc(10px*var(--ui-scale))]">
                    <div className="min-w-0 flex-1">
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[calc(12.5px*var(--ui-scale))]">
                            {f.path}
                        </div>
                        <div className="mt-[calc(2px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] text-fg-faint">
                            {t("folders.imageCount", { n: f.count, count: fmtCount(f.count) })}
                        </div>
                    </div>
                    {confirming === f.path ? (
                        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">
                            <span className="max-w-[calc(260px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg-dim">
                                {t("folders.removeQuestion", { n: f.count, count: fmtCount(f.count) })}
                            </span>
                            <button
                                type="button"
                                onClick={() => void removeFolder(f.path)}
                                className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border-none bg-danger px-3 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-white hover:opacity-90"
                            >
                                {t("folders.remove")}
                            </button>
                            <button
                                type="button"
                                autoFocus
                                onClick={cancelRemove}
                                className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-3 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg hover:bg-hover"
                            >
                                {t("folders.cancel")}
                            </button>
                        </div>
                    ) : (
                        <>
                            <Toggle
                                label={t("folders.recursive")}
                                on={f.recursive}
                                onClick={() => void toggleRecursive(f.path)}
                            />
                            <button
                                type="button"
                                onClick={() => requestRemove(f.path)}
                                aria-label={t("folders.stopWatching", { path: f.path })}
                                title={t("folders.stopWatchingTitle")}
                                className="flex-shrink-0 cursor-pointer px-1 py-[calc(2px*var(--ui-scale))] text-[calc(14px*var(--ui-scale))] text-fg-faint hover:text-danger"
                            >
                                ✕
                            </button>
                        </>
                    )}
                </div>
            ))}
            <Button onClick={() => void addFolder()} className="mt-3">{t("folders.add")}</Button>
        </Group>
    );
}

/** Outline trash can in the button's own colour, so it turns red with the text. */
function TrashIcon(){
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-[calc(14px*var(--ui-scale))] w-[calc(14px*var(--ui-scale))]"
        >
            <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6L12 4M6.5 6.5v4M9.5 6.5v4" />
        </svg>
    );
}

function ModelSection(){
    const t = useT();
    const modelId = useStore((s) => s.settings.modelId);
    const pendingId = useStore((s) => s.pendingModelId);
    const reindex = useStore((s) => s.reindex);
    const select = useStore((s) => s.selectModel);
    const confirm = useStore((s) => s.confirmModelChange);
    const cancel = useStore((s) => s.cancelModelChange);
    // The library size, not `indexing.total` — that is 0 unless a scan happens
    // to be running, so the warning used to read "~1 minutes for 0 images".
    const libraryTotal = useStore((s) => s.counts.library);
    const activeName = useStore((s) => modelById(s.settings.modelId)?.name ?? s.settings.modelId);
    const files = useStore((s) => s.models);
    const download = useStore((s) => s.modelDownload);
    const deletingId = useStore((s) => s.deletingModelId);
    const loadModels = useStore((s) => s.loadModels);
    const fetchModel = useStore((s) => s.downloadModel);
    const askDelete = useStore((s) => s.askDeleteModel);
    const cancelDelete = useStore((s) => s.cancelDeleteModel);
    const confirmDelete = useStore((s) => s.confirmDeleteModel);

    useEffect(() => {
        void loadModels();
    }, [loadModels]);

    const deleting = deletingId === null ? null : (modelById(deletingId) ?? null);
    const deletingSize = deletingId === null ? 0 : (files[deletingId]?.sizeBytes ?? 0);
    // One download at a time, and none while a swap is moving vectors.
    const busy = download !== null || reindex.active;

    const pending = pendingId === null ? null : (modelById(pendingId) ?? null);
    // A pre-flight guess only: nothing has been measured yet. Once batches land
    // the panel below switches to the rate the sidecar actually reports.
    const etaMin = Math.max(1, Math.round(libraryTotal / PREFLIGHT_IMG_PER_SEC / 60));

    return (
        <Group
            title={t("models.title")}
            hint={t("models.hint")}
        >
            {EMBEDDING_MODELS.map((m) => {
                const selected = m.id === modelId;
                const info = files[m.id];
                const downloading = download !== null && download.modelId === m.id;
                const inUse = selected || m.id === pendingId || info?.pending === true;
                const fraction = downloading && download.total > 0
                    ? Math.min(1, download.done / download.total)
                    : null;
                return (
                    <div
                        key={m.id}
                        className={
                            "mb-[calc(6px*var(--ui-scale))] rounded-lg border px-3 py-[calc(11px*var(--ui-scale))] transition-colors " +
                            (selected
                                ? "border-accent bg-accent-muted"
                                : "border-edge bg-raised")
                        }
                    >
                        <div className="flex items-center gap-[calc(10px*var(--ui-scale))]">
                            <button
                                type="button"
                                onClick={() => select(m.id)}
                                disabled={reindex.active}
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-[calc(10px*var(--ui-scale))] border-none bg-transparent p-0 text-left text-fg disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                <Radio selected={selected} />
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 text-[calc(13px*var(--ui-scale))] font-medium">
                                        {m.name}
                                        {!m.multilingual ? (
                                            <span
                                                title={t("models.enOnlyTitle")}
                                                className="rounded bg-hover px-[calc(5px*var(--ui-scale))] py-px text-[calc(10px*var(--ui-scale))] font-normal text-fg-faint"
                                            >
                                                {t("models.enOnly")}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="mt-px text-[calc(11.5px*var(--ui-scale))] text-fg-faint">{t(m.desc)}</div>
                                    {info !== undefined ? (
                                        <div className="mt-px text-[calc(11.5px*var(--ui-scale))] text-fg-dim">
                                            {info.downloaded
                                                ? t(selected ? "models.statusInUse" : "models.statusDownloaded", { size: fmtBytes(info.sizeBytes) })
                                                : t("models.notDownloaded")}
                                        </div>
                                    ) : null}
                                </div>
                            </button>
                            {info !== undefined && !downloading ? (
                                info.downloaded ? (
                                    <button
                                        type="button"
                                        onClick={() => askDelete(m.id)}
                                        disabled={inUse || busy}
                                        title={t(inUse ? "models.deleteTitleInUse" : "models.deleteTitle")}
                                        className="flex flex-shrink-0 cursor-pointer items-center gap-[calc(6px*var(--ui-scale))] rounded-[calc(7px*var(--ui-scale))] border border-danger bg-danger-muted px-[calc(12px*var(--ui-scale))] py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-danger hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40"
                                    >
                                        <TrashIcon />
                                        {t("models.delete")}
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => void fetchModel(m.id)}
                                        disabled={busy}
                                        className="flex-shrink-0 cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-[calc(12px*var(--ui-scale))] py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                                    >
                                        {t("models.download")}
                                    </button>
                                )
                            ) : null}
                        </div>
                        {downloading ? (
                            <div className="mt-[calc(10px*var(--ui-scale))]">
                                <div className="mb-[calc(6px*var(--ui-scale))] flex justify-between text-[calc(11.5px*var(--ui-scale))] tabular-nums text-fg-dim">
                                    <span>
                                        {fraction !== null
                                            ? t("models.downloadingPercent", { percent: Math.round(fraction * 100) })
                                            : t("models.downloading")}
                                    </span>
                                    <span className="text-fg-faint">
                                        {download.total > 0 ? t("format.bytesOf", { done: fmtBytes(download.done), total: fmtBytes(download.total) }) : fmtBytes(download.done)}
                                    </span>
                                </div>
                                <div className="relative h-[calc(6px*var(--ui-scale))] overflow-hidden rounded-full bg-hover">
                                    {fraction !== null ? (
                                        <div
                                            className="h-full rounded-full bg-accent transition-[width] duration-300"
                                            style={{ width: `${fraction * 100}%` }}
                                        />
                                    ) : (
                                        <div
                                            className="absolute inset-y-0 w-[15%] rounded-full bg-accent"
                                            style={{ animation: "shimmer 1.3s linear infinite" }}
                                        />
                                    )}
                                </div>
                                {download.transfer !== null ? (
                                    <div className="mt-[calc(6px*var(--ui-scale))] text-right text-[calc(11.5px*var(--ui-scale))] tabular-nums text-fg-faint">
                                        {fmtTransfer(download.transfer)}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                );
            })}

            {deleting !== null ? (
                <div className="mt-[calc(10px*var(--ui-scale))] rounded-lg border border-edge bg-danger-muted p-[calc(14px*var(--ui-scale))]">
                    <div className="mb-1 text-[calc(12.5px*var(--ui-scale))] font-semibold text-fg">
                        {t("models.deleteQuestion", { name: deleting.name })}
                    </div>
                    <div className="mb-[calc(10px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-dim">
                        {t("models.deleteBody", { size: fmtBytes(deletingSize) })}
                    </div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => void confirmDelete()}
                            className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border-none bg-danger px-[calc(14px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-white hover:opacity-90"
                        >
                            {t("models.deleteFiles")}
                        </button>
                        <button
                            type="button"
                            onClick={cancelDelete}
                            className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-[calc(14px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg hover:bg-hover"
                        >
                            {t("common.cancel")}
                        </button>
                    </div>
                </div>
            ) : null}

            {pending !== null && !reindex.active ? (
                <div className="mt-[calc(10px*var(--ui-scale))] rounded-lg border border-edge bg-danger-muted p-[calc(14px*var(--ui-scale))]">
                    <div className="mb-1 text-[calc(12.5px*var(--ui-scale))] font-semibold text-fg">{t("models.reindexTitle")}</div>
                    <div className="mb-[calc(10px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-dim">
                        {t("models.reindexBody", { name: pending.name, n: etaMin, minutes: etaMin, count: fmtCount(libraryTotal) })}{" "}
                        <span className="text-fg">{t("models.searchKeepsWorking")}</span>{" "}
                        {t("models.activeAnswers", { active: activeName })}
                    </div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={confirm}
                            className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border-none bg-danger px-[calc(14px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-white hover:opacity-90"
                        >
                            {t("models.reindexNow")}
                        </button>
                        <button
                            type="button"
                            onClick={cancel}
                            className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-[calc(14px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg hover:bg-hover"
                        >
                            {t("common.cancel")}
                        </button>
                    </div>
                </div>
            ) : null}

            {reindex.active ? (
                <div className="mt-[calc(10px*var(--ui-scale))] rounded-lg border border-edge bg-raised p-[calc(14px*var(--ui-scale))]">
                    <div className="mb-2 text-[calc(12.5px*var(--ui-scale))] text-fg">
                        {download !== null ? (
                            t("models.waitingDownload", { model: reindex.modelName })
                        ) : (
                            <>
                                {t("models.reindexing", { model: reindex.modelName, percent: Math.round(reindex.progress) })}
                                {reindex.total > 0 ? (
                                    <span className="text-fg-faint">
                                        {" "}({fmtCount(reindex.current)} / {fmtCount(reindex.total)})
                                    </span>
                                ) : null}
                            </>
                        )}
                    </div>
                    <div className="mb-2 h-[calc(6px*var(--ui-scale))] overflow-hidden rounded-[calc(3px*var(--ui-scale))] bg-hover">
                        <div
                            className="h-full bg-accent transition-[width]"
                            style={{ width: `${reindex.progress}%` }}
                        />
                    </div>
                    {/* Not "unavailable": the outgoing model keeps every vector
                        it had until the incoming one has full coverage. */}
                    <div className="text-[calc(11.5px*var(--ui-scale))] text-fg-faint">
                        {t("models.stillSearching", { active: activeName })}
                        {reindex.rate > 0
                            ? ` · ${t("models.rateEta", { rate: fmtDecimal(reindex.rate, 1), time: fmtEta(reindex.etaSec) })}`
                            : ""}
                    </div>
                </div>
            ) : null}
        </Group>
    );
}

function OcrSection(){
    const t = useT();
    const engineId = useStore((s) => s.settings.ocrEngineId);
    const langs = useStore((s) => s.settings.ocrLangs);
    const setEngine = useStore((s) => s.setOcrEngine);
    const toggleLang = useStore((s) => s.toggleOcrLang);
    const status = useStore((s) => s.ocrStatus);
    const loadOcrStatus = useStore((s) => s.loadOcrStatus);
    const refreshOcr = useStore((s) => s.refreshOcr);
    const showToast = useStore((s) => s.showToast);
    const [openCommand, setOpenCommand] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);

    useEffect(() => {
        void loadOcrStatus();
    }, [loadOcrStatus]);

    const checkAgain = async () => {
        setChecking(true);
        await refreshOcr();
        setChecking(false);
    };
    const copy = (text: string) => {
        void copyText(text).then((ok) => showToast(t(ok ? "ocr.copied" : "ocr.copyFailed")));
    };
    const missingLangs = status?.missingLangs ?? {};
    // Language data only matters to tesseract; the other engines bring their own.
    const tesseract = engineId === "tesseract";
    const langCommand = tesseract
        ? langs.filter((c) => missingLangs[c] !== undefined).map((c) => missingLangs[c]).join(" && ")
        : "";

    return (
        <Group
            title={t("ocr.title")}
            hint={t("ocr.hint")}
        >
            {OCR_ENGINES.map((e) => {
                const selected = e.id === engineId;
                const info = status?.engines.find((x) => x.id === e.id);
                const command = info?.command ?? null;
                const showing = openCommand === e.id && command !== null;
                return (
                    <div
                        key={e.id}
                        className={
                            "mb-[calc(6px*var(--ui-scale))] rounded-lg border px-3 py-[calc(11px*var(--ui-scale))] transition-colors " +
                            (selected ? "border-accent bg-accent-muted" : "border-edge bg-raised")
                        }
                    >
                        <div className="flex items-center gap-[calc(10px*var(--ui-scale))]">
                            <button
                                type="button"
                                onClick={() => setEngine(e.id)}
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-[calc(10px*var(--ui-scale))] border-none bg-transparent p-0 text-left text-fg"
                            >
                                <Radio selected={selected} />
                                <div className="min-w-0">
                                    <div className="text-[calc(13px*var(--ui-scale))] font-medium">{e.label}</div>
                                    <div className="mt-px text-[calc(11.5px*var(--ui-scale))] text-fg-faint">{t(e.desc)}</div>
                                    {info !== undefined ? (
                                        <div className="mt-px text-[calc(11.5px*var(--ui-scale))] text-fg-dim">
                                            {info.installed
                                                ? t(selected ? "ocr.statusInUse" : "ocr.statusInstalled")
                                                : t(selected ? "ocr.statusSelectedMissing" : "ocr.statusMissing")}
                                        </div>
                                    ) : null}
                                </div>
                            </button>
                            {command !== null ? (
                                <button
                                    type="button"
                                    onClick={() => setOpenCommand(showing ? null : e.id)}
                                    className="flex-shrink-0 cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-[calc(12px*var(--ui-scale))] py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg hover:bg-hover"
                                >
                                    {t(showing ? "ocr.hideInstall" : "ocr.howToInstall")}
                                </button>
                            ) : null}
                        </div>
                        {showing ? (
                            <CommandBox
                                command={command}
                                note={t(e.id === "tesseract" ? "ocr.installNoteSystem" : "ocr.installNotePython")}
                                checking={checking}
                                onCopy={() => copy(command)}
                                onCheck={() => void checkAgain()}
                            />
                        ) : null}
                    </div>
                );
            })}

            <div className="mt-[calc(14px*var(--ui-scale))] mb-2 text-[calc(11.5px*var(--ui-scale))] text-fg-faint">{t("ocr.languages")}</div>
            <div className="flex flex-wrap gap-2">
                {OCR_LANGUAGES.map((l) => {
                    const on = langs.includes(l.code);
                    const missing = tesseract ? missingLangs[l.code] : undefined;
                    return (
                        <button
                            key={l.code}
                            type="button"
                            onClick={() => toggleLang(l.code)}
                            title={missing === undefined ? undefined : t("ocr.langMissingTitle", { command: missing })}
                            className={
                                "flex cursor-pointer items-center gap-[calc(6px*var(--ui-scale))] rounded-lg border px-[calc(10px*var(--ui-scale))] py-[calc(6px*var(--ui-scale))] transition-colors " +
                                (on ? "border-accent bg-accent-muted" : "border-edge bg-raised hover:bg-hover")
                            }
                        >
                            <Box checked={on} />
                            <span className="text-[calc(12px*var(--ui-scale))]">{t(l.label)}</span>
                            {missing !== undefined ? (
                                <span className="text-[calc(10.5px*var(--ui-scale))] text-danger">{t("ocr.langMissing")}</span>
                            ) : null}
                        </button>
                    );
                })}
            </div>
            {/* The commands for checked languages without data, so the warning is actionable. */}
            {langCommand !== "" ? (
                <CommandBox
                    command={langCommand}
                    note={t("ocr.langNote")}
                    checking={checking}
                    onCopy={() => copy(langCommand)}
                    onCheck={() => void checkAgain()}
                />
            ) : null}
        </Group>
    );
}

/** An install command the user runs themselves, with Copy and "Check again". */
function CommandBox(props: { command: string; note: string; checking: boolean; onCopy: () => void; onCheck: () => void }){
    const t = useT();
    return (
        <div className="mt-[calc(10px*var(--ui-scale))]">
            <div className="flex items-center gap-2 rounded-[calc(7px*var(--ui-scale))] border border-edge bg-panel px-[calc(10px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))]">
                <code data-selectable className="min-w-0 flex-1 break-all font-mono text-[calc(11.5px*var(--ui-scale))] text-fg">
                    {props.command}
                </code>
                <button
                    type="button"
                    onClick={props.onCopy}
                    className="flex-shrink-0 cursor-pointer rounded-[calc(6px*var(--ui-scale))] border border-edge px-[calc(9px*var(--ui-scale))] py-[calc(3px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] text-fg hover:bg-hover"
                >
                    {t("ocr.copy")}
                </button>
            </div>
            <div className="mt-[calc(6px*var(--ui-scale))] flex items-center justify-between gap-3">
                <span className="text-[calc(11.5px*var(--ui-scale))] text-fg-faint">{props.note}</span>
                <button
                    type="button"
                    onClick={props.onCheck}
                    disabled={props.checking}
                    className="flex-shrink-0 cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-[calc(12px*var(--ui-scale))] py-[calc(5px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg hover:bg-hover disabled:cursor-wait disabled:opacity-60"
                >
                    {t(props.checking ? "ocr.checking" : "ocr.checkAgain")}
                </button>
            </div>
        </div>
    );
}

/** The async clipboard API, then the old selection copy WebKitGTK still honours. */
async function copyText(text: string): Promise<boolean>{
    try{
        await navigator.clipboard.writeText(text);
        return true;
    }catch{
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
    }
}

function Label(props: { children: React.ReactNode }){
    return (
        <div className="mb-[calc(6px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] tracking-[0.05em] text-fg-faint">
            {props.children}
        </div>
    );
}

/** One accent choice: the colour itself, at the lightness and chroma the dark
 *  theme uses, so the row of them reads as the palette it actually is. */
function Swatch(props: { hue: number; active: boolean; label: string; onClick: () => void }){
    return (
        <button
            type="button"
            onClick={props.onClick}
            aria-label={props.label}
            aria-pressed={props.active}
            title={props.label}
            className={
                "flex h-[calc(26px*var(--ui-scale))] w-[calc(26px*var(--ui-scale))] cursor-pointer items-center justify-center rounded-full border-2 transition-colors " +
                (props.active ? "border-fg" : "border-transparent hover:border-edge")
            }
        >
            <span
                className="block h-[calc(18px*var(--ui-scale))] w-[calc(18px*var(--ui-scale))] rounded-full"
                style={{ background: `oklch(68% 0.15 ${props.hue})` }}
            />
        </button>
    );
}

function ColourSection(){
    const t = useT();
    const accentHue = useStore((s) => s.settings.accentHue);
    const tintHue = useStore((s) => s.settings.tintHue);
    const tintStrength = useStore((s) => s.settings.tintStrength);
    const set = useStore((s) => s.setSetting);
    const activeAccent = accentPresetFor(accentHue);
    const activeTint = tintPresetFor(tintHue, tintStrength);

    return (
        <>
            <Label>{t("colour.accent")}</Label>
            <div className="mb-[calc(8px*var(--ui-scale))] flex flex-wrap gap-[calc(6px*var(--ui-scale))]">
                {ACCENT_PRESETS.map((a) => (
                    <Swatch
                        key={a.id}
                        hue={a.hue}
                        label={t(a.label)}
                        active={activeAccent === a.id}
                        onClick={() => set("accentHue", a.hue)}
                    />
                ))}
            </div>
            <div className="mb-5">
                <Slider
                    label={t("colour.accentHue")}
                    value={accentHue}
                    min={0}
                    max={359}
                    readout={`${accentHue}°`}
                    onChange={(v) => set("accentHue", v)}
                />
                <div className="mt-[calc(6px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                    {t("colour.accentNote")}
                </div>
            </div>

            <Label>{t("colour.tint")}</Label>
            <div className="mb-[calc(8px*var(--ui-scale))] flex flex-wrap gap-[calc(6px*var(--ui-scale))]">
                {TINT_PRESETS.map((tp) => (
                    <Chip
                        key={tp.id}
                        label={t(tp.label)}
                        active={activeTint === tp.id}
                        onClick={() => {
                            set("tintHue", tp.hue);
                            set("tintStrength", tp.strength);
                        }}
                    />
                ))}
            </div>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label={t("colour.tintHue")}
                    value={tintHue}
                    min={0}
                    max={359}
                    readout={`${tintHue}°`}
                    onChange={(v) => set("tintHue", v)}
                />
            </div>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label={t("colour.tintStrength")}
                    value={tintStrength}
                    min={0}
                    max={300}
                    step={10}
                    readout={t("unit.percent", { n: tintStrength })}
                    onChange={(v) => set("tintStrength", v)}
                />
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("colour.tintNote")}
            </div>
        </>
    );
}

function GridLookSection(){
    const t = useT();
    const selectionBorder = useStore((s) => s.settings.selectionBorder);
    const cellRadius = useStore((s) => s.settings.cellRadius);
    const set = useStore((s) => s.setSetting);

    return (
        <>
            <Label>{t("grid.selectionBorder")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {SELECTION_BORDERS.map((b) => (
                    <Chip
                        key={b.v}
                        label={t(b.label)}
                        active={selectionBorder === b.v}
                        onClick={() => set("selectionBorder", b.v)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("grid.selectionBorderNote")}
            </div>

            <Label>{t("grid.photoCorners")}</Label>
            <div className="mb-5 flex gap-[calc(6px*var(--ui-scale))]">
                {CELL_RADII.map((r) => (
                    <Chip
                        key={r.v}
                        label={t(r.label)}
                        active={cellRadius === r.v}
                        onClick={() => set("cellRadius", r.v)}
                    />
                ))}
            </div>
        </>
    );
}

function SearchSection(){
    const t = useT();
    const pageSize = useStore((s) => s.settings.pageSize);
    const debounce = useStore((s) => s.settings.searchDebounceMs);
    const textWeight = useStore((s) => s.settings.textWeight);
    const strictness = useStore((s) => s.settings.matchStrictness);
    const set = useStore((s) => s.setSetting);

    return (
        <Group
            title={t("search.title")}
            hint={t("search.hint")}
        >
            <Label>{t("search.resultsPerQuery")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {PAGE_SIZES.map((n) => (
                    <Chip
                        key={n}
                        label={String(n)}
                        active={pageSize === n}
                        onClick={() => set("pageSize", n)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("search.resultsNote")}
            </div>

            <Label>{t("search.typingDelay")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label={t("search.debounce")}
                    value={debounce}
                    min={SEARCH_DEBOUNCE_RANGE.min}
                    max={SEARCH_DEBOUNCE_RANGE.max}
                    step={20}
                    readout={t("unit.ms", { n: debounce })}
                    onChange={(v) => set("searchDebounceMs", v)}
                />
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("search.typingNote")}
            </div>

            <Label>{t("search.strictness")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label={t("search.strictnessLabel")}
                    value={strictness}
                    min={0}
                    max={100}
                    step={5}
                    readout={strictness === 0 ? t("search.strictnessOff") : strictness === 50 ? t("search.balanced") : t("unit.percent", { n: strictness })}
                    onChange={(v) => set("matchStrictness", v)}
                />
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("search.strictnessNote")}
            </div>

            <Label>{t("search.textVsVisual")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label={t("search.textVsVisualLabel")}
                    value={textWeight}
                    min={0}
                    max={100}
                    step={5}
                    readout={textWeight === 50 ? t("search.balanced") : t("unit.percent", { n: textWeight })}
                    onChange={(v) => set("textWeight", v)}
                />
            </div>
            <div className="text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("search.textVsVisualNote")}
            </div>
        </Group>
    );
}

function OrderSection(){
    const t = useT();
    const sort = useStore((s) => s.settings.sort);
    const groupBy = useStore((s) => s.settings.groupBy);
    const keep = useStore((s) => s.settings.sortedSearchKeep);
    const setSort = useStore((s) => s.setSort);
    const searching = useStore((s) => s.query.trim() !== "");
    const set = useStore((s) => s.setSetting);

    return (
        <Group
            title={t("order.title")}
            hint={t("order.hint")}
        >
            <Label>{t("order.libraryOrder")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex flex-wrap gap-[calc(6px*var(--ui-scale))]">
                {SORT_OPTIONS.filter((o) => o.key !== "relevance").map((o) => (
                    <Chip
                        key={o.key}
                        label={t(o.short)}
                        active={sort === o.key}
                        onClick={() => {
                            // Here it always means the *library* order. With a
                            // query typed, `setSort` would take it as that
                            // query's session-only order, so the setting is
                            // written directly and the search left alone.
                            if(searching){
                                set("sort", o.key as SortKey);
                            }else{
                                setSort(o.key as SortKey);
                            }
                        }}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("order.note", { modified: t("format.dateModified"), taken: t("format.dateTaken") })}
            </div>

            <Label>{t("order.groupBy")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {GROUP_BY_OPTIONS.map((g) => (
                    <Chip
                        key={g.key}
                        label={t(g.label)}
                        active={groupBy === g.key}
                        onClick={() => set("groupBy", g.key)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("order.groupNote")}
            </div>

            <Label>{t("order.keeps")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {SORTED_SEARCH_KEEPS.map((n) => (
                    <Chip
                        key={n}
                        label={t("order.top", { n })}
                        active={keep === n}
                        onClick={() => set("sortedSearchKeep", n)}
                    />
                ))}
            </div>
            <div className="text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("order.keepsNote")}
            </div>
        </Group>
    );
}

function GestureSection(){
    const t = useT();
    const holdMs = useStore((s) => s.settings.holdMs);
    const dragSlop = useStore((s) => s.settings.dragSlop);
    const set = useStore((s) => s.setSetting);

    return (
        <Group
            title={t("gestures.title")}
            hint={t("gestures.hint")}
        >
            <Label>{t("gestures.hold")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {HOLD_TIMES.map((h) => (
                    <Chip
                        key={h.v}
                        label={t("gestures.holdChip", { label: t(h.label), ms: h.v })}
                        active={holdMs === h.v}
                        onClick={() => set("holdMs", h.v)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("gestures.holdNote")}
            </div>

            <Label>{t("gestures.drag")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))]">
                <Slider
                    label={t("gestures.dragLabel")}
                    value={dragSlop}
                    min={DRAG_SLOP_RANGE.min}
                    max={DRAG_SLOP_RANGE.max}
                    readout={t("unit.px", { n: dragSlop })}
                    onChange={(v) => set("dragSlop", v)}
                />
            </div>
            <div className="text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("gestures.dragNote")}
            </div>
        </Group>
    );
}

function AppearanceSection(){
    const t = useT();
    const language = useStore((s) => s.settings.language);
    const setLanguage = useStore((s) => s.setLanguage);
    const theme = useStore((s) => s.settings.theme);
    const setTheme = useStore((s) => s.setTheme);
    const density = useStore((s) => s.density);
    const setDensity = useStore((s) => s.setDensity);
    const fontId = useStore((s) => s.settings.fontId);
    const setFont = useStore((s) => s.setFont);

    // Probed once per mount: the answer cannot change while the window is open,
    // and each probe is two canvas measurements.
    const installed = useMemo(
        () => new Map(FONTS.map((f) => [f.id, isFontAvailable(f.stack)])),
        [],
    );

    return (
        <Group title={t("appearance.title")}>
            <Label>{t("language.heading")}</Label>
            <div className="mb-[calc(6px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                <Chip label={t("language.auto")} active={language === "auto"} onClick={() => setLanguage("auto")} />
                {LANGUAGES.map((l) => (
                    <Chip
                        key={l.code}
                        label={l.label}
                        active={language === l.code}
                        onClick={() => setLanguage(l.code)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("language.note")}
            </div>

            <Label>{t("appearance.theme")}</Label>
            <div className="mb-5 flex gap-[calc(6px*var(--ui-scale))]">
                {THEMES.map((th) => (
                    <Chip
                        key={th}
                        label={t(`theme.${th}` as MessageKey)}
                        active={theme === th}
                        onClick={() => setTheme(th)}
                    />
                ))}
            </div>

            <Label>{t("appearance.font")}</Label>
            <div className="mb-[calc(10px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("appearance.fontNote")}
            </div>
            <div className="mb-5">
                {FONTS.map((f) => {
                    const selected = f.id === fontId;
                    const here = installed.get(f.id) ?? true;
                    return (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setFont(f.id)}
                            className={
                                "mb-[calc(5px*var(--ui-scale))] flex w-full cursor-pointer items-center gap-[calc(10px*var(--ui-scale))] rounded-lg px-3 py-[calc(9px*var(--ui-scale))] text-left transition-colors " +
                                (selected ? "bg-accent-muted" : "hover:bg-hover")
                            }
                        >
                            <Radio selected={selected} />
                            <div className="min-w-0">
                                <div
                                    className="flex items-center gap-2 text-[calc(12.5px*var(--ui-scale))]"
                                    style={{ fontFamily: here ? f.stack : undefined }}
                                >
                                    {f.labelKey === undefined ? f.label : t(f.labelKey)}
                                    {!here ? (
                                        <span className="rounded bg-hover px-[calc(5px*var(--ui-scale))] py-px font-sans text-[calc(10px*var(--ui-scale))] text-fg-faint">
                                            {t("appearance.notInstalled")}
                                        </span>
                                    ) : null}
                                </div>
                                <div className="mt-px font-mono text-[calc(11px*var(--ui-scale))] text-fg-faint">
                                    {f.descKey !== undefined ? t(f.descKey) : here ? f.desc : t("appearance.installCommand", { command: f.desc })}
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>

            <ColourSection />

            <Label>{t("appearance.density")}</Label>
            <div className="flex gap-[calc(6px*var(--ui-scale))]">
                {DENSITIES.map((d) => (
                    <Chip
                        key={d.v}
                        label={t(d.label)}
                        active={density === d.v}
                        onClick={() => setDensity(d.v)}
                    />
                ))}
            </div>
            <div className="mt-2 mb-5 text-[calc(11.5px*var(--ui-scale))] text-fg-faint">
                {t("appearance.densityNote")}
            </div>

            <GridLookSection />
        </Group>
    );
}

function AccessibilitySection(){
    const t = useT();
    const uiScale = useStore((s) => s.settings.uiScale);
    const setUiScale = useStore((s) => s.setUiScale);
    const reduceMotion = useStore((s) => s.settings.reduceMotion);
    const setReduceMotion = useStore((s) => s.setReduceMotion);
    const highContrast = useStore((s) => s.settings.highContrast);
    const setHighContrast = useStore((s) => s.setHighContrast);
    const fontId = useStore((s) => s.settings.fontId);
    const font = FONTS.find((f) => f.id === fontId);

    return (
        <Group
            title={t("accessibility.title")}
            hint={t("accessibility.hint")}
        >
            <Label>{t("accessibility.size")}</Label>
            <div className="mb-[calc(10px*var(--ui-scale))] flex gap-[calc(6px*var(--ui-scale))]">
                {UI_SCALES.map((s) => (
                    <Chip
                        key={s}
                        label={t("unit.percent", { n: s })}
                        active={uiScale === s}
                        onClick={() => setUiScale(s)}
                    />
                ))}
            </div>
            <div className="mb-5 text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {font !== undefined
                    ? t("accessibility.sizeNoteFont", { scale: uiScale, font: font.labelKey === undefined ? font.label : t(font.labelKey) })
                    : t("accessibility.sizeNote", { scale: uiScale })}
            </div>

            <div className="mb-[calc(10px*var(--ui-scale))] flex items-center justify-between border-b border-edge pb-[calc(10px*var(--ui-scale))]">
                <div className="min-w-0 pr-4">
                    <div className="text-[calc(12.5px*var(--ui-scale))]">{t("accessibility.highContrast")}</div>
                    <div className="mt-px text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                        {t("accessibility.highContrastNote")}
                    </div>
                </div>
                <Toggle
                    label=""
                    ariaLabel={t("accessibility.highContrast")}
                    on={highContrast}
                    onClick={() => setHighContrast(!highContrast)}
                />
            </div>

            <div className="mb-[calc(10px*var(--ui-scale))] flex items-center justify-between border-b border-edge pb-[calc(10px*var(--ui-scale))]">
                <div className="min-w-0 pr-4">
                    <div className="text-[calc(12.5px*var(--ui-scale))]">{t("accessibility.reduceMotion")}</div>
                    <div className="mt-px text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                        {t("accessibility.reduceMotionNote")}
                    </div>
                </div>
                <Toggle
                    label=""
                    ariaLabel={t("accessibility.reduceMotion")}
                    on={reduceMotion}
                    onClick={() => setReduceMotion(!reduceMotion)}
                />
            </div>

            <div className="text-[calc(11.5px*var(--ui-scale))] leading-[1.5] text-fg-faint">
                {t("accessibility.focusNote")}
            </div>
        </Group>
    );
}

const SHORTCUTS: { group: MessageKey; rows: { keys: MessageKey; what: MessageKey }[] }[] = [
    {
        group: "shortcuts.search.group",
        rows: [
            { keys: "shortcuts.search.focus.keys", what: "shortcuts.search.focus.what" },
            { keys: "shortcuts.search.escape.keys", what: "shortcuts.search.escape.what" },
            { keys: "shortcuts.search.arrows.keys", what: "shortcuts.search.arrows.what" },
            { keys: "shortcuts.search.enter.keys", what: "shortcuts.search.enter.what" },
            { keys: "shortcuts.search.space.keys", what: "shortcuts.search.space.what" },
        ],
    },
    {
        group: "shortcuts.zoom.group",
        rows: [
            { keys: "shortcuts.zoom.scroll.keys", what: "shortcuts.zoom.scroll.what" },
            { keys: "shortcuts.zoom.keys.keys", what: "shortcuts.zoom.keys.what" },
            { keys: "shortcuts.zoom.reset.keys", what: "shortcuts.zoom.reset.what" },
        ],
    },
    {
        group: "shortcuts.lightbox.group",
        rows: [
            { keys: "shortcuts.lightbox.step.keys", what: "shortcuts.lightbox.step.what" },
            { keys: "shortcuts.lightbox.fullscreen.keys", what: "shortcuts.lightbox.fullscreen.what" },
            { keys: "shortcuts.lightbox.doubleClick.keys", what: "shortcuts.lightbox.doubleClick.what" },
        ],
    },
    {
        group: "shortcuts.mouse.group",
        rows: [
            { keys: "shortcuts.mouse.click.keys", what: "shortcuts.mouse.click.what" },
            { keys: "shortcuts.mouse.hold.keys", what: "shortcuts.mouse.hold.what" },
            { keys: "shortcuts.mouse.drag.keys", what: "shortcuts.mouse.drag.what" },
            { keys: "shortcuts.mouse.ctrlDrag.keys", what: "shortcuts.mouse.ctrlDrag.what" },
            { keys: "shortcuts.mouse.shiftClick.keys", what: "shortcuts.mouse.shiftClick.what" },
            { keys: "shortcuts.mouse.shiftDrag.keys", what: "shortcuts.mouse.shiftDrag.what" },
            { keys: "shortcuts.mouse.carry.keys", what: "shortcuts.mouse.carry.what" },
        ],
    },
];

function ShortcutsSection(){
    const t = useT();
    // The hold-to-select time is a setting, so the row cannot hard-code 0.4 s.
    const holdMs = useStore((s) => s.settings.holdMs);
    const seconds = (holdMs / 1000).toLocaleString(currentLocale());
    return (
        <Group
            title={t("shortcuts.title")}
            hint={t("shortcuts.hint")}
        >
            {SHORTCUTS.map((g) => (
                <div key={g.group} className="mb-5">
                    <Label>{t(g.group).toLocaleUpperCase(currentLocale())}</Label>
                    {g.rows.map((r) => (
                        <div
                            key={r.keys}
                            className="flex items-baseline gap-3 border-b border-edge py-[calc(7px*var(--ui-scale))]"
                        >
                            <span className="w-[calc(150px*var(--ui-scale))] flex-shrink-0 font-mono text-[calc(11.5px*var(--ui-scale))] text-accent-text">
                                {t(r.keys, { seconds })}
                            </span>
                            <span className="text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-dim">
                                {t(r.what)}
                            </span>
                        </div>
                    ))}
                </div>
            ))}
        </Group>
    );
}

function StorageSection(){
    const t = useT();
    const storage = useStore((s) => s.storage);
    const confirm = useStore((s) => s.clearCacheConfirm);
    const clearCache = useStore((s) => s.clearCache);
    const cancel = useStore((s) => s.cancelClearCache);

    return (
        <Group title={t("storage.title")}>
            <div className="flex justify-between py-[calc(6px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg-dim">
                <span>{t("storage.thumbnailCache")}</span>
                <span className="tabular-nums">{fmtGb(storage.thumbnailCacheGb)}</span>
            </div>
            <div className="mb-3 flex justify-between border-b border-edge py-[calc(6px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg-dim">
                <span>{t("storage.searchIndex")}</span>
                <span className="tabular-nums">{fmtGb(storage.indexGb)}</span>
            </div>
            {confirm ? (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[calc(12px*var(--ui-scale))] text-fg-dim">
                        {t("storage.clearQuestion", { size: fmtGb(storage.thumbnailCacheGb) })}
                    </span>
                    <button
                        type="button"
                        onClick={() => void clearCache()}
                        className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border-none bg-danger px-3 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-white hover:opacity-90"
                    >
                        {t("storage.confirm")}
                    </button>
                    <button
                        type="button"
                        onClick={cancel}
                        className="cursor-pointer rounded-[calc(7px*var(--ui-scale))] border border-edge bg-transparent px-3 py-[calc(6px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] text-fg hover:bg-hover"
                    >
                        {t("common.cancel")}
                    </button>
                </div>
            ) : (
                <Button onClick={() => void clearCache()}>{t("storage.clear")}</Button>
            )}
        </Group>
    );
}
