import { BeautifulHomePage } from "./BeautifulHomePage";
import { ArrowRight, Clock, CloudArrowDown, Coffee, Plus, UserCircle } from "../../components/icons";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../stores/appStore";
import { InstanceArtwork } from "../../components/instance/InstanceArtwork";
import { useI18n } from "../../i18n/I18nProvider";
import common from "../../components/common/Common.module.css";
import page from "../shared/Page.module.css";
import styles from "./HomePage.module.css";

export function HomePage() {
  const beautiful = useAppStore((state) => state.bootstrap?.settings.appearance.beautifulHome !== false);
  return beautiful ? <BeautifulHomePage /> : <ClassicHomePage />;
}

function ClassicHomePage() {
  const { tr, locale } = useI18n();
  const bootstrap = useAppStore((state) => state.bootstrap);
  const openWizard = useAppStore((state) => state.setCreateWizardOpen);
  const select = useAppStore((state) => state.selectInstance);
  const navigate = useNavigate();
  if (!bootstrap) return null;
  const recent = [...bootstrap.instances]
    .sort((a, b) => (b.lastPlayedAt ?? b.createdAt).localeCompare(a.lastPlayedAt ?? a.createdAt))
    .slice(0, 4);
  const active = bootstrap.accounts.find((account) => account.active);
  return (
    <div className={page.page}>
      <header className={page.header}>
        <div>
          <h1>{tr("Ready when you are")}</h1>
          <p data-minimal-text>{tr("Continue an instance, check your runtime, or prepare something new without leaving your library.")}</p>
        </div>
        <button className={common.button} type="button" onClick={() => openWizard(true)}><Plus size={17} weight="bold" /> {tr("New instance")}</button>
      </header>
      <div className={styles.dashboard}>
        <section className={styles.continuePanel}>
          <div className={styles.panelHeading}><h2>{tr("Continue playing")}</h2><span>{recent.length} {tr("recent")}</span></div>
          <div className={styles.recentList}>
            {recent.length === 0 ? <p className={styles.empty}>{tr("Your recently played instances will appear here.")}</p> : recent.map((instance) => (
              <button
                type="button"
                key={instance.id}
                className={styles.recentRow}
                onClick={() => {
                  select(instance.id);
                  navigate("/library");
                }}
              >
                <InstanceArtwork instance={instance} size="small" />
                <span><strong>{instance.name}</strong><small data-minimal-text>Minecraft {instance.minecraftVersion} · {instance.loaderType === "bedrock" ? "Bedrock" : instance.loaderType}</small></span>
                <span className={styles.time}><Clock size={14} /> {instance.lastPlayedAt ? new Date(instance.lastPlayedAt).toLocaleDateString(locale) : tr("Not played")}</span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </section>
        <aside className={styles.statusPanel}>
          <div className={styles.statusHeader}><h2>{tr("Launcher status")}</h2><span className={common.successBadge}>{tr("Local")}</span></div>
          <div className={styles.statusRows}>
            <div><UserCircle size={19} /><span><small data-minimal-text>{tr("Active account")}</small><strong>{active?.username ?? tr("Not selected")}</strong></span></div>
            <div><Coffee size={19} /><span><small data-minimal-text>{tr("Java selection")}</small><strong>{bootstrap.settings.minecraft.javaMode === "auto" ? tr("Automatic") : tr("Custom")}</strong></span></div>
            <div><CloudArrowDown size={19} /><span><small data-minimal-text>{tr("Downloads")}</small><strong>{bootstrap.settings.downloads.concurrency} {tr("concurrent")}</strong></span></div>
          </div>
          <div className={styles.portable}><small data-minimal-text>{tr("Data folder")}</small><code>{bootstrap.portableRoot}</code></div>
        </aside>
      </div>
      <section className={page.section}>
        <div className={page.sectionHeader}><h2>{tr("Quick actions")}</h2></div>
        <div className={styles.quickActions}>
          <button type="button" onClick={() => openWizard(true)}><Plus size={20} /><span><strong>{tr("Create instance")}</strong><small data-minimal-text>{tr("Install a clean Minecraft version")}</small></span></button>
          <button type="button" onClick={() => navigate("/discover")}><CloudArrowDown size={20} /><span><strong>{tr("Browse Discover")}</strong><small data-minimal-text>{tr("Explore content from Modrinth")}</small></span></button>
          <button type="button" onClick={() => navigate("/settings/java")}><Coffee size={20} /><span><strong>{tr("Check Java")}</strong><small data-minimal-text>{tr("Review detected runtimes")}</small></span></button>
        </div>
      </section>
    </div>
  );
}
