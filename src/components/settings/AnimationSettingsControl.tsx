import { useEffect, useState } from "react";
import type { AppearanceSettings } from "../../lib/types";
import { animationKinds, animationSpeed } from "../../lib/animationSettings";
import { useUiText } from "../../i18n/UiText";
import { Toggle } from "./SettingControls";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Controls";
import { DotsThreeVertical } from "../icons";
import common from "../common/Common.module.css";
import styles from "./AnimationSettingsControl.module.css";

function SpeedInput({ value, label, disabled, onCommit }: { value: number; label: string; disabled?: boolean; onCommit: (speed: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 10) {
      if (parsed !== value) onCommit(parsed);
      setDraft(String(parsed));
    }
    else setDraft(String(value));
  };
  return <input className={`${common.input} ${styles.speed}`} type="number" min={0.1} max={10} step={0.1} value={draft} disabled={disabled} aria-label={label}
    onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

export function AnimationSettingsControl({ appearance, onChange }: { appearance: AppearanceSettings; onChange: (next: AppearanceSettings) => void }) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const speed = animationSpeed(appearance.animationSpeed);
  const speedLabel = t("settings.animationSpeed");
  return <>
    <div className={styles.controls}>
      <Toggle label={t("settings.iconMorphing")} checked={appearance.iconMorphing !== false} onChange={iconMorphing => onChange({ ...appearance, iconMorphing })} />
      <SpeedInput value={speed} label={speedLabel} onCommit={animationSpeed => onChange({ ...appearance, animationSpeed })} />
      <Button variant="ghost" className={`${common.iconButton} ${styles.more}`} aria-label={t("settings.animationOptions")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} icon={<DotsThreeVertical size={18} />} />
    </div>
    <Dialog className={styles.animationDialog} open={open} title={t("settings.animationOptions")} description={t("settings.animationSpeedHint")} onClose={() => setOpen(false)} footer={<>
      <Button onClick={() => onChange({ ...appearance, animationSpeed: 1, animationSettings: {} })}>{t("settings.animationReset")}</Button>
      <Button onClick={() => setOpen(false)}>{t("common.close")}</Button>
    </>}>
      <div className={styles.options}>
        <div className={styles.overall}><strong>{speedLabel}</strong><SpeedInput value={speed} label={speedLabel} onCommit={animationSpeed => onChange({ ...appearance, animationSpeed })} /></div>
        {animationKinds.map(kind => {
          const individual = appearance.animationSettings?.[kind];
          const label = t(`settings.animationKinds.${kind}`);
          const enabled = individual?.enabled !== false;
          const update = (patch: { enabled?: boolean; speed?: number }) => onChange({ ...appearance, animationSettings: { ...appearance.animationSettings, [kind]: { ...individual, ...patch } } });
          return <div className={styles.option} key={kind}>
            <div className={styles.kindLabel}><strong>{label}</strong>{kind === "buttons" ? <small>{t("settings.animationButtonsHint")}</small> : null}</div>
            <Toggle label={label} checked={enabled} onChange={enabled => update({ enabled })} />
            <SpeedInput value={animationSpeed(individual?.speed, speed)} label={t("settings.animationTypeSpeed", undefined, { name: label })} disabled={!enabled} onCommit={speed => update({ speed })} />
          </div>;
        })}
      </div>
    </Dialog>
  </>;
}
