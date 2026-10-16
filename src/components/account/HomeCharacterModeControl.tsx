import { useUiText } from "../../i18n/UiText";
import type { CSSProperties } from "react";
import { homeCharacterMode, type HomeCharacterMode } from "../../lib/homeCharacterMode";
import styles from "./HomeCharacterModeControl.module.css";

export function HomeCharacterModeControl({value,vertical,onChange}: {
  value?:HomeCharacterMode;vertical:boolean;onChange:(mode:HomeCharacterMode)=>void;
}) {
  const t = useUiText();
  const selected = homeCharacterMode(value);
  return <div className={`${styles.control} ${vertical ? styles.vertical : ""}`} role="group"
    aria-label={t("settings.character.title")}>
    <div className={styles.switch} style={{"--stop":2-selected} as CSSProperties}>
      <div className={styles.rail} aria-hidden="true">
        <i className={styles.dot} /><i className={styles.dot} /><i className={styles.dot} />
        <span className={styles.thumb} />
      </div>
      <input type="range" min={0} max={2} step={1} value={selected} dir="rtl"
        aria-label={t("settings.character.title")} aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-valuetext={t(`settings.character.mode${selected}`)}
        onChange={event => onChange(Number(event.target.value) as HomeCharacterMode)}
        onKeyDown={event => {
          const next = event.key === "Home" ? 2 : event.key === "End" ? 0
            : ["ArrowLeft","ArrowUp"].includes(event.key) ? Math.min(2,selected+1)
            : ["ArrowRight","ArrowDown"].includes(event.key) ? Math.max(0,selected-1) : null;
          if (next !== null) { event.preventDefault(); onChange(next as HomeCharacterMode); }
        }} />
    </div>
    <div className={styles.labels}>{([2,1,0] as const).map(mode => <button key={mode} type="button" aria-pressed={selected === mode}
      onClick={() => onChange(mode)}>{t(`settings.character.mode${mode}`)}</button>)}
    </div>
  </div>;
}
