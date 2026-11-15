import { useEffect, useId, useRef, type ReactNode } from "react";
import { useUiText } from "../../i18n/UiText";
import { X } from "../icons";
import common from "./Common.module.css";
import styles from "./Dialog.module.css";
import { animate } from "motion";
import { spring, transition, scale } from "@animate-ui/react/utils/motion";
import { useAnimationTransition, useSmoothAnimations } from "../../lib/motion";

interface DialogProps {
  open: boolean;
  title: ReactNode;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: "small" | "medium" | "large" | "xlarge";
  className?: string;
  bodyClassName?: string;
}

export function Dialog({ open, title, description, children, footer, onClose, width = "medium", className = "", bodyClassName = "" }: DialogProps) {
  const text = useUiText();
  const titleId = useId();
  const descriptionId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const smooth = useSmoothAnimations("dialogs");
  const enter = useAnimationTransition("dialogs", spring.dialog);
  const fade = useAnimationTransition("dialogs", transition.dialogFade);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      if (smooth) {
        dialog.dataset.motion = "entering";
        const animation = animate(dialog, { opacity: [0, 1], scale: [scale.dialog, 1] }, { ...enter, opacity: fade });
        void animation.then(() => { delete dialog.dataset.motion; });
        return () => { animation.stop(); dialog.style.opacity = "1"; dialog.style.transform = "none"; delete dialog.dataset.motion; };
      }
    }
    if (!open && dialog.open) dialog.close();
  }, [open, smooth, enter, fade]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={typeof title === "string" ? undefined : titleId}
      aria-label={typeof title === "string" ? title : undefined}
      aria-describedby={description ? descriptionId : undefined}
      className={`${styles.dialog} ${styles[width]} ${footer ? styles.withFooter : ""} ${className}`}
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
      <div className={`${styles.body} ${bodyClassName}`}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </dialog>
  );
}
