import { SettingGrid, SettingLayout, SettingRow, Toggle } from "../settings/SettingControls";
import { serverVersionAtLeast } from "../../lib/serverLive";
import { ServerLiveSettings } from "./ServerLiveSettings";
import { ServerMemoryEditor } from "./ServerMemoryEditor";
import { ServerPlayerList } from "./ServerPlayerList";
import { ServerWhitelistToggle } from "./ServerWhitelistToggle";
import { stoppedServer } from "../../lib/localServers";
import type { LocalServer } from "../../lib/localServers";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ErrorText } from "../common/ErrorText";
import { useEffect, useId, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { readServerProperties, serverCores, type ServerCatalog, type ServerConfig } from "../../lib/localServers";
import { Button } from "../common/Controls";
import { Coffee, Cube, GlobeHemisphereWest, ShieldCheck, SlidersHorizontal, Wrench } from "../icons";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";

export function ServerConfigFields({ value, onChange, pinned = false, defaults = false, mode = "tabs", server, onMemorySaved }: {
  value: ServerConfig; onChange: (next: ServerConfig) => void; pinned?: boolean; defaults?: boolean; mode?: "tabs" | "cards"; server?: LocalServer; onMemorySaved?: (server: LocalServer) => void;
}) {
  const t = useUiText();
  const rustEnabled = useAppStore(state => state.bootstrap?.settings.general.rustMinecraft === true);
  const [section,setSection]=useState(server ? "players" : "core");
  const [playerKind, setPlayerKind] = useState<"whitelist" | "operators" | "bannedPlayers" | "bannedIps">("whitelist");
  const formId=useId();
  const rawRef = useRef<HTMLTextAreaElement>(null);
  const highlightsRef = useRef<HTMLPreElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [rawSearch, setRawSearch] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const matches: number[] = [];
  if (rawSearch) {
    const text = value.propertiesText.toLocaleLowerCase();
    const query = rawSearch.toLocaleLowerCase();
    for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + 1)) matches.push(at);
  }
  useEffect(() => {
    const editor = rawRef.current;
    if (!editor || !rawSearch) { setMatchIndex(-1); return; }
    const at = value.propertiesText.toLocaleLowerCase().indexOf(rawSearch.toLocaleLowerCase());
    setMatchIndex(at < 0 ? -1 : 0);
    editor.setSelectionRange(Math.max(0, at), at < 0 ? 0 : at + rawSearch.length);
    if (at < 0) return;
    // Measure wrapped lines without focusing the editor or changing its text.
    const mirror = document.createElement("div");
    const computed = getComputedStyle(editor);
    for (const key of ["font", "lineHeight", "letterSpacing", "padding", "border", "boxSizing", "tabSize"] as const) mirror.style[key] = computed[key];
    Object.assign(mirror.style, { position: "fixed", visibility: "hidden", width: `${editor.clientWidth}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word" });
    mirror.textContent = value.propertiesText.slice(0, at);
    const marker = document.createElement("span");
    marker.textContent = value.propertiesText.slice(at, at + rawSearch.length);
    mirror.append(marker);
    document.body.append(mirror);
    editor.scrollTop = Math.max(0, marker.offsetTop - editor.clientHeight / 2);
    mirror.remove();
    if (highlightsRef.current) highlightsRef.current.scrollTop = editor.scrollTop;
  }, [rawSearch, value.propertiesText]);
  const selectMatch = (index: number) => {
    if (!matches.length || !rawRef.current) return;
    const next = (index + matches.length) % matches.length;
    setMatchIndex(next);
    rawRef.current.focus();
    rawRef.current.setSelectionRange(matches[next], matches[next] + rawSearch.length);
  };
  useEffect(() => {
    const handleFind = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && section === "advanced" && rawRef.current?.getClientRects().length) {
        event.preventDefault();
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handleFind);
    return () => window.removeEventListener("keydown", handleFind);
  }, [section]);
  const locked = !!server && !stoppedServer(server);
  const modernProperties = serverVersionAtLeast(value.minecraftVersion, 21, 9);
  const sections = [...(server ? ["players", "live"] : []),"core","java","world","network","access","advanced"];
  const sectionIcons = [...(server ? [ShieldCheck, GlobeHemisphereWest] : []), Cube, value.core === "horizon" ? Cube : Coffee, GlobeHemisphereWest, SlidersHorizontal, ShieldCheck, Wrench];
  const sectionLabel = (key: string) => t(key === "live" ? "serverLive.section" : key === "players" ? "serverPlayers.section" : value.core === "horizon" && key === "java" ? "localServers.consoleMode" : `serverWorkspace.sections.${key}`);
  const current = useRef({value,onChange}); current.current = {value,onChange};
  const [catalog, setCatalog] = useState<ServerCatalog | null>(null);
  const [versions, setVersions] = useState<ServerCatalog["versions"]>([]);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [prerelease, setPrerelease] = useState(false);
  const update = <K extends keyof ServerConfig>(key: K, next: ServerConfig[K]) => onChange({ ...value, [key]: next });
  const property = (key: string, next: string) => update("properties", { ...value.properties, [key]: next });
  useEffect(() => {
    if (pinned) return;
    let alive = true; setLoading(true); setError("");
    void command<ServerCatalog>("local_server_catalog", { core: value.core, minecraftVersion: null }).then(result => {
      if (!alive) return; setCatalog(result);
      if (!defaults && !current.current.value.minecraftVersion) {
        const latest = result.minecraftVersions.find(v => /^\d+\.\d+(\.\d+)?$/.test(v));
        if (latest) current.current.onChange({...current.current.value,minecraftVersion:latest,coreVersion:""});
      }
    }).catch(reason => { if (alive) setError(String(reason.message ?? reason)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [value.core, pinned]);
  useEffect(() => {
    if (pinned || !value.minecraftVersion) { setVersions([]); return; }
    let alive = true; setLoading(true);
    void command<ServerCatalog>("local_server_catalog", { core: value.core, minecraftVersion: value.minecraftVersion }).then(result => {
      if (!alive) return; setVersions(result.versions); setError("");
      if (!current.current.value.coreVersion && result.versions.length) current.current.onChange({...current.current.value,coreVersion:(result.versions.find(v => v.stable) ?? result.versions[0]).id});
    }).catch(reason => { if (alive) { setError(String(reason.message ?? reason)); setVersions([]); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [value.core, value.minecraftVersion, pinned]);
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => void command<string>("preview_server_launch", { config: value }).then(text => { if (alive) setPreview(text); }).catch(() => { if (alive) setPreview(""); }), 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [value]);
  const games = (catalog?.minecraftVersions ?? []).filter(v => prerelease || /^\d+\.\d+(\.\d+)?$/.test(v));
  const chooseFile = async (key: "javaPath" | "jdkPath" | "gitPath" | "customJar") => {
    const selected = await openDialog({ multiple: false, ...(key === "customJar" ? { filters: [{ name: "JAR", extensions: ["jar"] }] } : {}) });
    if (typeof selected === "string") update(key, selected);
  };
  const input = (key: string, type = "text", min?: number, max?: number) => <SettingRow key={key} title={t(`localServers.properties.${key}`)}><input className={common.input} type={type} min={min} max={max} value={value.properties[key] ?? ""} onChange={e => property(key, e.target.value)} /></SettingRow>;
  const select = (key: string, options: string[]) => <SettingRow key={key} title={t(`localServers.properties.${key}`)}><select className={common.select} value={value.properties[key]} onChange={e => property(key, e.target.value)}>{options.map(option => <option value={option} key={option}>{t(`localServers.values.${option}`)}</option>)}</select></SettingRow>;
  const tabs = <div className={styles.formTabs} role="tablist" aria-orientation="vertical" aria-label={t("serverWorkspace.configuration")}>
    {sections.map((key,index)=>{ const Icon = sectionIcons[index]; return <button key={key} id={`${formId}-${key}`} type="button" role="tab" aria-label={sectionLabel(key)} title={sectionLabel(key)} aria-selected={section===key} aria-controls={`${formId}-panel-${key}`} tabIndex={section===key?0:-1} onClick={()=>setSection(key)} onKeyDown={e=>{if(!["ArrowRight","ArrowLeft","ArrowDown","ArrowUp","Home","End"].includes(e.key))return;e.preventDefault();const next=e.key==="Home"?sections[0]:e.key==="End"?sections[sections.length-1]:sections[(index+(["ArrowRight", "ArrowDown"].includes(e.key)?1:sections.length-1))%sections.length];setSection(next);document.getElementById(`${formId}-${next}`)?.focus();}}><Icon size={16} /><span data-minimal-text>{sectionLabel(key)}</span></button>; })}
  </div>;
  const cardNavigation = <nav className={styles.formTabs} aria-label={t("serverWorkspace.configuration")}>{sections.map((key, index) => {
    const Icon = sectionIcons[index];
    return <button key={key} type="button" onClick={() => document.getElementById(`${formId}-panel-${key}`)?.scrollIntoView({ block: "start" })}><Icon size={16} /><span>{sectionLabel(key)}</span></button>;
  })}</nav>;
  const panel=(key:string,content:React.ReactNode)=><section hidden={mode==="tabs"&&section!==key} role={mode==="tabs"?"tabpanel":undefined} id={`${formId}-panel-${key}`} aria-labelledby={mode==="tabs"?`${formId}-${key}`:undefined} className={styles.formSection}><h3>{sectionLabel(key)}</h3>{server && key !== "live" ? <p className={styles.note}>{t(key === "players" ? "serverPlayers.applyImmediately" : key === "java" ? "serverLive.launchHint" : "serverWorkspace.stoppedSettingsHint")}</p> : null}{key === "java" && server && value.core !== "horizon" ? <ServerMemoryEditor server={server} onSaved={onMemorySaved} /> : null}<fieldset className={styles.config} disabled={locked && !["players", "live"].includes(key)}>{mode==="cards"?<div className={styles.cardFormBody}>{content}</div>:content}</fieldset></section>;
  return <SettingLayout><div className={`${styles.formShell} ${mode==="cards"?styles.cardForm:server?styles.serverForm:""}`}>{mode==="tabs"?tabs:cardNavigation}<div className={styles.formContent}>
    {server ? panel("live", <ServerLiveSettings server={server} visible={mode === "cards" || section === "live"} />) : null}
    {panel("core",<><SettingGrid fitContent>
      <SettingRow title={t("localServers.core")} description={value.core === "horizon" ? t("localServers.horizonHint") : undefined}><select className={common.select} value={value.core} disabled={pinned} onChange={e => onChange({ ...value, core: e.target.value as ServerConfig["core"], minecraftVersion: "", coreVersion: "" })}>{serverCores.filter(core => core !== "horizon" || rustEnabled || value.core === "horizon").map(core => <option value={core} key={core}>{t(`localServers.cores.${core}`)}</option>)}</select></SettingRow>
      <SettingRow title={t("localServers.minecraftVersion")}><select className={common.select} disabled={pinned || loading} value={value.minecraftVersion} onChange={e => onChange({ ...value, minecraftVersion: e.target.value, coreVersion: "" })}><option value="">{t(defaults ? "localServers.latestRelease" : "localServers.chooseVersion")}</option>{pinned ? <option value={value.minecraftVersion}>{value.minecraftVersion}</option> : games.map(v => <option key={v} value={v}>{v}</option>)}</select></SettingRow>
      <SettingRow title={t("localServers.coreVersion")}><select className={common.select} disabled={pinned || loading || !value.minecraftVersion} value={value.coreVersion} onChange={e => update("coreVersion", e.target.value)}><option value="">{t(defaults && !value.minecraftVersion ? "localServers.latestRelease" : "localServers.chooseBuild")}</option>{pinned ? <option value={value.coreVersion}>{value.coreVersion}</option> : versions.filter(v => prerelease || v.stable || v.id === value.coreVersion).map(v => <option key={v.id} value={v.id}>{v.id}{v.stable ? "" : ` Р’В· ${t("localServers.prerelease")}`}</option>)}</select></SettingRow>
    </SettingGrid>{!pinned ? <SettingRow title={t("localServers.showPrereleases")}><Toggle role="checkbox" checked={prerelease} onChange={setPrerelease} /></SettingRow> : null}
    {error ? <p className={styles.error} role="alert"><ErrorText message={error} /></p> : null}
    {!loading && value.minecraftVersion && !pinned && versions.length === 0 && !error ? <p className={styles.note}>{t("localServers.noBuilds")}</p> : null}
    {value.core === "custom" ? <SettingRow wide title={t("localServers.chooseJar")}><div className={styles.path}><code>{value.customJar ?? t("localServers.chooseJar")}</code><Button disabled={pinned} onClick={() => void chooseFile("customJar")}>{t("localServers.chooseJar")}</Button></div></SettingRow> : null}
    </>)}
    {panel("java",<>{value.core !== "horizon" ? <>
      <SettingRow wide title={t("settings.javaExecutable")}><div className={styles.path}><code>{value.javaPath ?? t("localServers.automaticJava")}</code><Button onClick={() => void chooseFile("javaPath")}>{t("localServers.chooseJava")}</Button>{value.javaPath ? <Button variant="ghost" onClick={() => update("javaPath", null)}>{t("localServers.automaticJava")}</Button> : null}</div></SettingRow>
      <SettingGrid fitContent>
        {!server ? <><SettingRow title={t("localServers.memoryMin")}><input className={common.input} type="number" min={128} max={1048576} value={value.memoryMinMb} onChange={e => update("memoryMinMb", Number(e.target.value))} /></SettingRow>
        <SettingRow title={t("localServers.memoryMax")}><input className={common.input} type="number" min={128} max={1048576} value={value.memoryMaxMb} onChange={e => update("memoryMaxMb", Number(e.target.value))} /></SettingRow></> : null}
        <SettingRow title={t("localServers.flags")}><select className={common.select} value={value.flags} onChange={e => update("flags", e.target.value as ServerConfig["flags"])}>{["ordinary", "aikar", "custom"].map(mode => <option value={mode} key={mode}>{t(`localServers.flagModes.${mode}`)}</option>)}</select></SettingRow>
      </SettingGrid>
      {value.flags === "custom" ? <SettingRow title={t("localServers.jvmArgs")} description={t("localServers.argumentHint")} wide><textarea className={common.input} rows={5} value={value.jvmArgs.join("\n")} onChange={e => update("jvmArgs", e.target.value.split("\n").filter(Boolean))} /></SettingRow> : null}
      </> : null}
      <SettingRow title={t("localServers.serverArgs")} wide><textarea className={common.input} rows={2} value={value.serverArgs.join("\n")} onChange={e => update("serverArgs", e.target.value.split("\n").filter(Boolean))} /></SettingRow>
      <SettingRow title={t("localServers.consoleMode")}><select className={common.select} value={value.console} onChange={e => update("console", e.target.value as ServerConfig["console"])}>{["builtin", "external", "hidden"].map(mode => <option key={mode} value={mode}>{t(`localServers.consoleModes.${mode}`)}</option>)}</select></SettingRow>
      {preview ? <details><summary>{t("localServers.commandPreview")}</summary><pre className={styles.command}>{preview}</pre></details> : null}
      {value.core === "spigot" || value.core === "bukkit" ? <details><summary>{t("localServers.buildTools")}</summary><p className={styles.note}>{t("localServers.buildToolsHint")}</p><Button variant="ghost" onClick={() => void openUrl("https://www.spigotmc.org/wiki/buildtools/")}>{t("localServers.buildToolsInstructions")}</Button>{(["jdkPath", "gitPath"] as const).map(key => <div className={styles.path} key={key}><code>{value[key] ?? t(`localServers.${key}`)}</code><Button onClick={() => void chooseFile(key)}>{t(`localServers.${key}`)}</Button>{value[key] ? <Button variant="ghost" onClick={() => update(key, null)}>{t("localServers.reset")}</Button> : null}</div>)}</details> : null}
    </>)}
    {panel("world",<><SettingGrid fitContent>{input("level-name")}{input("level-seed")}{select("gamemode",["survival","creative","adventure","spectator"])}{select("difficulty",["peaceful","easy","normal","hard"])}{select("level-type",["minecraft:normal","minecraft:flat"])}</SettingGrid><SettingGrid fitContent>{["hardcore","generate-structures", ...(modernProperties ? [] : ["allow-nether"])].map(key=><SettingRow key={key} title={t(`localServers.properties.${key}`)}><Toggle role="checkbox" checked={value.properties[key]==="true"} onChange={checked=>property(key,String(checked))} /></SettingRow>)}</SettingGrid></>)}
    {panel("network",<><SettingGrid fitContent>{input("server-port","number",1,65535)}{input("max-players","number",1,100000)}{input("server-ip")}{input("motd")}{input("view-distance","number",2,32)}{(!value.minecraftVersion||/^((1\.(18|19|2\d))|([2-9]\d\.))/.test(value.minecraftVersion))?input("simulation-distance","number",2,32):null}</SettingGrid></>)}
    {panel("access",<><SettingGrid fitContent>{["online-mode", ...(!server ? ["white-list"] : []), ...(!modernProperties ? ["pvp","enable-command-block"] : []), "allow-flight"].map(key=><SettingRow key={key} title={t(`localServers.properties.${key}`)}><Toggle role="checkbox" checked={value.properties[key]==="true"} onChange={checked=>property(key,String(checked))} /></SettingRow>)}</SettingGrid><SettingGrid fitContent>{input("spawn-protection","number",0,65535)}</SettingGrid></>)}
    {server ? panel("players",<>
      {locked ? <ServerWhitelistToggle server={server} visible={mode === "cards" || section === "players"} enabled={value.properties["white-list"] === "true"} /> : <SettingRow title={t("localServers.properties.white-list")} description={t("serverPlayers.whitelistHint")} wide><Toggle role="checkbox" checked={value.properties["white-list"] === "true"} onChange={checked => property("white-list", String(checked))} /></SettingRow>}
      <div className={styles.playerNavigation} role="tablist" aria-label={t("serverPlayers.section")}>
        {(["whitelist", "operators", "bannedPlayers", "bannedIps"] as const).map((kind, index, kinds) => <button key={kind} id={`${formId}-players-${kind}`} type="button" role="tab" aria-selected={playerKind === kind} aria-controls={`${formId}-players-panel-${kind}`} tabIndex={playerKind === kind ? 0 : -1} onClick={() => setPlayerKind(kind)} onKeyDown={event => { if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? kinds[0] : event.key === "End" ? kinds[kinds.length - 1] : kinds[(index + (event.key === "ArrowRight" ? 1 : kinds.length - 1)) % kinds.length]; setPlayerKind(next); document.getElementById(`${formId}-players-${next}`)?.focus(); }}>{t(`serverPlayers.${kind}`)}</button>)}
      </div>
      {(["whitelist", "operators", "bannedPlayers", "bannedIps"] as const).map(kind => <div key={`${server.id}-${kind}`} role="tabpanel" id={`${formId}-players-panel-${kind}`} aria-labelledby={`${formId}-players-${kind}`} hidden={playerKind !== kind}><ServerPlayerList server={server} kind={kind} visible={(mode === "cards" || section === "players") && playerKind === kind} /></div>)}
      <p className={styles.note}>{t("serverPlayers.standardListsHint")}</p>
    </>) : null}
    {panel("advanced",<><div className={styles.rawSearchArea}><div className={styles.rawSearchBar}><input placeholder={t("serverPropertySearch.search")} ref={searchRef} className={common.input} aria-label={t("serverPropertySearch.search")} value={rawSearch} onChange={e => { setRawSearch(e.target.value); setMatchIndex(-1); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); selectMatch(e.shiftKey ? (matchIndex < 0 ? matches.length - 1 : matchIndex - 1) : matchIndex + 1); } if (e.key === "Escape") { setRawSearch(""); setMatchIndex(-1); rawRef.current?.focus(); } }} /><span role="status">{rawSearch ? `${matches.length ? Math.min(matchIndex + 1, matches.length) : 0} / ${matches.length}` : ""}</span><Button variant="ghost" disabled={!matches.length} onClick={() => selectMatch(matchIndex < 0 ? matches.length - 1 : matchIndex - 1)}>{t("serverPropertySearch.previous")}</Button><Button variant="ghost" disabled={!matches.length} onClick={() => selectMatch(matchIndex + 1)}>{t("serverPropertySearch.next")}</Button></div></div><div className={styles.rawPropertiesEditor}><div className={styles.rawEditorStack}>{rawSearch ? <pre ref={highlightsRef} aria-hidden="true" className={`${common.input} ${styles.rawHighlights}`}>{(() => { const parts: React.ReactNode[] = []; let end = 0; matches.forEach((at, index) => { if (at < end) return; parts.push(value.propertiesText.slice(end, at), <mark key={at} data-current={index === matchIndex}>{value.propertiesText.slice(at, at + rawSearch.length)}</mark>); end = at + rawSearch.length; }); parts.push(value.propertiesText.slice(end), "\n"); return parts; })()}</pre> : null}<textarea onScroll={e => { if (highlightsRef.current) { highlightsRef.current.scrollTop = e.currentTarget.scrollTop; highlightsRef.current.scrollLeft = e.currentTarget.scrollLeft; } }} aria-label={t("localServers.rawProperties")} ref={rawRef} className={`${common.input} ${rawSearch ? styles.rawSearching : ""}`} rows={12} value={value.propertiesText} spellCheck={false} onChange={e => update("propertiesText", e.target.value)} onBlur={() => { const raw = readServerProperties(value.propertiesText); const properties = { ...value.properties }; for (const key of Object.keys(properties)) if (key in raw) properties[key] = raw[key]; onChange({ ...value, properties }); }} /></div></div>
</>)}
  </div></div></SettingLayout>;
}
