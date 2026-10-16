import { useLayoutEffect, useRef } from "react";

/** Keep complete words on a line; normal wrapping between words is retained. */
export function AutoFitTitle({ text, enabled }: { text: string; enabled: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let alive = true;
    let observedWidth = -1;
    let frame = 0;
    const fit = () => {
      if (!alive) return;
      element.style.fontSize = "";
      if (!enabled || element.clientWidth === 0) return;
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas").getContext("2d");
      if (!canvas) return;
      let size = Math.ceil(parseFloat(style.fontSize));
      const words = text.split(/\s+/);
      while (size > 10) {
        canvas.font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
        if (words.every(word => canvas.measureText(word).width <= element.clientWidth)) break;
        size -= 1;
      }
      element.style.fontSize = `${size}px`;
    };
    const observer = new ResizeObserver(() => {
      // Font fitting changes height. Only a new width needs another fit;
      // defer it outside the observer delivery to avoid a resize loop.
      if (observedWidth === element.clientWidth) return;
      observedWidth = element.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", fit);
    void document.fonts.ready.then(fit);
    fit();
    return () => { alive = false; cancelAnimationFrame(frame); observer.disconnect(); document.fonts.removeEventListener("loadingdone", fit); };
  }, [text, enabled]);
  return <h2 ref={ref} title={text} style={enabled ? { overflowWrap: "normal", wordBreak: "normal" } : undefined}>{text}</h2>;
}
