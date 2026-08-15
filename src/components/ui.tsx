import type { ReactNode } from "react";

/** Pill toggle used by date / type / dims filters, theme and density pickers. */
export function Chip(props: {
    label: string;
    active: boolean;
    onClick: () => void;
}){
    const { label, active, onClick } = props;
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={
                "cursor-pointer rounded-xl border px-[9px] py-[4px] text-[11.5px] transition-colors " +
                (active
                    ? "border-accent bg-accent-muted text-accent-text"
                    : "border-edge bg-raised text-fg-dim hover:bg-hover")
            }
        >
            {label}
        </button>
    );
}

export function CheckRow(props: {
    label: string;
    checked: boolean;
    onToggle: () => void;
    mono?: boolean;
}){
    const { label, checked, onToggle, mono = false } = props;
    return (
        <button
            type="button"
            onClick={onToggle}
            role="checkbox"
            aria-checked={checked}
            className="flex w-full cursor-pointer items-center gap-[7px] py-1 text-left text-[12.5px] text-fg-dim hover:text-fg"
        >
            <Box checked={checked} />
            <span
                className={
                    "overflow-hidden text-ellipsis whitespace-nowrap " +
                    (mono ? "font-mono" : "")
                }
            >
                {label}
            </span>
        </button>
    );
}

export function Box(props: { checked: boolean }){
    return (
        <span
            className={
                "flex h-[14px] w-[14px] flex-shrink-0 items-center justify-center rounded-[3px] border-[1.5px] border-edge text-[10px] text-white " +
                (props.checked ? "bg-accent" : "bg-transparent")
            }
        >
            {props.checked ? "✓" : ""}
        </span>
    );
}

export function Radio(props: { selected: boolean }){
    return (
        <span
            className={
                "flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-full border-[1.5px] " +
                (props.selected ? "border-accent" : "border-edge")
            }
        >
            {props.selected ? <span className="h-[7px] w-[7px] rounded-full bg-accent" /> : null}
        </span>
    );
}

export function Toggle(props: { on: boolean; onClick: () => void; label: string }){
    return (
        <button
            type="button"
            onClick={props.onClick}
            role="switch"
            aria-checked={props.on}
            className="flex flex-shrink-0 cursor-pointer items-center gap-[6px]"
        >
            <span className="text-[11.5px] text-fg-dim">{props.label}</span>
            <span
                className={
                    "relative inline-block h-[17px] w-[30px] rounded-full transition-colors " +
                    (props.on ? "bg-accent" : "bg-hover")
                }
            >
                <span
                    className="absolute top-[2px] h-[13px] w-[13px] rounded-full bg-white transition-[left]"
                    style={{ left: props.on ? 15 : 2 }}
                />
            </span>
        </button>
    );
}

export function SectionLabel(props: { children: ReactNode; action?: ReactNode }){
    return (
        <div className="flex items-center justify-between px-[6px] pt-4 pb-2">
            <span className="text-[11px] font-semibold tracking-[0.06em] text-fg-faint">
                {props.children}
            </span>
            {props.action}
        </div>
    );
}

export function Button(props: {
    children: ReactNode;
    onClick: () => void;
    variant?: "primary" | "ghost" | "danger" | "subtle";
    className?: string;
}){
    const { variant = "ghost", className = "" } = props;
    const base = "cursor-pointer rounded-lg text-[12.5px] transition-colors whitespace-nowrap";
    const styles: Record<string, string> = {
        primary: "border-none bg-accent px-[18px] py-[9px] font-semibold text-white hover:opacity-90",
        ghost: "border border-edge bg-raised px-[14px] py-[8px] text-fg hover:bg-hover",
        subtle: "border-none bg-hover px-[12px] py-[7px] text-fg hover:opacity-80",
        danger: "border-none bg-danger-muted px-[12px] py-[7px] text-danger hover:opacity-80",
    };
    return (
        <button type="button" onClick={props.onClick} className={`${base} ${styles[variant]} ${className}`}>
            {props.children}
        </button>
    );
}
