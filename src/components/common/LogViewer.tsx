import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConsoleLine, ConsoleSettings } from "../../lib/types";
import { classifyConsoleLine, formatConsoleText } from "../../lib/consolePresentation";
import { useUiText } from "../../i18n/UiText";
import { Button } from "./Controls";
import { ErrorText } from "./ErrorText";
import { Dialog } from "./Dialog";
import { Check, DotsThreeVertical, Minus } from "../icons";
import common from "./Common.module.css";
import styles from "./LogViewer.module.css";

type LogLine = { text: string; stream?: string; level?: ConsoleLine["level"]; seq?: number };
export function LogViewer({ lines, settings, onSettingsChange, onClear, label, emptyText, actions, compact = false }: {
  lines: LogLine[]; settings: ConsoleSettings; onSettingsChange: (patch: Partial<ConsoleSettings>) => void;
  onClear: () => void; label: string; emptyText: string; actions?: ReactNode; compact?: boolean;
}) {
  const t = useUiText();
  const [query, setQuery] = useState("");
  const [copyError, setCopyError] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const output = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const visible = lines.filter(line => line.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    if (settings.autoScroll && following.current && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [lines, query, settings.autoScroll]);
  const bottom = () => {
    following.current = true;
    setPaused(false);
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
  };
  const tools = <>
    <Button aria-pressed={settings.wrapLines} onClick={() => onSettingsChange({ wrapLines: !settings.wrapLines })}>{t("instance.texts.wrap")}: {t(settings.wrapLines ? "instance.texts.on" : "instance.texts.off")}</Button>
    <Button disabled={!visible.length} onClick={() => { void navigator.clipboard.writeText(visible.map(line => line.text).join("\n")).then(() => setCopyError("")).catch(() => setCopyError(t("instance.texts.windowsDidNotGrantClipboardAccess"))); }}>{t("installation.texts.copy")}</Button>
    <Button disabled={!lines.length} onClick={() => { onClear(); setOptionsOpen(false); }}>{t("instance.texts.clearView")}</Button>
    {actions}
  </>;
  return <div className={styles.viewer} data-log-viewer>
    {!compact ? <div className={styles.tools}>
      <Button aria-pressed={settings.autoScroll} onClick={() => { following.current = true; onSettingsChange({ autoScroll: !settings.autoScroll }); }}>{t("instance.texts.follow")}: {t(settings.autoScroll ? "instance.texts.on" : "instance.texts.off")}</Button>
      {tools}
    </div> : null}
    <div className={styles.search}>
      <input className={common.input} aria-label={t("instance.texts.findInLog")} placeholder={t("instance.texts.findInLog")} value={query} onChange={event => setQuery(event.target.value)} />
      <span>{visible.length} {t("instance.texts.shown")}</span>
      {compact ? <>
        <Button className={styles.followButton} aria-pressed={settings.autoScroll && !paused} title={t("serverWorkspace.autoScrollHint")} onClick={() => {
          if (settings.autoScroll && !paused) onSettingsChange({ autoScroll: false });
          else { bottom(); if (!settings.autoScroll) onSettingsChange({ autoScroll: true }); }
        }}>{settings.autoScroll && !paused ? <Check size={16} /> : <Minus size={16} />}{t("serverWorkspace.autoScroll")}</Button>
        <Button onClick={() => setOptionsOpen(true)} aria-haspopup="dialog"><DotsThreeVertical size={16} />{t("serverWorkspace.consoleActions")}</Button>
      </> : <Button onClick={bottom}>{t("instance.texts.bottom")}</Button>}
    </div>
    <div ref={output} className={`${styles.output} ${settings.wrapLines ? styles.wrap : ""}`} aria-label={label} tabIndex={0}
      style={{ background: settings.background, color: settings.foreground, fontSize: `${settings.fontSize}px` }}
      onScroll={event => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; setPaused(!following.current); }}>
      {!lines.length ? <div className={styles.empty}>{emptyText}</div> : visible.map((line, index) => <div key={line.seq ?? index} className={styles.line} data-log-level={line.level ?? classifyConsoleLine(line.text, line.stream)} style={{ color: settings[line.level ?? classifyConsoleLine(line.text, line.stream)] }}>{formatConsoleText(line.text, settings.showTimestamps)}</div>)}
    </div>
    {copyError ? <ErrorText message={copyError} /> : null}
    {compact ? <Dialog open={optionsOpen} title={t("serverWorkspace.consoleActions")} onClose={() => setOptionsOpen(false)} width="small" footer={<Button onClick={() => setOptionsOpen(false)}>{t("common.close")}</Button>}><div className={styles.options}>{tools}</div>{copyError ? <ErrorText message={copyError} /> : null}</Dialog> : null}
  </div>;
}
