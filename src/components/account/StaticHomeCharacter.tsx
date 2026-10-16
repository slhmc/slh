import { useEffect, useState } from "react";
import type { Account } from "../../lib/types";
import { useHomeSkin } from "../../lib/useHomeSkin";
import { useUiText } from "../../i18n/UiText";
import styles from "./HomeCharacter.module.css";

export function StaticHomeCharacter({account}: {account:Account | null}) {
  const skin = useHomeSkin(account);
  const t = useUiText();
  const [portrait,setPortrait] = useState<{source:string;url:string} | null>(null);
  const source = `${skin.model}:${skin.dataUrl}`;
  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    if (skin.dataUrl) void import("../../lib/homePortrait").then(module => module.homePortrait(skin)).then(blob => {
      if (alive) { url = URL.createObjectURL(blob); setPortrait({source,url}); }
    }).catch(() => { if (alive) setPortrait(null); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  },[source]);
  return <div className={styles.portrait} data-home-character="image">
    {portrait?.source === source ? <img src={portrait.url} alt={t("settings.character.imageAlt")} draggable={false} /> : null}
  </div>;
}
