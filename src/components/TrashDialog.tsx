import { memo, useEffect, useRef } from "react";
import { useStore } from "../lib/store";

/**
 * The confirm step before "Move to trash". It states the real consequence and
 * the true count — the selection can hold photos that a filter change has since
 * taken off screen — and Cancel is the default: focused on open, and what Esc
 * and a click on the backdrop do (App's key handler owns Esc).
 *
 * Mounted in App, which re-renders every scroll frame, hence `memo`.
 */
export const TrashDialog = memo(function TrashDialog(){
    const open = useStore((s) => s.deleteConfirm);
    const count = useStore((s) => s.selectedIds.size);
    const cancel = useStore((s) => s.cancelDelete);
    const confirm = useStore((s) => s.deleteSelected);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const confirmRef = useRef<HTMLButtonElement>(null);

    const shown = open && count > 0;
    // An effect rather than `autoFocus` alone: the search box holds focus from
    // launch and takes it back when the click that opened this lands.
    useEffect(() => {
        if(shown){
            cancelRef.current?.focus();
        }
    }, [shown]);

    if(!shown){
        return null;
    }

    const noun = count === 1 ? "photo" : "photos";

    return (
        <div
            className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50"
            onMouseDown={(e) => {
                if(e.target === e.currentTarget){
                    cancel();
                }
            }}
        >
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="trash-title"
                aria-describedby="trash-body"
                onKeyDown={(e) => {
                    // Two buttons: keep Tab inside the dialog rather than
                    // letting it walk into the grid behind it.
                    if(e.key === "Tab"){
                        e.preventDefault();
                        const next = document.activeElement === cancelRef.current
                            ? confirmRef.current
                            : cancelRef.current;
                        next?.focus();
                    }
                }}
                className="w-[calc(380px*var(--ui-scale))] max-w-[90vw] rounded-xl border border-edge bg-raised p-[calc(20px*var(--ui-scale))] shadow-[var(--shadow-pop)]"
            >
                <div
                    id="trash-title"
                    className="mb-[calc(8px*var(--ui-scale))] text-[calc(15px*var(--ui-scale))] font-semibold text-fg"
                >
                    Move {count} {noun} to the trash?
                </div>
                <div
                    id="trash-body"
                    className="mb-[calc(18px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] leading-[1.5] text-fg-dim"
                >
                    The {count === 1 ? "file leaves its folder" : "files leave their folders"} and
                    {" "}{count === 1 ? "goes" : "go"} to the system trash, and
                    {" "}{count === 1 ? "it disappears" : "they disappear"} from the library.
                    You can restore {count === 1 ? "it" : "them"} from the trash.
                </div>
                <div className="flex justify-end gap-[calc(8px*var(--ui-scale))]">
                    <button
                        ref={cancelRef}
                        type="button"
                        autoFocus
                        onClick={cancel}
                        className="cursor-pointer rounded-lg border border-edge bg-transparent px-[calc(14px*var(--ui-scale))] py-[calc(8px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] text-fg hover:bg-hover"
                    >
                        Cancel
                    </button>
                    <button
                        ref={confirmRef}
                        type="button"
                        onClick={() => void confirm()}
                        className="cursor-pointer rounded-lg border-none bg-danger px-[calc(14px*var(--ui-scale))] py-[calc(8px*var(--ui-scale))] text-[calc(12.5px*var(--ui-scale))] font-semibold text-white hover:opacity-90"
                    >
                        Move to trash
                    </button>
                </div>
            </div>
        </div>
    );
});
