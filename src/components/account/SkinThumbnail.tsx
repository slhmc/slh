import { useEffect, useRef, useState } from "react";
import { RequestCache } from "../../lib/requestCache";
import styles from "./SkinThumbnail.module.css";

const portraits = new RequestCache<Blob>(5 * 60_000, 40);

/** Gallery cards retain PNGs, rather than one live WebGL renderer per skin. */
export function SkinThumbnail({ skin, model, label }: { skin: string | null | undefined; model: "classic" | "slim"; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [portrait, setPortrait] = useState<{ key: string; url: string } | null>(null);
  const key = `standing:${model}:${skin}`;
  useEffect(() => {
    if (!skin || !host.current) return;
    let alive = true;
    let started = false;
    let url: string | undefined;
    const load = () => {
      if (started) return;
      started = true;
      void portraits.load(key, async () => {
        const { homePortrait } = await import("../../lib/homePortrait");
        return homePortrait({ dataUrl: skin, model }, "standing");
      }).then(blob => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPortrait({ key, url });
      }).catch(() => { /* The texture face stays visible when WebGL is unavailable. */ });
    };
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { load(); observer?.disconnect(); }
    });
    if (observer) observer.observe(host.current); else load();
    return () => { alive = false; observer?.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [key, skin, model]);
  return <div ref={host} className={styles.thumbnail} role="img" aria-label={label}>
    {portrait?.key === key ? <img src={portrait.url} alt="" draggable={false} /> : skin ? <span className={styles.face}><img src={skin} alt="" draggable={false} /></span> : null}
  </div>;
}
