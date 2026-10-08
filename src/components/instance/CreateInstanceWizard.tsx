import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Check,
  Coffee,
  Cube,
  Gauge,
  SpinnerGap,
} from "../icons";
import { command } from "../../lib/tauri";
import type {
  CreateInstanceRequest,
  Instance,
  JavaInstallation,
  LoaderVersion,
  MinecraftVersionSummary,
} from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { Dialog } from "../common/Dialog";
const DiscoverPage = lazy(() => import("../../routes/Discover/DiscoverPage").then((module) => ({ default: module.DiscoverPage })));
import { instanceIconChoices } from "./InstanceArtwork";
import { useI18n } from "../../i18n/I18nProvider";
import common from "../common/Common.module.css";
import styles from "./CreateInstanceWizard.module.css";
import { bedrockToastAction } from "../../lib/bedrock";
import fabricIcon from "../../assets/loader-icons/fabric.png";
import bedrockIcon from "../../assets/loader-icons/bedrock.png";
import forgeIcon from "../../assets/loader-icons/forge.png";
import neoforgeIcon from "../../assets/loader-icons/neoforge.png";
import quiltIcon from "../../assets/loader-icons/quilt.png";
import vanillaIcon from "../../assets/loader-icons/vanilla.png";
import modrinthIcon from "../../assets/provider-icons/modrinth.png";
import curseforgeIcon from "../../assets/provider-icons/curseforge.png";

type Loader = CreateInstanceRequest["loaderType"];
type Edition = "java" | "bedrock";

const instanceArtworkPalette = [
  { background: "#3f493c", foreground: "#f0f4ed" }, { background: "#4d4033", foreground: "#f1e8dd" },
  { background: "#334957", foreground: "#edf4f7" }, { background: "#51352f", foreground: "#f3dfd9" },
  { background: "#43374e", foreground: "#eee7f5" }, { background: "#4b3e32", foreground: "#fff0de" },
];

function randomInstanceArtwork() {
  return instanceArtworkPalette[Math.floor(Math.random() * instanceArtworkPalette.length)];
}

const javaLoaders: Array<{ id: Loader; name: string; description: string; enabled: boolean; iconSrc?: string }> = [
  { id: "vanilla", name: "Vanilla", description: "Unmodified Minecraft from official metadata", enabled: true, iconSrc: vanillaIcon },
  { id: "fabric", name: "Fabric", description: "Lightweight loader for modern modding", enabled: true, iconSrc: fabricIcon },
  { id: "forge", name: "Forge", description: "Established loader with a broad mod catalog", enabled: true, iconSrc: forgeIcon },
  { id: "neoforge", name: "NeoForge", description: "Modern continuation for Forge-style modding", enabled: true, iconSrc: neoforgeIcon },
  { id: "quilt", name: "Quilt", description: "Community-driven Fabric-compatible loader", enabled: true, iconSrc: quiltIcon },
];

const bedrockLoaders: Array<{ id: Loader; name: string; description: string; enabled: boolean; iconSrc?: string }> = [
  { id: "bedrock", name: "Bedrock", description: "Windows package from Microsoft delivery", enabled: true, iconSrc: bedrockIcon },
];

export function CreateInstanceWizard() {
  const open = useAppStore((state) => state.createWizardOpen);
  const setOpen = useAppStore((state) => state.setCreateWizardOpen);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refresh = useAppStore((state) => state.refresh);
  const selectInstance = useAppStore((state) => state.selectInstance);
  const pushToast = useAppStore((state) => state.pushToast);
  const [creationSource, setCreationSource] = useState<"custom" | "modrinth" | "curseforge">("custom");
  const { locale, tr } = useI18n();
  const [edition, setEdition] = useState<Edition>("java");
  const [versions, setVersions] = useState<MinecraftVersionSummary[]>([]);
  const [loadedEdition, setLoadedEdition] = useState<Edition | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionRequest, setVersionRequest] = useState(0);
  const [versionSearch, setVersionSearch] = useState("");
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [version, setVersion] = useState("");
  const [loader, setLoader] = useState<Loader>("vanilla");
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState<string>("");
  const [newGroupName, setNewGroupName] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);
  const [iconKey, setIconKey] = useState("cube");
  const [iconBackground, setIconBackground] = useState("#3f493c");
  const [iconForeground, setIconForeground] = useState("#f0f4ed");
  const [javaMode, setJavaMode] = useState<"auto" | "custom">("auto");
  const [javaPath, setJavaPath] = useState("");
  const [javaCandidates, setJavaCandidates] = useState<JavaInstallation[]>([]);
  const [bedrockProfileMode, setBedrockProfileMode] = useState<"isolated" | "shared">("shared");
  const [memory, setMemory] = useState(4096);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || loadedEdition === edition) return;
    let active = true;
    setVersions([]);
    setVersionsLoading(true);
    setVersionError(null);
    command<MinecraftVersionSummary[]>(edition === "java" ? "list_minecraft_versions" : "list_bedrock_versions")
      .then((items) => {
        if (!active) return;
        setVersions(items);
        // A matching package that Windows already installed through Microsoft
        // Store is the only path that needs neither a CDN download nor loose
        // package registration. Prefer it over an archival release by default.
        const latest = (edition === "bedrock"
          ? items.find((item) => item.installMethod === "registered_store")
          : undefined) ?? items.find((item) => item.versionType === "release");
        if (latest) {
          setVersion(latest.id);
          setName(`Minecraft ${latest.id}`);
        }
        setLoadedEdition(edition);
        setVersionsLoading(false);
      })
      .catch((error) => {
        if (!active) return;
        setVersionError(String((error as { message?: string }).message ?? error));
        setVersionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [edition, loadedEdition, open, versionRequest]);

  useEffect(() => {
    if (!open) return;
    const artwork = randomInstanceArtwork();
    setIconBackground(artwork.background);
    setIconForeground(artwork.foreground);
  }, [open]);

  useEffect(() => {
    if (!open || javaCandidates.length > 0) return;
    let active = true;
    command<JavaInstallation[]>("discover_java", { requiredMajor: null })
      .then((items) => {
        if (active) setJavaCandidates(items);
      })
      .catch(() => {
        if (active) setJavaCandidates([]);
      });
    return () => {
      active = false;
    };
  }, [javaCandidates.length, open]);

  useEffect(() => {
    if (!open) return;
    if (loader === "vanilla" || loader === "bedrock" || !version) {
      setLoaderVersions([]);
      setLoaderVersion("");
      return;
    }
    let active = true;
    setLoaderLoading(true);
    setLoaderVersions([]);
    setLoaderVersion("");
    setFormError(null);
    command<LoaderVersion[]>("list_loader_versions", {
      loaderType: loader,
      minecraftVersion: version,
    })
      .then((items) => {
        if (!active) return;
        setLoaderVersions(items);
        setLoaderVersion(items.find((item) => item.recommended)?.id ?? items[0]?.id ?? "");
      })
      .catch((error) => {
        if (active) {
          setLoaderVersions([]);
          setLoaderVersion("");
          setFormError(String((error as { message?: string }).message ?? error));
        }
      })
      .finally(() => {
        if (active) setLoaderLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loader, open, version]);

  const filteredVersions = useMemo(() => {
    const term = versionSearch.trim().toLowerCase();
    return versions.filter((item) => {
      const installedStoreVersion = edition === "bedrock" && item.installMethod === "registered_store";
      if (!showSnapshots && item.versionType !== "release" && !installedStoreVersion) return false;
      return !term || item.id.toLowerCase().includes(term);
    }).slice(0, 160);
  }, [edition, showSnapshots, versionSearch, versions]);

  const reset = () => {
    setVersionSearch("");
    setCreationSource("custom");
    setEdition("java");
    setVersions([]);
    setLoadedEdition(null);
    setShowSnapshots(false);
    setLoader("vanilla");
    setLoaderVersions([]);
    setLoaderVersion("");
    setGroupId("");
    setNewGroupName("");
    setIconKey("cube");
    const artwork = randomInstanceArtwork();
    setIconBackground(artwork.background);
    setIconForeground(artwork.foreground);
    setJavaMode("auto");
    setJavaPath("");
    setBedrockProfileMode("shared");
    setMemory(bootstrap?.settings.minecraft.memoryMaxMb ?? 4096);
    setFormError(null);
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    reset();
  };

  const chooseVersion = (item: MinecraftVersionSummary) => {
    setVersion(item.id);
    if (!name || /^Minecraft\s/.test(name)) setName(`Minecraft ${item.id}`);
  };

  const chooseEdition = (next: Edition) => {
    if (next === edition) return;
    setEdition(next);
    setVersions([]);
    setLoadedEdition(null);
    setVersion("");
    setVersionSearch("");
    setShowSnapshots(next === "bedrock" ? bootstrap?.settings.bedrock.showPreviewVersions ?? false : false);
    setLoader(next === "bedrock" ? "bedrock" : "vanilla");
    setBedrockProfileMode(next === "bedrock" ? bootstrap?.settings.bedrock.defaultProfileMode ?? "shared" : "shared");
    setLoaderVersions([]);
    setLoaderVersion("");
    setFormError(null);
  };

  const createGroup = async () => {
    const trimmed = newGroupName.trim();
    if (!trimmed || groupBusy) return;
    setGroupBusy(true);
    try {
      const group = await command<{ id: string; name: string }>("create_group", { request: { name: trimmed } });
      setGroupId(group.id);
      setNewGroupName("");
      await refresh();
    } catch (error) {
      setFormError(String((error as { message?: string }).message ?? error));
    } finally {
      setGroupBusy(false);
    }
  };

  const selectedVersion = versions.find((item) => item.id === version);
  const canCreate = Boolean(version)
    && name.trim().length > 0
    && memory >= 512
    && (loader === "vanilla" || loader === "bedrock" || Boolean(loaderVersion))
    && (edition === "bedrock" || javaMode === "auto" || Boolean(javaPath));
  const loaders = edition === "java" ? javaLoaders : bedrockLoaders;

  const openBedrockStore = async () => {
    try {
      await command("open_bedrock_store");
      pushToast({
        tone: "info",
        title: tr("Open Microsoft Store"),
        message: tr("Install Minecraft from Microsoft Store."),
      });
    } catch (error) {
      setFormError(String((error as { message?: string }).message ?? error));
    }
  };

  const create = async () => {
    setBusy(true);
    setFormError(null);
    let created: Instance | null = null;
    const usesRegisteredStorePackage = selectedVersion?.installMethod === "registered_store";
    try {
      created = await command<Instance>("create_instance", {
        request: {
          name: name.trim(),
          groupId: groupId || null,
          minecraftVersion: version,
          loaderType: loader,
          loaderVersion: loader === "vanilla" || loader === "bedrock" ? null : loaderVersion,
          javaPath: edition === "java" && javaMode === "custom" ? javaPath : null,
          memoryMinMb: 512,
          memoryMaxMb: memory,
          iconKey,
          iconBackground,
          iconForeground,
          bedrockProfileMode: edition === "bedrock" ? bedrockProfileMode : "shared",
        } satisfies CreateInstanceRequest,
      });
      await refresh();
      selectInstance(created.id);
      setOpen(false);
      reset();
      pushToast({
        tone: "info",
        title: tr("Installing instance"),
        message: loader === "bedrock"
          ? usesRegisteredStorePackage
            ? tr("Starting the installed Bedrock version.")
            : tr("Checking the Bedrock license.")
          : tr("Downloading Minecraft files."),
      });
      await command<Instance>("install_instance", {
        instanceId: created.id,
      });
      await refresh();
    } catch (error) {
      const message = String((error as { message?: string }).message ?? error);
      if (!created) setFormError(message);
      pushToast({
        tone: "error",
        title: created ? tr("Instance created, but installation failed") : tr("Instance was not created"),
        message,
        action: bedrockToastAction(tr, message),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const startCreate = async () => {
    if (busy) return;
    await create();
  };

  return (
    <>
    <Dialog
      open={open}
      title={tr("Create a Minecraft instance")}
      description={tr("Each instance keeps its own worlds, mods, settings, and launch history.")}
      onClose={close}
      width="xlarge"
    >
      <div className={styles.wizard}>
        <aside className={styles.steps}>
          <button className={`${styles.sourceButton} ${creationSource === "custom" ? styles.sourceCurrent : ""}`} type="button" onClick={() => setCreationSource("custom")}><img className={styles.sourceIcon} src={vanillaIcon} alt="" /><span>{tr("Custom")}</span></button>
          <button className={`${styles.sourceButton} ${creationSource === "modrinth" ? styles.sourceCurrent : ""}`} type="button" onClick={() => setCreationSource("modrinth")}><img className={styles.sourceIcon} src={modrinthIcon} alt="" /><span>Modrinth</span></button>
          <button className={`${styles.sourceButton} ${creationSource === "curseforge" ? styles.sourceCurrent : ""}`} type="button" onClick={() => setCreationSource("curseforge")}><img className={styles.sourceIcon} src={curseforgeIcon} alt="" /><span>CurseForge</span></button>
        </aside>
        {creationSource === "custom" ? <section className={styles.content}>
          <div className={styles.stage}>
            <div className={styles.versionStage}>
                <div className={styles.stageHeader}>
                  <div><h3>{tr("Choose Minecraft")}</h3><p>{tr(edition === "java" ? "Release metadata comes directly from Mojang's official manifest." : "Bedrock versions come from Microsoft delivery metadata. Downloads require a licensed Store/Xbox account; extracted MSIXVC versions also require Windows Developer Mode.")}</p></div>
                  <div className={styles.versionControls}>
                    <div className={styles.editionToggle} role="tablist" aria-label={tr("Minecraft edition")}>
                      <button className={edition === "java" ? styles.activeEdition : ""} type="button" role="tab" aria-selected={edition === "java"} onClick={() => chooseEdition("java")}>{tr("Java")}</button>
                      <button className={edition === "bedrock" ? styles.activeEdition : ""} type="button" role="tab" aria-selected={edition === "bedrock"} disabled={!bootstrap?.settings.bedrock.enabled} title={!bootstrap?.settings.bedrock.enabled ? tr("Enable Bedrock in Settings first") : undefined} onClick={() => chooseEdition("bedrock")}>{tr("Bedrock")}</button>
                    </div>
                    <label className={styles.checkLabel}><input type="checkbox" checked={showSnapshots} onChange={(event) => setShowSnapshots(event.target.checked)} /> {tr(edition === "bedrock" ? "Include preview builds" : "Include snapshots")}</label>
                  </div>
                </div>
                <input className={common.input} value={versionSearch} onChange={(event) => setVersionSearch(event.target.value)} placeholder={tr("Search versions")} aria-label={tr("Search Minecraft versions")} />
                <div className={styles.versionList}>
                  {versionsLoading ? <div className={styles.loading}><SpinnerGap size={22} className={styles.spin} /> {tr("Fetching version manifest")}</div> : null}
                  {versionError ? (
                    <div className={styles.inlineError}>
                      <span>{versionError}</span>
                      <button className={common.secondaryButton} type="button" onClick={() => setVersionRequest((request) => request + 1)}>{tr("Try again")}</button>
                    </div>
                  ) : null}
                  {!versionsLoading && !versionError && edition === "bedrock" && filteredVersions.length === 0 ? (
                    <div className={styles.inlineError}>
                      <span>{tr("No supported Minecraft for Windows package is installed for this Windows user.")}</span>
                      <button className={common.secondaryButton} type="button" onClick={() => void openBedrockStore()}>{tr("Open Microsoft Store")}</button>
                    </div>
                  ) : null}
                  {!versionsLoading && !versionError ? filteredVersions.map((item) => (
                    <button className={`${styles.versionRow} ${version === item.id ? styles.selected : ""}`} type="button" key={item.id} onClick={() => chooseVersion(item)}>
                      {edition === "bedrock" ? <img className={styles.versionIcon} src={bedrockIcon} alt="" /> : <Cube size={18} weight="duotone" />}
                      <span><strong>{item.id}</strong><small>{item.installMethod === "registered_store" ? tr("Already installed from Microsoft Store") : item.status === "downloaded" ? tr("Downloaded; installation can resume") : item.releaseTime ? new Date(item.releaseTime).toLocaleDateString(locale) : tr("Available from Microsoft CDN")}</small></span>
                      <span className={item.versionType === "release" ? common.successBadge : common.warningBadge}>{tr(item.versionType)}</span>
                      {version === item.id ? <Check size={17} weight="bold" /> : null}
                    </button>
                  )) : null}
                </div>
            </div>

            <div className={styles.loaderStage}>
                <div className={styles.stageHeader}><div><h3>{tr(edition === "java" ? "Choose a loader" : "Choose a Bedrock core")}</h3><p>{tr(edition === "java" ? "Only compatibility verified for Minecraft {version} can be selected." : "Bedrock uses the official Windows package; Java loaders do not apply.").replace("{version}", version)}</p></div></div>
                <div className={styles.loaderGrid}>
                  {loaders.map((item) => {
                    return (
                    <button
                      type="button"
                      key={item.id}
                      className={`${styles.loaderCard} ${loader === item.id ? styles.selected : ""}`}
                      disabled={!item.enabled}
                      onClick={() => setLoader(item.id)}
                    >
                      <span className={styles.loaderIcon} title={`${item.name} loader`}>{item.iconSrc ? <img src={item.iconSrc} alt="" /> : <Cube size={27} weight="duotone" />}</span>
                      <span><strong>{tr(item.name)}</strong><small>{tr(item.description)}</small></span>
                      {!item.enabled ? <em>{tr("Adapter pending")}</em> : loader === item.id ? <Check size={17} weight="bold" /> : null}
                    </button>
                  );
                  })}
                </div>
                {loader !== "vanilla" && loader !== "bedrock" && loaders.find((item) => item.id === loader)?.enabled ? (
                  <label className={`${common.field} ${styles.loaderVersionField}`}>
                    <span className={common.label}>{loaders.find((item) => item.id === loader)?.name ?? loader} {tr("version")}</span>
                    <select className={common.select} value={loaderVersion} onChange={(event) => setLoaderVersion(event.target.value)} disabled={loaderLoading || loaderVersions.length === 0}>
                      {loaderLoading ? <option>{tr("Loading compatible versions")}</option> : loaderVersions.map((item) => <option value={item.id} key={item.id}>{item.id}{item.recommended ? ` (${tr("recommended")})` : ""}</option>)}
                    </select>
                    {formError ? <span className={common.hint}>{formError}</span> : null}
                  </label>
                ) : null}
            </div>

            <div className={styles.identityStage}>
                <div className={styles.stageHeader}><div><h3>{tr("Name and organize")}</h3><p>{tr("The stable internal instance ID remains unchanged if you rename it later.")}</p></div></div>
                <div className={styles.formGrid}>
                  <label className={common.field}>
                    <span className={common.label}>{tr("Instance name")}</span>
                    <input className={common.input} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus />
                  </label>
                  <label className={common.field}>
                    <span className={common.label}>{tr("Group")}</span>
                    <select className={common.select} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                      <option value="">{tr("Ungrouped")}</option>
                      {bootstrap?.groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
                    </select>
                  </label>
                  <div className={styles.groupCreate}>
                    <input className={common.input} value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createGroup(); } }} placeholder={tr("New group name")} maxLength={80} aria-label={tr("New group name")} />
                    <button className={common.secondaryButton} type="button" disabled={!newGroupName.trim() || groupBusy} onClick={() => void createGroup()}>{groupBusy ? tr("Adding") : tr("Add group")}</button>
                  </div>
                  <div className={styles.artworkEditor}>
                    <div className={styles.artworkPreview} style={{ background: iconBackground, color: iconForeground }}>
                      {(() => { const Icon = instanceIconChoices.find((choice) => choice.key === iconKey)?.Icon ?? Cube; return <Icon size={32} weight="bold" />; })()}
                    </div>
                    <div className={styles.artworkControls}>
                      <span className={common.label}>{tr("Instance icon")}</span>
                      <div className={styles.iconPicker} role="list" aria-label={tr("Instance icon")}>
                        {instanceIconChoices.map((choice) => {
                          const Icon = choice.Icon;
                          return <button className={iconKey === choice.key ? styles.activeIcon : ""} type="button" key={choice.key} title={choice.label} aria-label={choice.label} aria-pressed={iconKey === choice.key} onClick={() => setIconKey(choice.key)}><Icon size={17} weight="bold" /></button>;
                        })}
                      </div>
                      <div className={styles.colorFields}>
                        <label><span>{tr("Background")}</span><input type="color" value={iconBackground} onChange={(event) => setIconBackground(event.target.value)} /><code>{iconBackground}</code></label>
                        <label><span>{tr("Icon")}</span><input type="color" value={iconForeground} onChange={(event) => setIconForeground(event.target.value)} /><code>{iconForeground}</code></label>
                      </div>
                    </div>
                  </div>
                </div>
            </div>

            {edition === "java" ? <div className={styles.runtimeStage}>
                <div className={styles.stageHeader}><div><h3>{tr("Java and memory")}</h3><p>{tr("SLH validates the runtime again before every launch.")}</p></div></div>
                <div className={styles.javaOptions}>
                  <label className={`${styles.javaOption} ${javaMode === "auto" ? styles.selected : ""}`}>
                    <input type="radio" name="javaMode" checked={javaMode === "auto"} onChange={() => setJavaMode("auto")} />
                    <Coffee size={22} weight="duotone" />
                    <span><strong>{tr("Automatic")}</strong><small>{javaCandidates[0] ? `${tr("Use Java")} ${javaCandidates[0].majorVersion} ${tr("from")} ${javaCandidates[0].source}` : tr("Detect the best compatible installed Java")}</small></span>
                  </label>
                  <label className={`${styles.javaOption} ${javaMode === "custom" ? styles.selected : ""}`}>
                    <input type="radio" name="javaMode" checked={javaMode === "custom"} onChange={() => setJavaMode("custom")} />
                    <Coffee size={22} weight="duotone" />
                    <span><strong>{tr("Custom executable")}</strong><small>{tr("Use an explicit java.exe path for this instance")}</small></span>
                  </label>
                  {javaMode === "custom" ? <input className={common.input} value={javaPath} onChange={(event) => setJavaPath(event.target.value)} placeholder="C:\Program Files\Java\bin\java.exe" /> : null}
                </div>
                <div className={styles.memoryBlock}>
                  <div><Gauge size={20} /><span><strong>{tr("Maximum memory")}</strong><small>{tr("Keep enough RAM available for Windows and other applications.")}</small></span><output>{(memory / 1024).toFixed(memory % 1024 === 0 ? 0 : 1)} {tr("GB")}</output></div>
                  <input type="range" min={1024} max={16384} step={512} value={memory} onChange={(event) => setMemory(Number(event.target.value))} />
                </div>
            </div> : <div className={styles.runtimeStage}>
                <div className={styles.stageHeader}><div><h3>{tr("Bedrock runtime")}</h3><p>{tr("Bedrock runs as a Windows package and does not use Java memory settings.")}</p></div></div>
                <div className={styles.bedrockNotice}><img src={bedrockIcon} alt="" /><span><strong>{tr("Store/Xbox account required")}</strong><small>{tr("Bedrock licensing uses the Windows Store/Xbox account. It is independent from the Java account selected in SLH.")}</small></span></div>
            </div>}

            <div className={styles.reviewStage}>
                <div className={styles.stageHeader}><div><h3>{tr("Review instance")}</h3><p>{tr("Creation begins only after every local value passes backend validation.")}</p></div></div>
                <dl className={styles.review}>
                  <div><dt>{tr("Name")}</dt><dd>{name}</dd></div>
                  <div><dt>{tr("Group")}</dt><dd>{bootstrap?.groups.find((group) => group.id === groupId)?.name ?? tr("Ungrouped")}</dd></div>
                  <div><dt>Minecraft</dt><dd>{version}</dd></div>
                  <div><dt>{tr("Loader")}</dt><dd>{tr(loader)}{loaderVersion ? ` ${loaderVersion}` : ""}</dd></div>
                  <div className={styles.memoryReview}><dt>{tr("Memory")}</dt><dd>{tr("Minimum")} 512 {tr("MB")} · {tr("maximum")} {memory} {tr("MB")}</dd></div>
                </dl>
                {formError ? <div className={styles.inlineError}>{formError}</div> : null}
            </div>
          </div>
          <footer className={styles.footer}>
            <button className={common.ghostButton} type="button" disabled={busy} onClick={close}>{tr("Cancel")}</button>
            <button className={common.button} type="button" disabled={!canCreate || busy} onClick={() => void startCreate()}>
              {busy ? <SpinnerGap className={styles.spin} size={17} /> : <Check size={17} weight="bold" />}
              {busy ? tr("Creating") : tr("Create and install")}
            </button>
          </footer>
        </section> : <section className={styles.catalogContent}>
          <Suspense fallback={<div role="status">{tr("Loading")}</div>}><DiscoverPage initialType="modpack" initialSource={creationSource} hideProviderTabs onClose={() => setCreationSource("custom")} /></Suspense>
        </section>}
      </div>
    </Dialog>
    </>
  );
}
