import { useState } from "react";
import type { AppearanceSettings } from "../../lib/types";
import { useUiText } from "../../i18n/UiText";
import { Toggle } from "./SettingControls";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Controls";
import { DotsThreeVertical } from "../icons";
import common from "../common/Common.module.css";
import styles from "./AnimationSettingsControl.module.css";

export function ActionListSettingsControl({ appearance, onChange }: { appearance: AppearanceSettings; onChange: (next: AppearanceSettings) => void }) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const instances = appearance.instanceActionsAsList === true;
  const servers = appearance.serverActionsAsList ?? instances;
  return <>
    <div className={styles.controls}>
      <Toggle label={t("settings.instanceActionsAsList")} checked={instances && servers} onChange={value => onChange({ ...appearance, instanceActionsAsList: value, serverActionsAsList: value })} />
      <Button variant="ghost" className={`${common.iconButton} ${styles.more}`} aria-label={t("settings.actionListOptions")} aria-haspopup="dialog" aria-expanded={open} icon={<DotsThreeVertical size={18} />} onClick={() => setOpen(true)} />
    </div>
    <Dialog open={open} width="small" title={t("settings.actionListOptions")} description={t("settings.actionListHint")} onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>{t("common.close")}</Button>}>
      <div className={styles.options}>
        <div className={styles.overall}><strong>{t("settings.minecraft")}</strong><Toggle label={t("settings.minecraft")} checked={instances} onChange={instanceActionsAsList => onChange({ ...appearance, instanceActionsAsList, serverActionsAsList: servers })} /></div>
        <div className={styles.overall}><strong>{t("navigation.localServers")}</strong><Toggle label={t("navigation.localServers")} checked={servers} onChange={serverActionsAsList => onChange({ ...appearance, serverActionsAsList })} /></div>
      </div>
    </Dialog>
  </>;
}
