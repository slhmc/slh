import { SettingGrid, SettingLayout, SettingRow, Toggle } from "../settings/SettingControls";
import { ServerPlayerList } from "./ServerPlayerList";
import type { LocalServer } from "../../lib/localServers";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ErrorText } from "../common/ErrorText";
import { useEffect, useId, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import { readServerProperties, serverCores, type ServerCatalog, type ServerConfig } from "../../lib/localServers";
import { Button } from "../common/Controls";
import { Coffee, Cube, GlobeHemisphereWest, ShieldCheck, SlidersHorizontal, Wrench } from "../icons";
import common from "../common/Common.module.css";
import styles from "./Servers.module.css";

export function ServerConfigFields({ value, onChange, pinned = false, defaults = false, mode = "tabs", server }: {
  value: ServerConfig; onChange: (next: ServerConfig) => void; pinned?: boolean; defaults?: boolean; mode?: "tabs" | "cards"; server?: LocalServer;
}) {
  const t = useUiText();
  const [section,setSection]=useState("core"); const formId=useId();
  const sections=["core","java","world","network","access","advanced"];
  const sectionIcons = [Cube, Coffee, GlobeHemisphereWest, SlidersHorizontal, ShieldCheck, Wrench];
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
  const tabs = <div className={styles.formTabs} role="tablist" aria-label={t("serverWorkspace.configuration")}>
    {sections.map((key,index)=>{ const Icon = sectionIcons[index]; return <button key={key} id={`${formId}-${key}`} type="button" role="tab" aria-label={t(`serverWorkspace.sections.${key}`)} title={t(`serverWorkspace.sections.${key}`)} aria-selected={section===key} aria-controls={`${formId}-panel-${key}`} tabIndex={section===key?0:-1} onClick={()=>setSection(key)} onKeyDown={e=>{if(e.key!=="ArrowRight"&&e.key!=="ArrowLeft")return;e.preventDefault();const next=sections[(index+(e.key==="ArrowRight"?1:sections.length-1))%sections.length];setSection(next);document.getElementById(`${formId}-${next}`)?.focus();}}><Icon size={16} /><span data-minimal-text>{t(`serverWorkspace.sections.${key}`)}</span></button>; })}
  </div>;
  const panel=(key:string,content:React.ReactNode)=><section hidden={mode==="tabs"&&section!==key} role={mode==="tabs"?"tabpanel":undefined} id={`${formId}-panel-${key}`} aria-labelledby={mode==="tabs"?`${formId}-${key}`:undefined} className={styles.formSection}><h3>{t(`serverWorkspace.sections.${key}`)}</h3>{mode==="cards"?<div className={styles.cardFormBody}>{content}</div>:content}</section>;
  return <SettingLayout><div className={`${styles.formShell} ${mode==="cards"?styles.cardForm:""}`}>{mode==="tabs"?tabs:null}<div className={styles.formContent}>
    {panel("core",<><SettingGrid>
      <SettingRow title={t("localServers.core")}><select className={common.select} value={value.core} disabled={pinned} onChange={e => onChange({ ...value, core: e.target.value as ServerConfig["core"], minecraftVersion: "", coreVersion: "" })}>{serverCores.map(core => <option value={core} key={core}>{t(`localServers.cores.${core}`)}</option>)}</select></SettingRow>
      <SettingRow title={t("localServers.minecraftVersion")}><select className={common.select} disabled={pinned || loading} value={value.minecraftVersion} onChange={e => onChange({ ...value, minecraftVersion: e.target.value, coreVersion: "" })}><option value="">{t(defaults ? "localServers.latestRelease" : "localServers.chooseVersion")}</option>{pinned ? <option value={value.minecraftVersion}>{value.minecraftVersion}</option> : games.map(v => <option key={v} value={v}>{v}</option>)}</select></SettingRow>
      <SettingRow title={t("localServers.coreVersion")}><select className={common.select} disabled={pinned || loading || !value.minecraftVersion} value={value.coreVersion} onChange={e => update("coreVersion", e.target.value)}><option value="">{t(defaults && !value.minecraftVersion ? "localServers.latestRelease" : "localServers.chooseBuild")}</option>{pinned ? <option value={value.coreVersion}>{value.coreVersion}</option> : versions.filter(v => prerelease || v.stable || v.id === value.coreVersion).map(v => <option key={v.id} value={v.id}>{v.id}{v.stable ? "" : ` · ${t("localServers.prerelease")}`}</option>)}</select></SettingRow>
    </SettingGrid>{!pinned ? <SettingRow title={t("localServers.showPrereleases")}><Toggle role="checkbox" checked={prerelease} onChange={setPrerelease} /></SettingRow> : null}
    {error ? <p className={styles.error} role="alert"><ErrorText message={error} /></p> : null}
    {!loading && value.minecraftVersion && !pinned && versions.length === 0 && !error ? <p className={styles.note}>{t("localServers.noBuilds")}</p> : null}
    {value.core === "custom" ? <SettingRow wide title={t("localServers.chooseJar")}><div className={styles.path}><code>{value.customJar ?? t("localServers.chooseJar")}</code><Button disabled={pinned} onClick={() => void chooseFile("customJar")}>{t("localServers.chooseJar")}</Button></div></SettingRow> : null}
    </>)}
    {panel("java",<>
      <SettingRow wide title={t("settings.javaExecutable")}><div className={styles.path}><code>{value.javaPath ?? t("localServers.automaticJava")}</code><Button onClick={() => void chooseFile("javaPath")}>{t("localServers.chooseJava")}</Button>{value.javaPath ? <Button variant="ghost" onClick={() => update("javaPath", null)}>{t("localServers.automaticJava")}</Button> : null}</div></SettingRow>
      <SettingGrid>
        <SettingRow title={t("localServers.memoryMin")}><input className={common.input} type="number" min={256} max={1048576} value={value.memoryMinMb} onChange={e => update("memoryMinMb", Number(e.target.value))} /></SettingRow>
        <SettingRow title={t("localServers.memoryMax")}><input className={common.input} type="number" min={256} max={1048576} value={value.memoryMaxMb} onChange={e => update("memoryMaxMb", Number(e.target.value))} /></SettingRow>
        <SettingRow title={t("localServers.flags")}><select className={common.select} value={value.flags} onChange={e => update("flags", e.target.value as ServerConfig["flags"])}>{["ordinary", "aikar", "custom"].map(mode => <option value={mode} key={mode}>{t(`localServers.flagModes.${mode}`)}</option>)}</select></SettingRow>
      </SettingGrid>
      {value.flags === "custom" ? <SettingRow title={t("localServers.jvmArgs")} description={t("localServers.argumentHint")} wide><textarea className={common.input} rows={5} value={value.jvmArgs.join("\n")} onChange={e => update("jvmArgs", e.target.value.split("\n").filter(Boolean))} /></SettingRow> : null}
      <SettingRow title={t("localServers.serverArgs")} wide><textarea className={common.input} rows={2} value={value.serverArgs.join("\n")} onChange={e => update("serverArgs", e.target.value.split("\n").filter(Boolean))} /></SettingRow>
      <SettingRow title={t("localServers.consoleMode")}><select className={common.select} value={value.console} onChange={e => update("console", e.target.value as ServerConfig["console"])}>{["builtin", "external", "hidden"].map(mode => <option key={mode} value={mode}>{t(`localServers.consoleModes.${mode}`)}</option>)}</select></SettingRow>
      {preview ? <details><summary>{t("localServers.commandPreview")}</summary><pre className={styles.command}>{preview}</pre></details> : null}
      {value.core === "spigot" || value.core === "bukkit" ? <details><summary>{t("localServers.buildTools")}</summary><p className={styles.note}>{t("localServers.buildToolsHint")}</p><Button variant="ghost" onClick={() => void openUrl("https://www.spigotmc.org/wiki/buildtools/")}>{t("localServers.buildToolsInstructions")}</Button>{(["jdkPath", "gitPath"] as const).map(key => <div className={styles.path} key={key}><code>{value[key] ?? t(`localServers.${key}`)}</code><Button onClick={() => void chooseFile(key)}>{t(`localServers.${key}`)}</Button>{value[key] ? <Button variant="ghost" onClick={() => update(key, null)}>{t("localServers.reset")}</Button> : null}</div>)}</details> : null}
    </>)}
    {panel("world",<><SettingGrid>{input("level-name")}{input("level-seed")}{select("gamemode",["survival","creative","adventure","spectator"])}{select("difficulty",["peaceful","easy","normal","hard"])}{select("level-type",["minecraft:normal","minecraft:flat"])}</SettingGrid><SettingGrid>{["hardcore","generate-structures","allow-nether"].map(key=><SettingRow key={key} title={t(`localServers.properties.${key}`)}><Toggle role="checkbox" checked={value.properties[key]==="true"} onChange={checked=>property(key,String(checked))} /></SettingRow>)}</SettingGrid></>)}
    {panel("network",<><SettingGrid>{input("server-port","number",1,65535)}{input("max-players","number",1,100000)}{input("server-ip")}{input("motd")}{input("view-distance","number",2,32)}{(!value.minecraftVersion||/^((1\.(18|19|2\d))|([2-9]\d\.))/.test(value.minecraftVersion))?input("simulation-distance","number",2,32):null}</SettingGrid></>)}
    {panel("access",<><SettingGrid>{["online-mode","white-list","pvp","enable-command-block","allow-flight"].map(key=><SettingRow key={key} title={t(`localServers.properties.${key}`)}><Toggle role="checkbox" checked={value.properties[key]==="true"} onChange={checked=>property(key,String(checked))} /></SettingRow>)}</SettingGrid><SettingGrid>{input("spawn-protection","number",0,65535)}</SettingGrid>{server && value.properties["white-list"] === "true" ? <ServerPlayerList key={`${server.id}-whitelist`} server={server} kind="whitelist" /> : null}</>)}
    {panel("advanced",<>{server ? (["operators", "bannedPlayers", "bannedIps"] as const).map(kind => <ServerPlayerList key={`${server.id}-${kind}`} server={server} kind={kind} />) : null}<details><summary>{t("localServers.rawProperties")}</summary><SettingRow title={t("localServers.rawPropertiesHint")} wide><textarea className={common.input} rows={12} value={value.propertiesText} spellCheck={false} onChange={e => update("propertiesText", e.target.value)} onBlur={() => { const raw = readServerProperties(value.propertiesText); const properties = { ...value.properties }; for (const key of Object.keys(properties)) if (key in raw) properties[key] = raw[key]; onChange({ ...value, properties }); }} /></SettingRow></details>
</>)}
  </div></div></SettingLayout>;
}
