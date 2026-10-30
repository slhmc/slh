import { useI18n } from "../../i18n/I18nProvider";
import type { HTMLAttributes, ReactNode } from "react";
import { useUiText } from "../../i18n/UiText";
import { AutoFitTitle } from "./AutoFitTitle";
import { DownloadSimple, MagnifyingGlass, PuzzlePiece, SpinnerGap, Star } from "../icons";
import type { ModrinthProject } from "../../lib/types";
import modrinthIcon from "../../assets/provider-icons/modrinth.png";
import curseforgeIcon from "../../assets/provider-icons/curseforge.png";
import common from "./Common.module.css";
import styles from "../../routes/Discover/DiscoverPage.module.css";

export function ContentProjectCard({ children, className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <article {...props} className={`${styles.projectCard} ${className}`}>{children}</article>;
}
export function ContentProjectSummary({ project, fitTitle, typeLabel, children }: { project: ModrinthProject; fitTitle?: boolean; typeLabel: string; children?: ReactNode }) {
  const t = useUiText();
  const { locale } = useI18n();
  const numbers = new Intl.NumberFormat(locale, { notation: "compact" });
  return <>
    <div className={styles.artwork}>{project.iconUrl ? <img src={project.iconUrl} alt="" loading="lazy" /> : <PuzzlePiece size={40} />}</div>
    <div className={styles.projectBody} data-content-provider="true">
      <div className={styles.projectTitle}><div><AutoFitTitle text={project.title} enabled={fitTitle === true} /><span>{t("installation.texts.by")} {project.author}</span></div><span className={common.badge}>{typeLabel}</span></div>
      <p>{project.description}</p>
      <div className={styles.projectMeta}><span><DownloadSimple size={14} />{numbers.format(project.downloads)}</span><span><Star size={14} />{numbers.format(project.follows)}</span><span>{project.versions[0] ?? t("installation.texts.multipleVersions")}</span></div>
      {children}
    </div>
  </>;
}
export function ContentProviders({ value, onChange, options }: { value: string; onChange: (provider: "modrinth" | "curseforge") => void; options?: (provider: "modrinth" | "curseforge") => { disabled?: boolean; available?: boolean; title?: string; suffix?: string } }) {
  const t = useUiText();
  return <div className={styles.sourceStatus} aria-label={t("discover.texts.contentProvider")}>
    {(["modrinth", "curseforge"] as const).map(provider => { const option = options?.(provider); return <button type="button" key={provider} disabled={option?.disabled} title={option?.title} aria-pressed={value === provider} className={`${value === provider ? styles.sourceActive : ""} ${option?.available === false ? styles.sourceUnavailable : styles.sourceAvailable}`} onClick={() => onChange(provider)}><img className={styles.providerIcon} src={provider === "modrinth" ? modrinthIcon : curseforgeIcon} alt="" /><span />{provider === "modrinth" ? "Modrinth" : "CurseForge"}{option?.suffix}</button>; })}
  </div>;
}
export function ContentSearch({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return <label className={styles.searchBox}><MagnifyingGlass size={19} /><input aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)} /></label>;
}
export function ContentLoading({ children }: { children?: ReactNode }) {
  const t = useUiText();
  return <div role="status" className={styles.loading}><SpinnerGap size={25} className={styles.spin} />{children ?? t("common.loading")}</div>;
}
export function ContentPagination({ children }: { children: ReactNode }) {
  return <div className={styles.loadMore}>{children}</div>;
}

export function ContentEmpty({ children }: { children?: ReactNode }) {
  const t = useUiText();
  return <div className={styles.emptyResult}><PuzzlePiece size={34} /><h2>{children ?? t("installation.texts.noProjectsFound")}</h2></div>;
}
