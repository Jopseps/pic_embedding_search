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
                "cursor-pointer rounded-xl border px-[calc(9px*var(--ui-scale))] py-[calc(4px*var(--ui-scale))] text-[calc(11.5px*var(--ui-scale))] whitespace-nowrap transition-colors " +
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
            className="flex w-full cursor-pointer items-center gap-[calc(7px*var(--ui-scale))] py-1 text-left text-[calc(12.5px*var(--ui-scale))] text-fg-dim hover:text-fg"
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
                "flex h-[calc(14px*var(--ui-scale))] w-[calc(14px*var(--ui-scale))] flex-shrink-0 items-center justify-center rounded-[calc(3px*var(--ui-scale))] border-[calc(1.5px*var(--ui-scale))] border-edge text-[calc(10px*var(--ui-scale))] text-white " +
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
                "flex h-[calc(15px*var(--ui-scale))] w-[calc(15px*var(--ui-scale))] flex-shrink-0 items-center justify-center rounded-full border-[calc(1.5px*var(--ui-scale))] " +
                (props.selected ? "border-accent" : "border-edge")
            }
        >
            {props.selected ? <span className="h-[calc(7px*var(--ui-scale))] w-[calc(7px*var(--ui-scale))] rounded-full bg-accent" /> : null}
        </span>
    );
}

export function Toggle(props: {
    on: boolean;
    onClick: () => void;
    label: string;
    /** For switches whose name is already on the row next to them: the visible
     *  label would be a duplicate, but the switch still needs a name. */
    ariaLabel?: string;
}){
    return (
        <button
            type="button"
            onClick={props.onClick}
            role="switch"
            aria-checked={props.on}
            aria-label={props.ariaLabel}
            className="flex flex-shrink-0 cursor-pointer items-center gap-[calc(6px*var(--ui-scale))]"
        >
            <span className="text-[calc(11.5px*var(--ui-scale))] text-fg-dim">{props.label}</span>
            <span
                className={
                    "relative inline-block h-[calc(17px*var(--ui-scale))] w-[calc(30px*var(--ui-scale))] rounded-full transition-colors " +
                    (props.on ? "bg-accent" : "bg-hover")
                }
            >
                <span
                    className="absolute top-[calc(2px*var(--ui-scale))] h-[calc(13px*var(--ui-scale))] w-[calc(13px*var(--ui-scale))] rounded-full bg-white transition-[left]"
                    style={{
                        left: props.on
                            ? "calc(15px*var(--ui-scale))"
                            : "calc(2px*var(--ui-scale))",
                    }}
                />
            </span>
        </button>
    );
}

/**
 * A range input, themed. Native rather than a custom track: it is the only
 * control here that is dragged, and a div-based one loses keyboard stepping,
 * the OS's own pointer capture and every accessibility affordance that comes
 * free with `<input type="range">`.
 *
 * `accent-color` is one line and paints both the thumb and the filled track in
 * both engines, which is why there is no CSS for either.
 */
export function Slider(props: {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    /** Shown at the right — the value with its unit, already formatted. */
    readout: string;
    onChange: (value: number) => void;
}){
    const { value, min, max, step = 1, label, readout, onChange } = props;
    return (
        <div className="flex items-center gap-[calc(10px*var(--ui-scale))]">
            <input
                type="range"
                aria-label={label}
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={(e) => onChange(Number(e.target.value))}
                style={{ accentColor: "var(--accent)" }}
                className="h-[calc(18px*var(--ui-scale))] min-w-0 flex-1 cursor-pointer"
            />
            <span className="w-[calc(58px*var(--ui-scale))] flex-shrink-0 text-right font-mono text-[calc(11.5px*var(--ui-scale))] tabular-nums text-fg-dim">
                {readout}
            </span>
        </div>
    );
}

export function SectionLabel(props: { children: ReactNode; action?: ReactNode }){
    return (
        <div className="flex items-center justify-between px-[calc(6px*var(--ui-scale))] pt-4 pb-2">
            <span className="text-[calc(11px*var(--ui-scale))] font-semibold tracking-[0.06em] text-fg-faint">
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
    const base = "cursor-pointer rounded-lg text-[calc(12.5px*var(--ui-scale))] transition-colors whitespace-nowrap";
    const styles: Record<string, string> = {
        primary: "border-none bg-accent px-[calc(18px*var(--ui-scale))] py-[calc(9px*var(--ui-scale))] font-semibold text-white hover:opacity-90",
        ghost: "border border-edge bg-raised px-[calc(14px*var(--ui-scale))] py-[calc(8px*var(--ui-scale))] text-fg hover:bg-hover",
        subtle: "border-none bg-hover px-[calc(12px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))] text-fg hover:opacity-80",
        danger: "border-none bg-danger-muted px-[calc(12px*var(--ui-scale))] py-[calc(7px*var(--ui-scale))] text-danger hover:opacity-80",
    };
    return (
        <button type="button" onClick={props.onClick} className={`${base} ${styles[variant]} ${className}`}>
            {props.children}
        </button>
    );
}
