import { useEffect, useId, useRef, type ReactNode } from "react";
import { useUiText } from "../../i18n/UiText";
import { X } from "../icons";
import common from "./Common.module.css";
import styles from "./Dialog.module.css";

interface DialogProps {
  open: boolean;
  title: ReactNode;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: "small" | "medium" | "large" | "xlarge";
}

export function Dialog({ open, title, description, children, footer, onClose, width = "medium" }: DialogProps) {
  const text = useUiText();
  const titleId = useId();
  const descriptionId = useId();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={`${styles.dialog} ${styles[width]} ${footer ? styles.withFooter : ""}`}
      onCancel={(event) => {
        event.stopPropagation();
        // File inputs also emit a bubbling `cancel` event when the native
        // Explorer dialog is dismissed. It belongs to the input, not to this
        // modal, so never treat it as Escape on the enclosing dialog.
        if (event.target !== event.currentTarget) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        onClose();
      }}
      onClose={(event) => { event.stopPropagation(); onClose(); }}
    >
      <div className={styles.header}>
        <div>
          <h2 id={titleId} className={styles.title}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <button className={common.iconButton} type="button" onClick={onClose} aria-label={text("common.closeDialog", "Close dialog")}>
          <X size={18} weight="bold" />
        </button>
      </div>
      <div className={styles.body}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </dialog>
  );
}
