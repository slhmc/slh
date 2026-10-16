import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUiText } from "../../i18n/UiText";
import modrinthIcon from "../../assets/provider-icons/modrinth.png";
import curseforgeIcon from "../../assets/provider-icons/curseforge.png";
import styles from "./HomeDiscoverSearch.module.css";

export function HomeDiscoverSearch() {
  const t = useUiText();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"modrinth" | "curseforge">("modrinth");
  return <form className={styles.search} role="search" aria-label={t("home.searchModpacks", "Find a modpack")} onSubmit={event => {
    event.preventDefault();
    navigate(`/discover?${new URLSearchParams({ type: "modpack", source, query: query.trim() })}`);
  }}>
    <input type="search" aria-label={t("home.searchModpacks", "Find a modpack")} placeholder={t("home.modpackExample", "e.g. Cobblemon")} value={query} onChange={event => setQuery(event.target.value)} />
    <div className={styles.providers} role="group" aria-label={t("discover.texts.contentProvider", "Content provider")}>
      {(["modrinth", "curseforge"] as const).map(provider => {
        const name = provider === "modrinth" ? "Modrinth" : "CurseForge";
        return <button key={provider} type="button" aria-label={name} title={name} aria-pressed={source === provider} onClick={() => setSource(provider)}><img src={provider === "modrinth" ? modrinthIcon : curseforgeIcon} alt="" /></button>;
      })}
    </div>
    <button className={styles.submit} type="submit">{t("navigation.discover", "Discover")}</button>
  </form>;
}
