import {
  defaultServerConfig,
  readServerProperties,
  type LocalServer,
  type ServerDefaults,
  type ServerGroup,
  type ServerCollection,
  type ServerLibraryView,
} from "./localServers";

const root = "E:\\SLH-Portable\\data\\servers";
const consoleRuns = new Map<string, string>();
let defaults: ServerDefaults = {
  directory: null,
  config: defaultServerConfig(),
};
let servers: LocalServer[] = [];
let groups: ServerGroup[] = [];
let collections: ServerCollection[] = [];
let view: ServerLibraryView = {};
let deletedPaths: string[] = [];
try {
  const saved = JSON.parse(
    localStorage.getItem("slh.previewServerLibrary") ?? "null",
  );
  if (saved) {
    defaults = saved.defaults;
    servers = saved.servers;
    groups = saved.groups;
    collections = saved.collections;
    view = saved.view;
    deletedPaths = saved.deletedPaths ?? [];
  }
} catch {
  /* A broken preview cache does not affect native data. */
}

const pluginFiles = new Map<
  string,
  { filename: string; name: string; enabled: boolean; size: number }[]
>();
const discoveredConfig = {
  ...defaultServerConfig(),
  core: "purpur" as const,
  minecraftVersion: "1.21.4",
  coreVersion: "imported",
  eulaAccepted: true,
};
const sample = {
  path: "E:\\servers\\Weekend",
  name: "Weekend",
  config: discoveredConfig,
  entry: ["-jar", "purpur-1.21.4.jar"],
  ready: true,
  note: null,
};
const pluginVersion = {
  id: "plugin-v1",
  name: "Example Plugin 1.0",
  filename: "ExamplePlugin-1.0.jar",
  url: "https://example.invalid/plugin.jar",
  sha1: "preview",
  dependencies: [],
};

/** Browser preview only. Native commands always use slh-core and the real file system. */
function handlePreview(
  name: string,
  args: Record<string, unknown> = {},
): unknown {
  const server = servers.find((s) => s.id === args.serverId);
  if (name === "sync_server_library") {
    if (typeof args.directory === "string") defaults.directory = args.directory;
    const directory = defaults.directory ?? root;
    if (!collections.some((g) => g.sourcePath === `${directory}/gdz`))
      collections.push({
        id: "source-gdz",
        name: "gdz",
        parentId: null,
        sourcePath: `${directory}/gdz`,
        sortOrder: 0,
        collapsed: false,
      });
    for (const [name, folder, collection] of [
      ["Weekend", "Weekend", null],
      ["gdzserver", "gdz/gdzserver", "source-gdz"],
      ["gdz-inner", "gdz/gdz", "source-gdz"],
    ] as const) {
      const path = `${directory}/${folder}`;
      if (!deletedPaths.includes(path) && !servers.some((s) => s.path === path))
        servers.push({
          id: `preview-${name}`,
          name,
          path,
          groupId: null,
          config: structuredClone(discoveredConfig),
          status: "stopped",
          installed: true,
          createdAt: new Date().toISOString(),
          presentation: {
            collectionId: collection,
            sortOrder: servers.length,
            origin: "imported",
            readiness: "ready",
            note: null,
            icon: {},
          },
        });
    }
    return handlePreview("get_local_servers");
  }
  if (name === "save_server_library_view") {
    view = structuredClone(args.value as ServerLibraryView);
    return;
  }
  if (name === "edit_server_collection") {
    const group = collections.find((g) => g.id === args.id);
    if (args.action === "create")
      collections.push({
        id: crypto.randomUUID(),
        name: String(args.name),
        parentId: args.parent as string | null,
        sourcePath: null,
        sortOrder: collections.length,
        collapsed: false,
      });
    if (group && args.action === "rename") group.name = String(args.name);
    if (group && args.action === "collapse") group.collapsed = !group.collapsed;
    if (group && args.action === "delete") {
      collections = collections.filter((g) => g !== group);
      for (const s of servers)
        if (s.presentation?.collectionId === group.id)
          s.presentation.collectionId = group.parentId;
      for (const child of collections)
        if (child.parentId === group.id) child.parentId = group.parentId;
    }
    return;
  }
  if (name === "organize_server_library" && server) {
    server.presentation ??= {
      collectionId: null,
      sortOrder: 0,
      origin: "created",
      readiness: "ready",
      note: null,
      icon: {},
    };
    server.presentation.collectionId = args.collectionId as string | null;
    server.presentation.manualGroup = true;
    const items = servers
      .filter(
        (s) =>
          s !== server && s.presentation?.collectionId === args.collectionId,
      )
      .sort(
        (a, b) =>
          (a.presentation?.sortOrder ?? 0) - (b.presentation?.sortOrder ?? 0),
      );
    const at = items.findIndex((s) => s.id === args.before);
    items.splice(at < 0 ? items.length : at, 0, server);
    items.forEach((s, i) => {
      if (s.presentation) s.presentation.sortOrder = i;
    });
    return;
  }
  if (name === "reorder_server_collections") {
    for (const [i, id] of (args.ids as string[]).entries()) {
      const group = collections.find((g) => g.id === id);
      if (group) group.sortOrder = i;
    }
    collections.sort((a, b) => a.sortOrder - b.sortOrder);
    return;
  }
  if (name === "save_server_artwork" && server) {
    server.presentation ??= {
      collectionId: null,
      sortOrder: 0,
      origin: "created",
      readiness: "ready",
      note: null,
      icon: {},
    };
    if (typeof args.name === "string") server.name = args.name;
    server.presentation.icon = structuredClone(
      args.icon as NonNullable<LocalServer["presentation"]>["icon"],
    );
    return;
  }
  if (name === "open_server_collection_folder") return;

  if (name === "discover_local_servers")
    return servers.some((s) => s.path === sample.path)
      ? []
      : [structuredClone(sample)];
  if (name === "connect_local_server") {
    const value: LocalServer = {
      id: crypto.randomUUID(),
      name: sample.name,
      path: String(args.path),
      config: structuredClone(
        (args.config as LocalServer["config"]) ?? sample.config,
      ),
      status: "stopped",
      groupId: null,
      installed: true,
      createdAt: new Date().toISOString(),
    };
    servers.push(value);
    return structuredClone(value);
  }
  if (name === "get_local_server_icon") return null;
  if (name === "set_local_server_icon") return undefined;
  if (name === "list_server_plugins") {
    if (
      !server ||
      !["paper", "purpur", "leaf", "bukkit", "spigot", "custom"].includes(
        server.config.core,
      )
    )
      throw Error("This server does not support Bukkit plugins");
    return structuredClone(pluginFiles.get(server.id) ?? []);
  }
  if (name === "search_server_plugins")
    return {
      hits: [
        {
          projectId: "example-plugin",
          slug: "example",
          title: "Example Plugin",
          description: "Compatible server plugin",
          projectType: "plugin",
          iconUrl: null,
          downloads: 12,
          follows: 0,
          author: "Example",
          categories: ["paper"],
          versions: ["1.21.4"],
          dateModified: "",
        },
      ],
      offset: 0,
      limit: 20,
      totalHits: 1,
    };
  if (name === "server_plugin_versions") return [pluginVersion];
  if (name === "plan_server_plugin")
    return { items: [{ projectId: "example-plugin", version: pluginVersion }] };
  if (name === "install_server_plugin") {
    if (!server || server.status !== "stopped")
      throw Error("Stop the server first");
    pluginFiles.set(server.id, [
      {
        filename: pluginVersion.filename,
        name: "Example Plugin",
        enabled: true,
        size: 1234,
      },
    ]);
    return 1;
  }
  if (name === "manage_server_plugin") {
    if (!server || server.status !== "stopped")
      throw Error("Stop the server first");
    const files = pluginFiles.get(server.id) ?? [];
    const file = files.find((f) => f.filename === args.filename);
    if (file) {
      if (args.action === "toggle") {
        file.enabled = !file.enabled;
        file.filename = file.enabled
          ? file.filename.replace(/\.disabled$/, "")
          : `${file.filename}.disabled`;
      } else
        pluginFiles.set(
          server.id,
          files.filter((f) => f !== file),
        );
    }
    return undefined;
  }
  if (name === "get_local_servers")
    return structuredClone({
      servers,
      groups,
      defaults,
      collections,
      view,
      issues: [],
      directory: defaults.directory ?? root,
      defaultDirectory: root,
    });
  if (name === "local_server_catalog")
    return {
      minecraftVersions: ["1.21.4", "1.21.3", "24w45a"],
      versions: args.minecraftVersion
        ? [
            {
              id:
                args.core === "vanilla"
                  ? args.minecraftVersion
                  : args.core === "custom"
                    ? "custom"
                    : "1.0",
              stable: true,
              javaMajor: 21,
            },
          ]
        : [],
    };
  if (name === "preview_server_launch")
    return "java -Xms1024M -Xmx4096M -jar server.jar nogui";
  if (name === "save_server_defaults") {
    defaults = structuredClone(args.value as ServerDefaults);
    return defaults;
  }
  if (name === "create_local_server") {
    const request = args.request as {
      name: string;
      folder: string;
      groupId: string | null;
      config: LocalServer["config"];
    };
    if (!request.config.eulaAccepted) throw Error("Accept Minecraft EULA");
    const value: LocalServer = {
      id: crypto.randomUUID(),
      name: request.name,
      path: `${groups.find((g) => g.id === request.groupId)?.path ?? defaults.directory ?? root}\\${request.folder}`,
      groupId: request.groupId,
      config: structuredClone(request.config),
      status: "created",
      installed: false,
      createdAt: new Date().toISOString(),
    };
    servers.push(value);
    return structuredClone(value);
  }
  if (name === "create_server_group") {
    const value = {
      id: crypto.randomUUID(),
      name: String(args.name),
      parentId: args.parentId as string | null,
      path: `${groups.find((g) => g.id === args.parentId)?.path ?? root}\\${args.name}`,
    };
    groups.push(value);
    return value;
  }
  if (name === "rename_server_group") {
    const group = groups.find((g) => g.id === args.groupId);
    if (group) {
      group.name = String(args.name);
      group.path = `${root}\\${args.name}`;
    }
    return groups;
  }
  if (name === "scan_storage_cleanup")
    return {
      id: "preview-scan",
      busy: false,
      createdAt: Date.now() / 1000,
      entries: [
        {
          id: "preview-metadata",
          category: "metadata",
          kind: "db-cache",
          path: "modrinth:search",
          size: 4096,
          fingerprint: "preview",
        },
      ],
    };
  if (name === "execute_storage_cleanup")
    return {
      removedFiles: (args.entryIds as string[]).length,
      removedBytes: 0,
      skipped: 0,
      errors: [],
    };
  if (name === "optimize_storage_database")
    return { removedFiles: 0, removedBytes: 0, skipped: 0, errors: [] };
  if (
    name === "open_local_server_folder" ||
    name === "open_local_server_console"
  )
    return undefined;
  if (!server) throw Error("Server not found");
  if (["check_local_server_launch", "inspect_local_server_core_candidate", "repair_local_server_core"].includes(name)) {
    const fixtures = JSON.parse(localStorage.getItem("slh.previewServerCoreFiles") ?? "{}");
    const fixture = fixtures[server.id];
    if (name === "check_local_server_launch") return { needsRepair: Boolean(fixture), missing: true, oldTarget: "server-old.jar", oldVersion: server.config.minecraftVersion, revision: "preview-core", candidates: fixture?.candidates ?? [] };
    const candidate = fixture?.candidates.find((value: { path: string }) => value.path === args.path);
    if (!candidate) throw Error("serverCoreRepair.invalidJar");
    if (name === "inspect_local_server_core_candidate") return candidate;
    if (args.expectedRevision !== "preview-core" || args.expectedFingerprint !== candidate.fingerprint) throw Error("serverCoreRepair.changed");
    server.config.minecraftVersion = candidate.minecraftVersion;
    server.config.core = candidate.core;
    server.config.customJar = candidate.path;
    delete fixtures[server.id];
    localStorage.setItem("slh.previewServerCoreFiles", JSON.stringify(fixtures));
    return structuredClone(server);
  }
  if (name === "get_server_players" || name === "edit_server_players") {
    const allLists = JSON.parse(localStorage.getItem("slh.previewPlayerLists") ?? "{}");
    const lists = allLists[server.id] ?? { whitelist: [], operators: [], bannedPlayers: [], bannedIps: [], revisions: { whitelist: "missing", operators: "missing", bannedPlayers: "missing", bannedIps: "missing" } };
    if (name === "edit_server_players") {
      if (!["created", "stopped", "failed"].includes(server.status)) throw Error("Stop the server before changing its files");
      const request = args.request as { kind: string; action: string; name: string; uuid?: string; level?: number; reason?: string; expectedRevision: string };
      if (request.expectedRevision !== lists.revisions[request.kind]) throw Error("serverPlayers.changed");
      const key = request.uuid || request.name;
      const rows = lists[request.kind] as Array<{name?: string; uuid?: string; ip?: string}>;
      lists[request.kind] = rows.filter(row => (row.uuid || row.ip || row.name) !== key);
      if (request.action === "add") lists[request.kind].push(request.kind === "bannedIps" ? { ip: request.name, reason: request.reason, expires: "forever" } : { name: request.name, uuid: request.uuid || "b50ad385-829d-3141-a216-7e7d7539ba7f", level: request.level, ...(request.kind === "bannedPlayers" ? { reason: request.reason, expires: "forever" } : {}) });
      lists.revisions[request.kind] = crypto.randomUUID();
      allLists[server.id] = lists; localStorage.setItem("slh.previewPlayerLists", JSON.stringify(allLists));
    }
    return structuredClone(lists);
  }
  if (name === "delete_local_server") {
    if (!["created", "stopped", "failed"].includes(server.status)) throw Error("Stop the server before changing its files");
    if (args.expectedPath !== server.path) throw Error("The server folder changed");
    deletedPaths.push(server.path);
    servers = servers.filter(item => item.id !== server.id);
    return;
  }
  // Browser fixture for external edits; native commands read server.properties.
  const disk = JSON.parse(localStorage.getItem("slh.previewServerProperties") ?? "{}");
  const diskText = disk[server.id] ?? server.config.propertiesText ?? "";
  if (name === "get_local_server_metrics") {
    const fixture = JSON.parse(localStorage.getItem("slh.previewServerMetrics") ?? "{}");
    return fixture[server.id] ?? (["starting", "running", "unmanaged"].includes(server.status)
      ? { memoryBytes: 734003200, cpuPercent: 6.4, uptimeSeconds: 3900 }
      : { memoryBytes: null, cpuPercent: null, uptimeSeconds: null });
  }
  if (name === "get_local_server_config") return { ...structuredClone(server), propertiesRevision: diskText, config: { ...structuredClone(server.config), propertiesText: diskText, properties: { ...server.config.properties, ...readServerProperties(diskText) } } };

  if (name === "update_local_server") {
    if (args.expectedPropertiesRevision != null && args.expectedPropertiesRevision !== diskText) throw Error("Server properties changed on disk. Reload the server settings before saving.");
    server.name = String(args.name);
    server.config = structuredClone(args.config as LocalServer["config"]);
    disk[server.id] = Object.entries(server.config.properties).map(([key, value]) => `${key}=${value}`).join("\n");
    localStorage.setItem("slh.previewServerProperties", JSON.stringify(disk));
    return { ...structuredClone(server), propertiesRevision: disk[server.id] };
  }
  if (name === "install_local_server") {
    server.installed = true;
    server.status = "stopped";
    return structuredClone(server);
  }
  if (name === "start_local_server") { server.status = "running"; consoleRuns.set(server.id, crypto.randomUUID()); }
  if (name === "control_local_server" && args.action === "restart") consoleRuns.set(server.id, crypto.randomUUID());
  if (name === "control_local_server" && args.action !== "command")
    server.status = args.action === "restart" ? "running" : "stopped";
  if (name === "move_local_server") {
    server.groupId = args.groupId as string | null;
    server.path = `${groups.find((g) => g.id === args.groupId)?.path ?? root}\\${args.folder}`;
    return structuredClone(server);
  }
  if (name === "export_local_server_script") return `${server.path}\\start.bat`;
  return {
    runId: consoleRuns.get(server.id) ?? "preview-initial",
    state: server.status,
    lines: [
      { seq: 1, timestamp: new Date().toISOString(), text: "SLH browser preview", stream: "stdout" },
      { seq: 2, timestamp: new Date().toISOString(), text: `[12:00:00] [Server thread/INFO]: Server ready (${consoleRuns.get(server.id) ?? "preview-initial"})`, stream: "stdout" },
      { seq: 3, timestamp: new Date().toISOString(), text: "[12:00:01] [Server thread/WARN]: Preview warning", stream: "stdout" },
      { seq: 4, timestamp: new Date().toISOString(), text: "[12:00:02] [Server thread/ERROR]: Preview error", stream: "stderr" },
      { seq: 5, timestamp: new Date().toISOString(), text: "[12:00:03] [Server thread/DEBUG]: Preview details", stream: "stdout" },
    ].filter(line => line.seq > Number(args.cursor ?? 0)),
    lastSeq: 5,
    exitCode: null,
    error: null,
  };
}

export function localServersPreview(
  name: string,
  args: Record<string, unknown> = {},
): unknown {
  const result = handlePreview(name, args);
  localStorage.setItem(
    "slh.previewServerLibrary",
    JSON.stringify({ defaults, servers, groups, collections, view, deletedPaths }),
  );
  return structuredClone(result);
}
