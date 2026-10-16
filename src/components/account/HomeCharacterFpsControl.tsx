import { useUiText } from "../../i18n/UiText";
import { useEffect, useRef, useState } from "react";
import { fpsFromSlider, homeCharacterFps } from "../../lib/homeCharacterFps";
import styles from "./HomeCharacterFpsControl.module.css";

export function HomeCharacterFpsControl({ value, onCommit }: { value?: number; onCommit: (fps: number) => void }) {
  const uiText = useUiText();
  
  const [draft, setDraft] = useState(() => homeCharacterFps(value));
  const pending = useRef(draft);
  const dirty = useRef(false);
  const dragging = useRef(false);
  useEffect(() => { pending.current = homeCharacterFps(value); setDraft(pending.current); dirty.current = false; }, [value]);
  const commit = () => {
    dragging.current = false;
    if (!dirty.current) return;
    dirty.current = false;
    onCommit(pending.current);
  };
  const change = (fps: number) => { pending.current = fps; dirty.current = true; setDraft(fps); };
  return <div className={styles.control}>
    <div className={styles.track}>
      <input type="range" min={1} max={61} step={1} value={draft === 0 ? 61 : draft}
        aria-label={uiText("accounts.texts.playerFps", "Player FPS")} aria-valuetext={draft === 0 ? uiText("accounts.texts.unlimited", "Unlimited") : `${draft} FPS`}
        onPointerDown={() => { dragging.current = true; }}
        onKeyDown={() => { dragging.current = false; }}
        onChange={(event) => change(fpsFromSlider(Number(event.target.value), dragging.current))}
        onPointerUp={commit} onPointerCancel={commit} onKeyUp={commit} onBlur={commit} />
      <button type="button" className={styles.magnet} aria-label={uiText("accounts.texts.set30Fps", "Set 30 FPS")}
        onClick={() => { change(30); commit(); }}>30</button>
      <button type="button" className={`${styles.magnet} ${styles.magnet60}`} aria-label={uiText("accounts.texts.60Fps", "60 FPS")}
        onClick={() => { change(60); commit(); }}>60</button>
    </div>
    <strong>{draft === 0 ? uiText("accounts.texts.unlimited", "Unlimited") : `${draft} FPS`}</strong>
  </div>;
}
