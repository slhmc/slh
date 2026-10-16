import { useState } from "react";
import { useUiText } from "../../i18n/UiText";
import { engine } from "../../i18n/engine";
import styles from "./ErrorText.module.css";

/** Preserve diagnostic content, with a localized explanation and explicit disclosure. */
export function ErrorText({ message }: { message: string }) {
  const t = useUiText();
  const { tr, isLocalized } = engine;
  const [expanded, setExpanded] = useState(false);
  const technical = engine.isDiagnostic(message) || !isLocalized(message);
  return <span className={styles.error}>
    <span>{isLocalized(message) ? tr(message) : t("common.texts.tryAgainIfItContinuesCheckTheAppLog", "Try again. If it continues, check the app log.")}</span>
    {technical ? <><button className={styles.disclosure} type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("common.texts.technicalDetails", "Technical details")}</button>{expanded ? <span className={styles.diagnostic}>{message}</span> : null}</> : null}
  </span>;
}
