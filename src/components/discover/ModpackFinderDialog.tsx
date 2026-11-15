import { useEffect, useRef, useState } from "react";
import { useUiText } from "../../i18n/UiText";
import { genreTerms, type FinderRequest, type PackCandidate } from "../../lib/modpackFinder";
import { filteredRandomPack, type RandomPackOptions } from "../../lib/modpackFinderSearch";
import { Dialog } from "../common/Dialog";
import { Button } from "../common/Controls";
import { ErrorText } from "../common/ErrorText";
import { ArrowClockwise } from "../icons";
import common from "../common/Common.module.css";
import styles from "./ModpackFinder.module.css";

function initialOptions(): RandomPackOptions {
  try {
    const saved = JSON.parse(sessionStorage.getItem("slh.randomPackOptions") ?? "null");
    if (saved && ["any", "more", "less", "closest"].includes(saved.downloadsMode) && Number.isSafeInteger(saved.downloads) && saved.downloads >= 0 && Array.isArray(saved.genres)) {
      return { ...saved, genres: saved.genres.filter((genre: string) => genre in genreTerms) };
    }
  } catch { /* Use the default filters. */ }
  return { genres: [], downloadsMode: "any", downloads: 100000 };
}
export function ModpackFinderDialog({ request, onClose, onSelect }: { request: FinderRequest; onClose: () => void; onSelect: (candidate: PackCandidate) => void }) {
  const t = useUiText();
  const [options, setOptions] = useState(initialOptions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const valid = options.downloadsMode === "any" || Number.isSafeInteger(options.downloads) && options.downloads >= 0;
  const pick = async () => {
    if (!valid || busy) return;
    const ticket = ++generation.current;
    setBusy(true); setError(""); setEmpty(false);
    try {
      const applied = { ...options, downloads: Number.isSafeInteger(options.downloads) && options.downloads >= 0 ? options.downloads : 0 };
      const candidate = await filteredRandomPack(applied, request.exclude, request.excludeTitle);
      if (ticket !== generation.current) return;
      sessionStorage.setItem("slh.randomPackOptions", JSON.stringify(applied));
      if (candidate) onSelect(candidate); else setEmpty(true);
    } catch (reason) { if (ticket === generation.current) setError(String((reason as Error).message ?? reason)); }
    finally { if (ticket === generation.current) setBusy(false); }
  };
  return <Dialog open title={t("packFinder.random")} description={t("packRandom.hint")} width="large" onClose={onClose} footer={<>
    <Button onClick={onClose}>{t("common.cancel")}</Button>
    <Button variant="primary" busy={busy} disabled={!valid} icon={<ArrowClockwise size={17} />} onClick={() => void pick()}>{t("packRandom.pick")}</Button>
  </>}>
    <div className={styles.content} data-modpack-finder>
      <fieldset disabled={busy} className={styles.genres}>
        <legend>{t("packFinder.genre")}</legend>
        <div className={styles.chips}>{Object.keys(genreTerms).map(genre => <button key={genre} type="button" aria-pressed={options.genres.includes(genre)} onClick={() => setOptions(current => ({ ...current, genres: current.genres.includes(genre) ? current.genres.filter(value => value !== genre) : [...current.genres, genre] }))}>{t(`packFinder.genres.${genre}`)}</button>)}</div>
      </fieldset>
      <div className={styles.questions}>
        <label className={common.field}><span className={common.label}>{t("packRandom.downloads")}</span><select className={common.select} disabled={busy} value={options.downloadsMode} onChange={event => setOptions({ ...options, downloadsMode: event.target.value as RandomPackOptions["downloadsMode"] })}>{(["any", "more", "less", "closest"] as const).map(mode => <option key={mode} value={mode}>{t(`packRandom.modes.${mode}`)}</option>)}</select></label>
        <label className={common.field}><span className={common.label}>{t("packRandom.target")}</span><input type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} disabled={busy || options.downloadsMode === "any"} className={common.input} value={Number.isNaN(options.downloads) ? "" : options.downloads} onChange={event => setOptions({ ...options, downloads: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
      </div>
      <p className={styles.hint}>{t("packRandom.scope")}</p>
      {!valid ? <p role="alert" className={styles.notice}>{t("packRandom.invalidDownloads")}</p> : null}
      {busy ? <p role="status" className={styles.hint}>{t("packFinder.searching")}</p> : null}
      {empty ? <p role="status" className={styles.notice}>{t("packRandom.empty")}</p> : null}
      {error ? <p role="alert" className={styles.notice}><ErrorText message={error} /></p> : null}
    </div>
  </Dialog>;
}
