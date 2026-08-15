import { useEffect } from "react";
import { useStore } from "../lib/store";
import {
    EMBEDDING_MODELS,
    OCR_ENGINES,
    OCR_LANGUAGES,
    modelById,
} from "../lib/catalog";
import { fmtCount, fmtGb } from "../lib/format";
import { isMockMode } from "../lib/api";
import { Box, Button, Chip, Radio, Toggle } from "./ui";
import type { Density, ThemePref } from "../lib/types";

const THEMES: ThemePref[] = ["dark", "light", "system"];
const DENSITIES: { v: Density; label: string }[] = [
    { v: 0, label: "Compact" },
    { v: 1, label: "Comfortable" },
    { v: 2, label: "Large" },
];

export function SettingsView(){
    const setView = useStore((s) => s.setView);
    const loadStorage = useStore((s) => s.loadStorage);

    useEffect(() => {
        void loadStorage();
    }, [loadStorage]);

    return (
        <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[640px] px-6 pt-7 pb-20">
                <div className="mb-7 flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => setView("library")}
                        className="cursor-pointer text-[14px] text-fg-dim hover:text-fg"
                    >
                        ← Back
                    </button>
                    <span className="text-[16px] font-semibold">Settings</span>
                </div>

                {isMockMode ? (
                    <div className="mb-7 rounded-lg border border-edge bg-raised p-3 text-[12px] leading-[1.5] text-fg-dim">
                        Running against the built-in fixture library — the Python sidecar is not
                        connected, so folder picking and re-indexing are simulated.
                    </div>
                ) : null}

                <FoldersSection />
                <ModelSection />
                <OcrSection />
                <AppearanceSection />
                <StorageSection />
            </div>
        </div>
    );
}

function Group(props: { title: string; hint?: string; children: React.ReactNode }){
    return (
        <div className="mb-8">
            <div className="mb-[3px] text-[13px] font-semibold">{props.title}</div>
            {props.hint !== undefined ? (
                <div className="mb-3 text-[12px] leading-[1.5] text-fg-faint">{props.hint}</div>
            ) : null}
            {props.children}
        </div>
    );
}

function FoldersSection(){
    const folders = useStore((s) => s.folders);
    const toggleRecursive = useStore((s) => s.toggleRecursive);
    const removeFolder = useStore((s) => s.removeFolder);
    const addFolder = useStore((s) => s.addFolder);

    return (
        <Group
            title="Watched folders"
            hint="Folders indexed for search. Screenshots are detected automatically and get an OCR pass."
        >
            {folders.map((f) => (
                <div key={f.path} className="flex items-center gap-[10px] border-b border-edge py-[10px]">
                    <div className="min-w-0 flex-1">
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12.5px]">
                            {f.path}
                        </div>
                        <div className="mt-[2px] text-[11.5px] text-fg-faint">
                            {fmtCount(f.count)} images
                        </div>
                    </div>
                    <Toggle
                        label="Recursive"
                        on={f.recursive}
                        onClick={() => void toggleRecursive(f.path)}
                    />
                    <button
                        type="button"
                        onClick={() => void removeFolder(f.path)}
                        aria-label={`Stop watching ${f.path}`}
                        className="flex-shrink-0 cursor-pointer px-1 py-[2px] text-[14px] text-fg-faint hover:text-danger"
                    >
                        ✕
                    </button>
                </div>
            ))}
            <Button onClick={() => void addFolder()} className="mt-3">+ Add folder</Button>
        </Group>
    );
}

function ModelSection(){
    const modelId = useStore((s) => s.settings.modelId);
    const pendingId = useStore((s) => s.pendingModelId);
    const reindex = useStore((s) => s.reindex);
    const select = useStore((s) => s.selectModel);
    const confirm = useStore((s) => s.confirmModelChange);
    const cancel = useStore((s) => s.cancelModelChange);
    const indexTotal = useStore((s) => s.indexing.total);

    const pending = pendingId === null ? null : (modelById(pendingId) ?? null);
    // ~150 img/s on the reference GPU; enough to set expectations, not a promise.
    const etaMin = Math.max(1, Math.round(indexTotal / 150 / 60));

    return (
        <Group
            title="Search model"
            hint="The embedding model used to understand your images. Changing it requires re-embedding every image — old vectors are kept, so switching back is instant."
        >
            {EMBEDDING_MODELS.map((m) => {
                const selected = m.id === modelId;
                return (
                    <button
                        key={m.id}
                        type="button"
                        onClick={() => select(m.id)}
                        disabled={reindex.active}
                        className={
                            "mb-[6px] flex w-full cursor-pointer items-center gap-[10px] rounded-lg border px-3 py-[11px] text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 " +
                            (selected
                                ? "border-accent bg-accent-muted"
                                : "border-edge bg-raised hover:bg-hover")
                        }
                    >
                        <Radio selected={selected} />
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 text-[13px] font-medium">
                                {m.name}
                                {!m.multilingual ? (
                                    <span
                                        title="Cannot answer Turkish queries"
                                        className="rounded bg-hover px-[5px] py-px text-[10px] font-normal text-fg-faint"
                                    >
                                        EN only
                                    </span>
                                ) : null}
                            </div>
                            <div className="mt-px text-[11.5px] text-fg-faint">{m.desc}</div>
                        </div>
                    </button>
                );
            })}

            {pending !== null && !reindex.active ? (
                <div className="mt-[10px] rounded-lg border border-edge bg-danger-muted p-[14px]">
                    <div className="mb-1 text-[12.5px] font-semibold text-fg">Re-index required</div>
                    <div className="mb-[10px] text-[12px] leading-[1.5] text-fg-dim">
                        Switching to {pending.name} means every image needs to be re-embedded —
                        the two models produce incompatible vectors. Estimated time: ~{etaMin} minute
                        {etaMin === 1 ? "" : "s"} for {fmtCount(indexTotal)} images. Search will be
                        unavailable while this runs.
                    </div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={confirm}
                            className="cursor-pointer rounded-[7px] border-none bg-danger px-[14px] py-[7px] text-[12.5px] text-white hover:opacity-90"
                        >
                            Re-index now
                        </button>
                        <button
                            type="button"
                            onClick={cancel}
                            className="cursor-pointer rounded-[7px] border border-edge bg-transparent px-[14px] py-[7px] text-[12.5px] text-fg hover:bg-hover"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : null}

            {reindex.active ? (
                <div className="mt-[10px] rounded-lg border border-edge bg-raised p-[14px]">
                    <div className="mb-2 text-[12.5px] text-fg">
                        Re-indexing with {reindex.modelName}… {Math.round(reindex.progress)}%
                    </div>
                    <div className="mb-2 h-[6px] overflow-hidden rounded-[3px] bg-hover">
                        <div
                            className="h-full bg-accent transition-[width]"
                            style={{ width: `${reindex.progress}%` }}
                        />
                    </div>
                    <div className="text-[11.5px] text-danger">Search unavailable while re-indexing</div>
                </div>
            ) : null}
        </Group>
    );
}

function OcrSection(){
    const engineId = useStore((s) => s.settings.ocrEngineId);
    const langs = useStore((s) => s.settings.ocrLangs);
    const setEngine = useStore((s) => s.setOcrEngine);
    const toggleLang = useStore((s) => s.toggleOcrLang);

    return (
        <Group
            title="OCR engine and languages"
            hint="Extracts text from screenshots so words printed inside them become searchable."
        >
            {OCR_ENGINES.map((e) => {
                const selected = e.id === engineId;
                return (
                    <button
                        key={e.id}
                        type="button"
                        onClick={() => setEngine(e.id)}
                        className={
                            "mb-[5px] flex w-full cursor-pointer items-center gap-[10px] rounded-lg px-3 py-[9px] text-left transition-colors " +
                            (selected ? "bg-accent-muted" : "hover:bg-hover")
                        }
                    >
                        <Radio selected={selected} />
                        <div>
                            <div className="text-[12.5px]">{e.label}</div>
                            <div className="mt-px text-[11.5px] text-fg-faint">{e.desc}</div>
                        </div>
                    </button>
                );
            })}

            <div className="mt-[14px] mb-2 text-[11.5px] text-fg-faint">LANGUAGES</div>
            <div className="flex flex-wrap gap-2">
                {OCR_LANGUAGES.map((l) => (
                    <button
                        key={l.code}
                        type="button"
                        onClick={() => toggleLang(l.code)}
                        className="flex cursor-pointer items-center gap-[6px] rounded-[7px] border border-edge bg-raised px-[10px] py-[6px] hover:bg-hover"
                    >
                        <Box checked={langs.includes(l.code)} />
                        <span className="text-[12px]">{l.label}</span>
                    </button>
                ))}
            </div>
        </Group>
    );
}

function AppearanceSection(){
    const theme = useStore((s) => s.settings.theme);
    const setTheme = useStore((s) => s.setTheme);
    const density = useStore((s) => s.density);
    const setDensity = useStore((s) => s.setDensity);

    return (
        <Group title="Appearance">
            <div className="mb-[6px] text-[11.5px] text-fg-faint">THEME</div>
            <div className="mb-4 flex gap-[6px]">
                {THEMES.map((t) => (
                    <Chip
                        key={t}
                        label={t[0]!.toUpperCase() + t.slice(1)}
                        active={theme === t}
                        onClick={() => setTheme(t)}
                    />
                ))}
            </div>
            <div className="mb-[6px] text-[11.5px] text-fg-faint">DEFAULT GRID DENSITY</div>
            <div className="flex gap-[6px]">
                {DENSITIES.map((d) => (
                    <Chip
                        key={d.v}
                        label={d.label}
                        active={density === d.v}
                        onClick={() => setDensity(d.v)}
                    />
                ))}
            </div>
        </Group>
    );
}

function StorageSection(){
    const storage = useStore((s) => s.storage);
    const confirm = useStore((s) => s.clearCacheConfirm);
    const clearCache = useStore((s) => s.clearCache);
    const cancel = useStore((s) => s.cancelClearCache);

    return (
        <Group title="Storage">
            <div className="flex justify-between py-[6px] text-[12.5px] text-fg-dim">
                <span>Thumbnail cache</span>
                <span className="tabular-nums">{fmtGb(storage.thumbnailCacheGb)}</span>
            </div>
            <div className="mb-3 flex justify-between border-b border-edge py-[6px] text-[12.5px] text-fg-dim">
                <span>Search index</span>
                <span className="tabular-nums">{fmtGb(storage.indexGb)}</span>
            </div>
            {confirm ? (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-fg-dim">
                        Clear {fmtGb(storage.thumbnailCacheGb)} of cached thumbnails? They will be
                        regenerated on demand.
                    </span>
                    <button
                        type="button"
                        onClick={() => void clearCache()}
                        className="cursor-pointer rounded-[7px] border-none bg-danger px-3 py-[6px] text-[12px] text-white hover:opacity-90"
                    >
                        Confirm
                    </button>
                    <button
                        type="button"
                        onClick={cancel}
                        className="cursor-pointer rounded-[7px] border border-edge bg-transparent px-3 py-[6px] text-[12px] text-fg hover:bg-hover"
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <Button onClick={() => void clearCache()}>Clear thumbnail cache</Button>
            )}
        </Group>
    );
}
