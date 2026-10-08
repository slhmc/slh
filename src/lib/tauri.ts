import { invoke } from "@tauri-apps/api/core";
import { markStorageChanged } from "./storageUsage";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BootstrapData,
  CommandFailure,
  ConsoleLineEvent,
  LaunchStateEvent,
} from "./types";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const previewBootstrap: BootstrapData = {
  version: "0.2.0-dev",
  buildUnix: 0,
  portableRoot: "E:\\SLH-Portable",
  firstRun: false,
  locales: [
    {
      code: "en-US",
      name: "English (United States)",
      path: "resources/languages/en-US.json",
    },
    {
      code: "ru-RU",
      name: "Русский (Россия)",
      path: "resources/languages/ru-RU.json",
    },
    {
      code: "de-DE",
      name: "Deutsch (Deutschland)",
      path: "resources/languages/de-DE.json",
    },
  ],
  settings: {
    general: {
      language: "en-US",
      viewMode: "grid",
      rememberSection: true,
      lastSection: "library",
      closeBehavior: "ask",
      hideOnLaunch: false,
      restoreOnExit: true,
      offlineFallbackWhenOffline: true,
      keyboardZoom: true,
      visibleNavigation: ["home", "library", "discover", "settings"],
      navigationOrder: ["home", "library", "discover", "settings"],
      accountOrder: ["preview-account"],
      settingsNavigationVisible: ["general", "appearance", "minecraft", "java", "bedrock", "accounts", "storage", "downloads", "notifications", "sync", "console", "privacy", "advanced"],
      settingsNavigationOrder: ["general", "appearance", "minecraft", "java", "bedrock", "accounts", "storage", "downloads", "notifications", "sync", "console", "privacy", "advanced"],
      hideUngrouped: false,
      ungroupedCollapsed: false,
      ungroupedPosition: 999,
      checkUpdatesAutomatically: true,
      instancePanelPosition: "right",
      instanceTabsPosition: "top",
      navigationPosition: "left",
      settingsNavigationPosition: "left",
      instanceTabs: {
        order: ["overview", "mods", "resourcepacks", "shaders", "worlds", "screenshots", "settings", "logs"],
        visible: ["overview", "mods", "resourcepacks", "shaders", "worlds", "screenshots", "settings", "logs"],
      },
    },
    appearance: {
      background: "#1f2226",
      surface: "#292d32",
      surface2: "#343a40",
      border: "#454c54",
      text: "#ffffff",
      textMuted: "#aeb6bf",
      accent: "#cd491e",
      accentHover: "#e15828",
      accentPressed: "#ae3916",
      radius: 10,
      density: "comfortable",
      scalePercent: 100,
      activePresetId: "slh-orange",
      presets: [],
      minimalism: false,
      fontFamily: "pixeloid",
      customFontPath: null,
    },
    minecraft: {
      javaMode: "auto",
      javaPath: null,
      memoryMinMb: 512,
      memoryMaxMb: 4096,
      resolutionWidth: 1280,
      resolutionHeight: 720,
      jvmArgs: [],
    },
    java: { installDirectory: null, detectedPath: null },
    bedrock: { enabled: true, defaultProfileMode: "shared", showPreviewVersions: false, cardClickAction: "summary" },
    downloads: { concurrency: 6, retries: 3, bandwidthLimitKbps: null },
    privacy: { telemetry: false, crashReporting: false },
    sync: { backupRetention: 10, worldsEnabled: false },
    notifications: { enabled: true, destination: "launcher", maxVisible: 3, durationMs: 5000, showInfo: true, showSuccess: true, showErrors: true },
    console: { background: "#111417", foreground: "#d8dee9", info: "#8fb8de", warning: "#e6b85c", error: "#f06a6a", debug: "#85909c", timestamp: "#66717d", fontSize: 13, maxLines: 2000, wrapLines: true, showTimestamps: true, autoScroll: true, openOnLaunch: true, openOnHomeLaunch: false },
    onboarding: { completed: true },
  },
  groups: [
    { id: "g-vanilla", name: "Vanilla", sortOrder: 0, collapsed: false, createdAt: "2026-08-09T10:00:00Z" },
    { id: "g-modded", name: "Modded", sortOrder: 1, collapsed: false, createdAt: "2026-08-09T10:00:00Z" },
  ],
  instances: [
    {
      id: "preview-1",
      name: "Latest release",
      groupId: "g-vanilla",
      iconPath: null,
      folderName: "Latest release",
      iconKey: "cube",
      iconBackground: "#3f493c",
      iconForeground: "#f0f4ed",
      minecraftVersion: "1.21.8",
      loaderType: "vanilla",
      loaderVersion: null,
      status: "installed",
      createdAt: "2026-08-06T14:00:00Z",
      lastPlayedAt: "2026-08-08T19:32:00Z",
      playtimeSeconds: 18360,
      javaPath: null,
      memoryMinMb: 512,
      memoryMaxMb: 4096,
      gameDir: "E:\\SLH-Portable\\data\\instances\\preview-1\\game",
      configSchemaVersion: 1,
      bedrockProfileMode: "shared",
    },
    {
      id: "preview-2",
      name: "Cobblemon expedition",
      groupId: "g-modded",
      iconPath: null,
      folderName: "Cobblemon expedition",
      iconKey: "blocks",
      iconBackground: "#4d4033",
      iconForeground: "#f1e8dd",
      minecraftVersion: "1.20.1",
      loaderType: "fabric",
      loaderVersion: "0.16.14",
      status: "installed",
      createdAt: "2026-08-01T14:00:00Z",
      lastPlayedAt: "2026-08-07T17:12:00Z",
      playtimeSeconds: 42480,
      javaPath: null,
      memoryMinMb: 1024,
      memoryMaxMb: 6144,
      gameDir: "E:\\SLH-Portable\\data\\instances\\preview-2\\game",
      configSchemaVersion: 1,
      bedrockProfileMode: "shared",
    },
    {
      id: "preview-3",
      name: "Redstone lab",
      groupId: "g-modded",
      iconPath: null,
      folderName: "Redstone lab",
      iconKey: "tools",
      iconBackground: "#51352f",
      iconForeground: "#f3dfd9",
      minecraftVersion: "1.21.5",
      loaderType: "neoforge",
      loaderVersion: "21.5.84",
      status: "created",
      createdAt: "2026-08-09T09:00:00Z",
      lastPlayedAt: null,
      playtimeSeconds: 0,
      javaPath: null,
      memoryMinMb: 1024,
      memoryMaxMb: 4096,
      gameDir: "E:\\SLH-Portable\\data\\instances\\preview-3\\game",
      configSchemaVersion: 1,
      bedrockProfileMode: "shared",
    },
  ],
  accounts: [
    {
      id: "preview-account",
      provider: "offline",
      providerUuid: "b50ad385-829d-3141-a216-7e7d7539ba7f",
      username: "SmilePlayer",
      avatarCachePath: null,
      authStatus: "ready",
      lastAuthAt: null,
      active: true,
      createdAt: "2026-08-01T10:00:00Z",
    },
  ],
  providers: [
    { provider: "offline", available: true, message: null },
    {
      provider: "microsoft",
      available: false,
      message: "Microsoft authentication is not configured for this build.",
    },
    {
      provider: "elyby",
      available: false,
      message: "Ely.by sign-in is not active in this build.",
    },
  ],
};

function normalizeFailure(error: unknown): CommandFailure {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<CommandFailure>;
    if (typeof candidate.message === "string") {
      return {
        code: typeof candidate.code === "string" ? candidate.code : "command_error",
        message: candidate.message,
      };
    }
  }
  return {
    code: "command_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    if (name === "get_bootstrap") {
      return structuredClone(previewBootstrap) as T;
    }
      if (name === "load_locale") {
      const code = String(args?.code ?? "en-US");
      // Preview-only dictionaries must not be parsed by the native launcher.
      if (code === "ru-RU") return structuredClone((await import("../../resources/languages/ru-RU.json")).default) as T;
      if (code === "en-US") return structuredClone((await import("../../resources/languages/en-US.json")).default) as T;
      if (code === "de-DE") return structuredClone((await import("../../resources/languages/de-DE.json")).default) as T;
      return {
        meta: { code: "en-US", name: "English (United States)", schemaVersion: 1 },
        } as T;
      }
      if (name === "list_locales") {
        return structuredClone(previewBootstrap.locales) as T;
      }
    if (name === "check_launcher_updates") {
      return {
        currentVersion: previewBootstrap.version,
        latestVersion: previewBootstrap.version,
        releaseName: `SLH ${previewBootstrap.version}`,
        releaseUrl: "https://github.com/slhmc/slh/releases",
        publishedAt: null,
        updateAvailable: false,
      } as T;
    }
    if (name === "update_setting") {
      return args?.value as T;
    }
    if (name === "get_account_avatar") {
      return null as T;
    }
    if (name === "get_account_appearance") {
      const accountId = String(args?.accountId ?? "preview-account");
      const account = previewBootstrap.accounts.find((item) => item.id === accountId) ?? previewBootstrap.accounts[0];
      return {
        accountId: account.id,
        provider: account.provider,
        username: account.username,
        canChangeSkin: account.provider === "microsoft",
        canChangeCape: account.provider === "microsoft",
        message: account.provider === "offline" ? "Skin and cape controls are unavailable for offline accounts." : null,
        skins: [],
        capes: [],
      } as T;
    }
    if (name === "upload_account_skin" || name === "upload_account_skin_bytes" || name === "select_account_skin" || name === "select_account_cape") {
      const accountId = String(args?.accountId ?? "preview-account");
      const account = previewBootstrap.accounts.find((item) => item.id === accountId) ?? previewBootstrap.accounts[0];
      return {
        accountId: account.id,
        provider: account.provider,
        username: account.username,
        canChangeSkin: account.provider === "microsoft",
        canChangeCape: account.provider === "microsoft",
        message: null,
        skins: [],
        capes: [],
      } as T;
    }
    if (name === "update_instance") {
      const request = args?.request as Record<string, unknown> | undefined;
      const current = previewBootstrap.instances.find((item) => item.id === request?.instanceId) ?? previewBootstrap.instances[0];
      return { ...current, ...request } as T;
    }
    if (name === "delete_instance") {
      return {
        instanceId: String(args?.instanceId ?? "preview-1"),
        backupPath: null,
      } as T;
    }
    if (name === "list_minecraft_versions") {
      return [
        { id: "1.21.8", versionType: "release", releaseTime: "2026-07-17T10:00:00Z", url: "", sha1: "" },
        { id: "1.21.7", versionType: "release", releaseTime: "2026-06-30T10:00:00Z", url: "", sha1: "" },
        { id: "26w32a", versionType: "snapshot", releaseTime: "2026-08-05T10:00:00Z", url: "", sha1: "" },
        { id: "1.20.1", versionType: "release", releaseTime: "2023-06-12T10:00:00Z", url: "", sha1: "" },
      ] as T;
    }
    if (name === "list_bedrock_versions") {
      return [
        { id: "26.51.01", versionType: "release", releaseTime: "", url: "https://assets1.xboxlive.com/example/Microsoft.MinecraftUWP_1.26.5101.0_x64__8wekyb3d8bbwe.msixvc", sha1: "", mirrors: ["https://assets1.xboxlive.com/example/Microsoft.MinecraftUWP_1.26.5101.0_x64__8wekyb3d8bbwe.msixvc", "https://assets2.xboxlive.com/example/Microsoft.MinecraftUWP_1.26.5101.0_x64__8wekyb3d8bbwe.msixvc"], md5: "d10018a435dbe00a1da8cc411ebf309f", packageType: "gdk", installMethod: "native_msixvc", packageFamilyName: "Microsoft.MinecraftUWP_8wekyb3d8bbwe", channel: "release", architecture: "x64", installability: "downloadable", status: "available" },
        { id: "26.50.04", versionType: "release", releaseTime: "", url: "https://assets1.xboxlive.com/example/Microsoft.MinecraftUWP_1.26.5004.0_x64__8wekyb3d8bbwe.msixvc", sha1: "", mirrors: ["https://assets1.xboxlive.com/example/Microsoft.MinecraftUWP_1.26.5004.0_x64__8wekyb3d8bbwe.msixvc", "https://assets2.xboxlive.com/example/Microsoft.MinecraftUWP_1.26.5004.0_x64__8wekyb3d8bbwe.msixvc"], md5: "00000000000000000000000000000000", packageType: "gdk", installMethod: "native_msixvc", packageFamilyName: "Microsoft.MinecraftUWP_8wekyb3d8bbwe", channel: "release", architecture: "x64", installability: "downloadable", status: "available" },
        { id: "1.21.130.1", versionType: "release", releaseTime: "", url: "", sha1: "", packageType: "uwp", channel: "release", architecture: "bundle", installability: "downloadable", status: "available" },
        { id: "1.21.120.20", versionType: "snapshot", releaseTime: "", url: "", sha1: "", packageType: "uwp", channel: "preview", architecture: "bundle", installability: "downloadable", status: "available" },
      ] as T;
    }
    if (name === "test_bedrock_mirrors") {
      return [
        { url: "https://assets1.xboxlive.com/example/Microsoft.MinecraftUWP.msixvc", host: "assets1.xboxlive.com", latencyMs: 78, ok: true, status: 200, contentLength: 2147483648, error: null },
        { url: "https://assets2.xboxlive.com/example/Microsoft.MinecraftUWP.msixvc", host: "assets2.xboxlive.com", latencyMs: 250, ok: true, status: 200, contentLength: 2147483648, error: null },
      ] as T;
    }
    if (name === "get_bedrock_runtime_status" || name === "refresh_bedrock_entitlements" || name === "bind_bedrock_store_account" || name === "prepare_bedrock_runtime") {
      return {
        microsoftAuthenticated: true,
        storeSession: "unknown",
        xboxSession: "oauth",
        minecraftLicense: "release",
        nativeInstallerAvailable: true,
        storeAccountStatus: "interaction_required",
        storeAccountXuid: null,
        gamingServicesInstalled: true,
        gameInputInstalled: true,
        developerMode: true,
        wdappAvailable: false,
        wdappPath: null,
        architecture: "x64",
        installedPackages: [],
        launchReady: false,
        message: "Preview mode does not have a real Microsoft Store session.",
      } as T;
    }
    if (name === "discover_java") {
      return [
        { path: "C:\\Program Files\\Java\\jdk-21\\bin\\java.exe", version: "21.0.7", majorVersion: 21, source: "JAVA_HOME", compatible: true },
      ] as T;
    }
    if (name === "list_loader_versions") {
      return [
        { id: "0.16.14", stable: true, recommended: true },
        { id: "0.16.13", stable: true, recommended: false },
      ] as T;
    }
    if (name === "search_modrinth" || name === "search_curseforge") {
      const projects = [
        { projectId: "AANobbMI", slug: "sodium", title: "Sodium", description: "A modern rendering engine for Minecraft that improves frame rates and reduces micro-stutter.", projectType: "mod", iconUrl: "https://cdn.modrinth.com/data/AANobbMI/icon.png", downloads: 129000000, follows: 310000, author: "JellySquid3", categories: ["optimization", "fabric", "quilt"], versions: ["26.2", "1.21.8", "1.21.7"], dateModified: "2026-08-01T10:00:00Z" },
        { projectId: "P7dR8mSH", slug: "fabric-api", title: "Fabric API", description: "Essential hooks and interoperability utilities for mods using Fabric.", projectType: "mod", iconUrl: "https://cdn.modrinth.com/data/P7dR8mSH/icon.png", downloads: 188000000, follows: 240000, author: "modmuss50", categories: ["library", "fabric"], versions: ["26.2", "1.21.8", "1.21.7"], dateModified: "2026-08-02T10:00:00Z" },
        { projectId: "5ZwdcRci", slug: "fabulously-optimized", title: "Fabulously Optimized", description: "A performance-focused modpack with familiar quality-of-life features and broad compatibility.", projectType: "modpack", iconUrl: null, downloads: 8200000, follows: 120000, author: "robotkoer", categories: ["optimization", "lightweight"], versions: ["1.21.8", "1.21.7"], dateModified: "2026-08-02T10:00:00Z" },
        { projectId: "preview-resourcepack", slug: "stay-true", title: "Stay True", description: "A refined resource pack that keeps the familiar Minecraft art direction.", projectType: "resourcepack", iconUrl: null, downloads: 21000000, follows: 94000, author: "Trrig", categories: ["16x", "vanilla-like"], versions: ["26.2", "1.21.8"], dateModified: "2026-08-03T10:00:00Z" },
        { projectId: "preview-shader", slug: "complementary-unbound", title: "Complementary Unbound", description: "A configurable shader pack focused on quality, performance, and broad hardware support.", projectType: "shader", iconUrl: null, downloads: 35000000, follows: 180000, author: "EminGTR", categories: ["realistic", "fantasy"], versions: ["26.2", "1.21.8"], dateModified: "2026-08-03T10:00:00Z" },
        { projectId: "238222", slug: "skyblock-world", title: "SkyBlock World", description: "A downloadable Minecraft world distributed as a verified CurseForge archive.", projectType: "world", iconUrl: null, downloads: 1200000, follows: 18000, author: "WorldBuilder", categories: ["creation", "adventure"], versions: ["26.2", "1.21.8"], dateModified: "2026-08-03T10:00:00Z" },
      ];
      const requestedType = String(args?.projectType ?? "");
      const requestedVersion = String(args?.gameVersion ?? "");
      const requestedLoader = String(args?.loader ?? "");
      const hits = projects.filter((project) => (
        (!requestedType || project.projectType === requestedType)
        && (!requestedVersion || project.versions.includes(requestedVersion))
        && (!requestedLoader || !["mod", "modpack"].includes(project.projectType) || project.categories.includes(requestedLoader))
      ));
      return {
        hits,
        offset: 0,
        limit: 24,
        totalHits: hits.length,
      } as T;
    }
    if (name === "list_sync_mappings") {
      return [] as T;
    }
    if (name === "run_sync_mapping_now") {
      return [] as T;
    }
    if (name === "list_instance_files") {
      return [] as T;
    }
    if (name === "get_instance_console") {
      return [] as T;
    }
    if (name === "get_storage_summary") {
      return {
        totalBytes: 891289600,
        databaseBytes: 524288,
        instancesBytes: 356515840,
        sharedBytes: 12582912,
        cacheBytes: 419430400,
        downloadsBytes: 0,
        javaBytes: 94371840,
        logsBytes: 1048576,
        backupsBytes: 6815744,
      } as T;
    }
    if (name === "list_downloads") {
      return [] as T;
    }
    if (name === "list_content_providers") {
      return [
        { provider: "modrinth", available: true, message: "Public API available; compatible installs use verified hashes." },
        { provider: "curseforge", available: true, message: "SLH relay configured; the first request verifies availability." },
      ] as T;
    }
    if (name === "get_curseforge_key_status") {
      return { configured: false, source: "none", message: "No personal key configured. CurseForge requests use the SLH relay." } as T;
    }
    if (name === "save_curseforge_api_key") {
      return { configured: true, source: "local", message: "Stored locally as a Windows DPAPI-encrypted secret." } as T;
    }
    if (name === "clear_curseforge_api_key") {
      return { configured: false, source: "none", message: "No personal key configured. CurseForge requests use the SLH relay." } as T;
    }
    if (name === "kill_instance") return undefined as T;
    if (name === "list_servers" || name === "add_server" || name === "remove_server") {
      return [
        { index: 0, name: "Local realm", address: "play.example.net", acceptTextures: null, hasIcon: false },
      ] as T;
    }
    if (name === "plan_modrinth_install" || name === "plan_curseforge_install") {
      const instanceId = String(args?.instanceId ?? "preview-2");
      const projectId = String(args?.projectId ?? "AANobbMI");
      return {
        provider: name === "plan_curseforge_install" ? "curseforge" : "modrinth",
        rootProjectId: projectId,
        instanceId,
        projectType: "mod",
        items: [
          { projectId, versionId: "preview-version", displayName: "Compatible release", versionNumber: "1.0.0", fileName: "project.jar", destination: "E:\\SLH-Portable\\data\\instances\\preview-2\\game\\mods\\project.jar", sizeBytes: 1048576, action: "install" },
        ],
        conflicts: [],
        totalBytes: 1048576,
      } as T;
    }
    if (name === "install_modrinth_project" || name === "install_curseforge_project") {
      return { installedFiles: 1, unchangedFiles: 0, backupsCreated: 0 } as T;
    }
    if (name === "install_modrinth_modpack" || name === "install_curseforge_modpack") {
      return { ...previewBootstrap.instances[1], id: "preview-modpack", name: String(args?.name ?? "Modrinth pack") } as T;
    }
    throw {
      code: "desktop_backend_unavailable",
      message: "This action requires the SLH desktop backend. Browser mode is a visual preview only.",
    } satisfies CommandFailure;
  }
  try {
    const result = await invoke<T>(name, args);
    if (/^(create_instance|delete_instance|delete_instance_content|import_|export_|restore_|backup_|repair_instance|install_|upload_account_skin|delete_saved_account_skin|clear_storage|cleanup_)/.test(name)) {
      markStorageChanged();
    }
    return result;
  } catch (error) {
    throw normalizeFailure(error);
  }
}

export async function listenLaunchState(
  handler: (event: LaunchStateEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  return listen<LaunchStateEvent>("slh-launch-state", (event) => handler(event.payload));
}

export async function listenConsoleLine(
  handler: (event: ConsoleLineEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  return listen<ConsoleLineEvent>("slh-console-line", (event) => handler(event.payload));
}

export async function revealInstancePath(instanceId: string, path?: string): Promise<void> {
  if (!isTauri) {
    throw {
      code: "desktop_backend_unavailable",
      message: "Opening Explorer requires the SLH desktop backend.",
    } satisfies CommandFailure;
  }
  await command("reveal_instance_path", { instanceId, path });
}
