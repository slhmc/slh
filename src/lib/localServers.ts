export const serverCores = ["vanilla", "fabric", "forge", "quilt", "neoforge", "paper", "purpur", "leaf", "spigot", "bukkit", "custom"] as const;
export type ServerCore = typeof serverCores[number];
export interface ServerConfig {
  core: ServerCore; minecraftVersion: string; coreVersion: string;
  javaPath: string | null; jdkPath: string | null; gitPath: string | null;
  memoryMinMb: number; memoryMaxMb: number; flags: "ordinary" | "aikar" | "custom";
  jvmArgs: string[]; serverArgs: string[]; console: "builtin" | "external" | "hidden";
  properties: Record<string, string>; propertiesText: string; customJar: string | null; eulaAccepted: boolean;
}
export interface ServerPresentation { collectionId: string | null; manualGroup?:boolean; sortOrder: number; origin: string; readiness: string; note: string | null; icon: {key?: string; background?: string; foreground?: string} }
export interface ServerCollection {id:string;name:string;parentId:string|null;sourcePath:string|null;sortOrder:number;collapsed:boolean}
export interface ServerLibraryView {view?:string;sort?:string;collection?:string;panelPosition?:string;selected?:string;tabsPosition?:string;tabOrder?:string[];visibleTabs?:string[];collapsedGroups?:string[];panel?:{showArtwork?:boolean;showMetadata?:boolean;hiddenActions?:string[];actionOrder?:string[]}}
export interface LocalServer { propertiesRevision?: string; presentation?: ServerPresentation; id: string; name: string; path: string; groupId: string | null; config: ServerConfig; status: string; installed: boolean; createdAt: string }
export interface ServerGroup { id: string; name: string; path: string; parentId: string | null }
export interface ServerDefaults { directory: string | null; config: ServerConfig }
export interface ServerOverview { collections?:ServerCollection[];view?:ServerLibraryView;issues?:string[]; servers: LocalServer[]; groups: ServerGroup[]; defaults: ServerDefaults; directory: string; defaultDirectory: string }
export interface ServerCatalog { minecraftVersions: string[]; versions: { id: string; stable: boolean; javaMajor: number }[] }
export interface ServerCoreCandidate { path: string; filename: string; minecraftVersion: string; core: string; requiredJava: number; fingerprint: string }
export interface ServerLaunchCheck { needsRepair: boolean; missing: boolean; oldTarget: string; oldVersion: string; revision: string; candidates: ServerCoreCandidate[] }
export interface ServerLine { seq: number; text: string; stream: string; timestamp: string }
export interface ServerSnapshot { runId?: string | null; state: string; lines: ServerLine[]; lastSeq: number; exitCode: number | null; error: string | null }
export interface ServerMetrics { memoryBytes: number | null; cpuPercent: number | null; uptimeSeconds: number | null }
export interface DiscoveredServer { path: string; name: string; config: ServerConfig; entry: string[]; ready: boolean; note: string | null }
export interface ServerPluginFile { filename: string; name: string; enabled: boolean; size: number }
export interface ServerPluginVersion { id: string; name: string; filename: string; url: string | null; sha1: string; dependencies: [string,string | null][] }
export interface ServerPluginPlan { items: { projectId: string; version: ServerPluginVersion }[] }
export interface CleanupEntry { id: string; category: string; path: string; size: number; fingerprint: string; kind: string }
export interface CleanupScan { id: string; entries: CleanupEntry[]; busy: boolean; createdAt: number }
export interface CleanupResult { removedFiles: number; removedBytes: number; skipped: number; errors: string[] }

export function defaultServerConfig(): ServerConfig {
  return { core: "vanilla", minecraftVersion: "", coreVersion: "", javaPath: null, jdkPath: null, gitPath: null,
    memoryMinMb: 1024, memoryMaxMb: 4096, flags: "ordinary", jvmArgs: [], serverArgs: [], console: "builtin",
    properties: { "server-port": "25565", "server-ip": "", "max-players": "20", motd: "SLH server", "level-name": "world", "level-seed": "", "level-type": "minecraft:normal", gamemode: "survival", difficulty: "normal", hardcore: "false", "online-mode": "true", "white-list": "false", pvp: "true", "enable-command-block": "false", "allow-flight": "false", "spawn-protection": "16", "view-distance": "10", "simulation-distance": "10", "generate-structures": "true", "allow-nether": "true" },
    propertiesText: "", customJar: null, eulaAccepted: false };
}
export const stoppedServer = (server: LocalServer) => ["created", "stopped", "failed"].includes(server.status);
export function safeServerFolder(name: string) { return name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, ""); }

/** Values edited in the raw panel also update their corresponding form fields. */
export function readServerProperties(text: string): Record<string,string> {
  const result: Record<string,string> = {};
  const unescape = (value: string) => value.replace(/\\u([0-9a-f]{4})|\\(.)/gi, (_, hex: string, char: string) => hex ? String.fromCharCode(parseInt(hex,16)) : ({t:"\t",n:"\n",r:"\r",f:"\f"}[char] ?? char));
  for (const line of text.replace(/\\\r?\n\s*/g, "").split(/\r?\n/)) {
    const trimmed = line.trimStart(); if (!trimmed || /^[#!]/.test(trimmed)) continue;
    const match = /^([^\s=:]+)\s*[=:]?\s*(.*)$/.exec(trimmed);
    if (match) result[unescape(match[1])] = unescape(match[2]);
  }
  return result;
}

export const serverReady=(server:LocalServer)=>!server.presentation||server.presentation.readiness==="ready";
