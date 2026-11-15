import { useUiText } from "../../i18n/UiText";
import { homeCharacterMode, type HomeCharacterMode } from "../../lib/homeCharacterMode";
import { Button } from "../common/Controls";
import styles from "./HomeCharacterModeControl.module.css";

export function HomeCharacterModeControl({ value, onChange }: {
  value?: HomeCharacterMode; onChange: (mode: HomeCharacterMode) => void;
}) {
  const t = useUiText();
  const selected = homeCharacterMode(value);
  return <div className={styles.control} role="group" aria-label={t("settings.character.title")}>
    {([2, 1, 0] as const).map(mode => <Button key={mode}
      className={styles.mode} variant={selected === mode ? "primary" : "secondary"}
      aria-pressed={selected === mode} onClick={() => onChange(mode)}>
      {mode === 0 ? t("settings.character.offShort") : t(`settings.character.mode${mode}`).replace(/^\d+\s*[·∙-]\s*/, "")}
    </Button>)}
  </div>;
}
