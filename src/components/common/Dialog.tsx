import { useEffect, useId, useRef, type ReactNode } from "react";
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
  const titleId = useId();
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
      className={`${styles.dialog} ${styles[width]} ${footer ? styles.withFooter : ""}`}
      onCancel={(event) => {
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
      onClose={onClose}
    >
      <div className={styles.header}>
        <div>
          <div className={styles.title} id={titleId}>{title}</div>
          {description ? <p>{description}</p> : null}
        </div>
        <button className={common.iconButton} type="button" onClick={onClose} aria-label="Close dialog">
          <X size={18} weight="bold" />
        </button>
      </div>
      <div className={styles.body}>{children}</div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </dialog>
  );
}
