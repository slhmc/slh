import { Check, DotsThreeVertical, FolderOpen, Trash, Wrench } from "../icons";
import type { Instance } from "../../lib/types";
import { InstanceArtwork } from "./InstanceArtwork";
import styles from "./InstanceCard.module.css";
import { useI18n } from "../../i18n/I18nProvider";

interface InstanceCardProps {
  instance: Instance;
  selected: boolean;
  view: "grid" | "list";
  groupName?: string;
  onSelect: () => void;
  onOpenFolder: () => void;
  onSettings: () => void;
  onDelete: () => void;
  progress?: { percentage: number | null; message: string } | null;
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
}

function formatLastPlayed(value: string | null, tr: (source: string) => string, locale: string) {
  if (!value) return tr("Never played");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? tr("Played recently") : `${tr("Played")} ${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}`;
}

export function InstanceCard({ instance, selected, view, groupName, onSelect, onOpenFolder, onSettings, onDelete, progress, onPointerDown }: InstanceCardProps) {
  const { tr, locale } = useI18n();
  const keyboardSelect = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    onSelect();
  };
  const actionMenu = (
    <details name="slh-action-menu" data-action-menu className={styles.actionMenu} onClick={(event) => event.stopPropagation()}>
      <summary role="button" aria-label={`Actions for ${instance.name}`}><DotsThreeVertical size={17} /></summary>
      <div>
        <button type="button" onClick={onOpenFolder}><FolderOpen size={16} /> {tr("Open folder")}</button>
        <button type="button" onClick={onSettings}><Wrench size={16} /> {tr("Settings")}</button>
        <button className={styles.deleteAction} type="button" disabled={instance.status === "running"} onClick={onDelete}><Trash size={16} /> {tr("Delete")}</button>
      </div>
    </details>
  );
  if (view === "list") {
    return (
      <div
        role="button"
        tabIndex={0}
        className={`${styles.listRow} ${selected ? styles.selected : ""}`}
        onClick={onSelect}
        onKeyDown={keyboardSelect}
        aria-pressed={selected}
        onPointerDown={(event) => {
          if (instance.status !== "installing" && instance.status !== "launching") onPointerDown?.(event);
        }}
      >
        <InstanceArtwork instance={instance} size="small" />
        <span className={styles.name}>{instance.name}</span>
        <span>{instance.minecraftVersion}</span>
        <span className={styles.loader}>{instance.loaderType === "bedrock" ? "Bedrock" : instance.loaderType}</span>
        <span>{groupName ?? tr("Ungrouped")}</span>
        <span className={styles.lastPlayed}>{formatLastPlayed(instance.lastPlayedAt, tr, locale)}</span>
        {selected ? <Check className={styles.check} size={16} weight="bold" /> : null}
        {actionMenu}
      </div>
    );
  }
  return (
    <article
      role="button"
      tabIndex={0}
      className={`${styles.card} ${selected ? styles.selected : ""}`}
      onClick={onSelect}
      onKeyDown={keyboardSelect}
      aria-pressed={selected}
      onPointerDown={(event) => {
        if (instance.status !== "installing" && instance.status !== "launching") onPointerDown?.(event);
      }}
    >
      <InstanceArtwork instance={instance} />
      <span className={styles.cardBody}>
        <strong>{instance.name}</strong>
        <small>Minecraft {instance.minecraftVersion} · {instance.loaderType === "neoforge" ? "NeoForge" : instance.loaderType === "bedrock" ? "Bedrock" : instance.loaderType[0].toUpperCase() + instance.loaderType.slice(1)}</small>
      </span>
      {selected ? <span className={styles.selection}><Check size={12} weight="bold" /></span> : null}
      {progress ? <span className={styles.progress} title={progress.message}><span style={{ width: `${progress.percentage ?? 8}%` }} /><strong>{progress.percentage === null ? tr("Importing") : `${progress.percentage}%`}</strong></span> : null}
      {actionMenu}
    </article>
  );
}
