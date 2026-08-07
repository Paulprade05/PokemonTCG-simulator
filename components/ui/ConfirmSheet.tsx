"use client";

import Sheet from "./Sheet";

interface ConfirmSheetProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Alternativa a `confirm()` que no rompe el aspecto de app instalada. */
export default function ConfirmSheet({
  open,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  destructive = false,
  onConfirm,
  onClose,
}: ConfirmSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} label={title}>
      <div className="px-5 pt-3 pb-6">
        <h2 className="ink text-center text-[17px] font-semibold">{title}</h2>
        {description && (
          <p className="ink-soft mt-2 text-center text-[13px] leading-relaxed">
            {description}
          </p>
        )}
        <div className="mt-6 flex flex-col gap-2.5">
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`press rounded-2xl py-3.5 text-sm font-semibold ${
              destructive ? "" : "btn-accent"
            }`}
            style={
              destructive
                ? {
                    background:
                      "color-mix(in srgb, var(--danger) 16%, transparent)",
                    border:
                      "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
                    color: "var(--danger)",
                  }
                : undefined
            }
          >
            {confirmLabel}
          </button>
          <button
            onClick={onClose}
            className="btn-ghost press rounded-2xl py-3.5 text-sm font-medium"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
