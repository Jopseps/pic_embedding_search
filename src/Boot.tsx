import { useEffect, useRef, useState } from "react";
import {
    backendReset,
    backendRetry,
    backendStatus,
    type BackendStatus,
} from "./lib/tauri";
import type { SidecarHandshake } from "./lib/api";
import { Button } from "./components/ui";
import { fmtBytes, fmtTransfer, RateTracker } from "./lib/transfer";
import { t, type MessageKey } from "./lib/i18n";

/** Texts the Rust shell sends in English, by exact string. One it does not know
 *  (a newer shell, a log line) is shown as it came. */
const SHELL_TEXT: Record<string, MessageKey> = {
    "Installing Python and packages": "boot.stepInstall",
    "Downloading the search model": "boot.stepModel",
    "NVIDIA GPU found — installing CUDA PyTorch (about 3 GB)": "boot.noteGpu",
    "No usable NVIDIA GPU — installing CPU PyTorch (about 200 MB). Indexing is slower without a GPU.": "boot.noteCpu",
};

function fromShell(text: string): string{
    const key = SHELL_TEXT[text];
    return key === undefined ? text : t(key);
}

/**
 * What the desktop app shows until the sidecar has handed over a port.
 *
 * Usually that is a second, and this is a blank canvas with one line. On a
 * packaged first run it is the install — Python, torch, the model weights — and
 * this is the setup screen. When anything fails it says why, with the log and
 * a retry, instead of the old silent fall back to the fixture library: a user
 * of the packaged app has no idea those 420 photos are fake.
 *
 * Must not import `api.ts` (type-only imports are erased) or the store: the
 * api module picks its adapter once, at import time, and the handshake does
 * not exist yet.
 */

const POLL_MS = 250;

export function Boot(props: { onReady: (handshake: SidecarHandshake) => void }){
    const [status, setStatus] = useState<BackendStatus | null>(null);
    const [pollError, setPollError] = useState<string | null>(null);
    const [showLog, setShowLog] = useState(false);
    const [confirmReset, setConfirmReset] = useState(false);
    const logRef = useRef<HTMLPreElement>(null);
    const rate = useRef(new RateTracker());
    const rateStep = useRef<string | null>(null);
    const [speed, setSpeed] = useState<string | null>(null);
    const { onReady } = props;

    useEffect(() => {
        let alive = true;
        let timer: number | undefined;
        const tick = async () => {
            try{
                const next = await backendStatus();
                if(!alive){
                    return;
                }
                setStatus(next);
                setPollError(null);
                // Speed and time left, measured per step: a new step is a new
                // transfer, and its bytes start from zero.
                if(next.phase === "installing" && next.total > 0){
                    if(rateStep.current !== next.step){
                        rateStep.current = next.step;
                        rate.current.reset();
                    }
                    const t = rate.current.push(next.done, next.total);
                    setSpeed(t === null ? null : fmtTransfer(t));
                }else{
                    rateStep.current = null;
                    setSpeed(null);
                }
                if(next.phase === "ready"){
                    onReady(next.handshake);
                    return;
                }
            }catch(err){
                if(alive){
                    setPollError(String(err));
                }
            }
            if(alive){
                timer = window.setTimeout(() => void tick(), POLL_MS);
            }
        };
        void tick();
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [onReady]);

    const failed = status?.phase === "failed";
    const logOpen = showLog || failed;
    const logLength = status?.log.length ?? 0;

    useEffect(() => {
        const el = logRef.current;
        if(el !== null){
            el.scrollTop = el.scrollHeight;
        }
    }, [logLength, logOpen]);

    // A normal launch: nothing to install, the sidecar is up in about a
    // second. A full setup screen flashing past would read as a glitch.
    const quiet = status === null || (!status.installed && (status.phase === "checking" || status.phase === "starting"));
    if(quiet && pollError === null){
        return (
            <div className="flex h-full items-center justify-center bg-canvas text-[calc(12.5px*var(--ui-scale))] text-fg-faint">
                {t("boot.starting")}
            </div>
        );
    }

    const retry = () => {
        setConfirmReset(false);
        backendRetry().catch((err: unknown) => setPollError(String(err)));
    };
    const reset = () => {
        if(!confirmReset){
            setConfirmReset(true);
            return;
        }
        setConfirmReset(false);
        void backendReset().catch((err: unknown) => setPollError(String(err)));
    };

    let title = t("boot.title");
    let detail = t("boot.detail");
    let step: string | null = null;
    let fraction: number | null = null;
    let bytes: string | null = null;
    if(status !== null){
        if(status.phase === "installing"){
            step = fromShell(status.step);
            if(status.total > 0){
                fraction = Math.min(1, status.done / status.total);
                bytes = t("format.bytesOf", { done: fmtBytes(status.done), total: fmtBytes(status.total) });
            }else if(status.done > 0){
                bytes = fmtBytes(status.done);
            }
        }else if(status.phase === "starting"){
            step = t("boot.startingService");
        }else if(status.phase === "checking"){
            step = t("boot.checking");
        }else if(status.phase === "failed"){
            title = t("boot.couldNotStart");
            detail = status.message.split("\n")[0] ?? status.message;
        }
    }
    if(pollError !== null){
        title = t("boot.couldNotStart");
        detail = pollError;
    }

    return (
        <div className="flex h-full items-center justify-center bg-canvas px-6 text-fg">
            <div className="flex w-full max-w-[calc(560px*var(--ui-scale))] flex-col gap-[calc(16px*var(--ui-scale))]">
                <div>
                    <div className="text-[calc(18px*var(--ui-scale))] font-semibold">{title}</div>
                    <div className="mt-[calc(6px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] leading-[1.5] text-fg-dim" data-selectable>
                        {detail}
                    </div>
                </div>

                {step !== null && !failed ? (
                    <div>
                        <div className="mb-[calc(8px*var(--ui-scale))] flex justify-between text-[calc(12px*var(--ui-scale))]">
                            <span>{step}</span>
                            <span className="tabular-nums text-fg-faint">
                                {bytes ?? ""}
                                {fraction !== null ? ` · ${Math.round(fraction * 100)}%` : ""}
                            </span>
                        </div>
                        <div className="relative h-[calc(6px*var(--ui-scale))] overflow-hidden rounded-full bg-raised">
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
                        {speed !== null ? (
                            <div className="mt-[calc(6px*var(--ui-scale))] text-right text-[calc(11.5px*var(--ui-scale))] tabular-nums text-fg-faint">
                                {speed}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {status !== null && status.notes.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-[calc(6px*var(--ui-scale))] p-0">
                        {status.notes.map((note) => (
                            <li
                                key={note}
                                className="rounded-lg border border-edge bg-raised px-3 py-[calc(8px*var(--ui-scale))] text-[calc(12px*var(--ui-scale))] leading-[1.5] text-fg-dim"
                                data-selectable
                            >
                                {fromShell(note)}
                            </li>
                        ))}
                    </ul>
                ) : null}

                {logOpen ? (
                    <pre
                        ref={logRef}
                        className="m-0 max-h-[calc(220px*var(--ui-scale))] overflow-auto rounded-lg border border-edge bg-panel p-3 font-mono text-[calc(11px*var(--ui-scale))] leading-[1.45] whitespace-pre-wrap text-fg-faint"
                        data-selectable
                    >
                        {failed && status?.phase === "failed" ? status.message + "\n\n" : ""}
                        {(status?.log ?? []).join("\n")}
                    </pre>
                ) : null}

                <div className="flex items-center gap-2">
                    {failed || pollError !== null ? (
                        <>
                            <Button variant="primary" onClick={retry}>{t("common.retry")}</Button>
                            <Button variant={confirmReset ? "danger" : "ghost"} onClick={reset}>
                                {confirmReset ? t("boot.reinstallConfirm") : t("boot.reinstall")}
                            </Button>
                        </>
                    ) : null}
                    {!failed ? (
                        <Button variant="subtle" onClick={() => setShowLog((v) => !v)}>
                            {showLog ? t("boot.hideDetails") : t("boot.showDetails")}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
