export type ViewMode = "grid" | "list";

export interface InstanceGroup {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt: string;
}

export interface Instance {
  id: string;
  name: string;
  groupId: string | null;
  iconPath: string | null;
  folderName: string;
  iconKey: string;
  iconBackground: string | null;
  iconForeground: string | null;
  minecraftVersion: string;
  loaderType: "vanilla" | "fabric" | "forge" | "neoforge" | "quilt" | "bedrock";
  loaderVersion: string | null;
  status: "created" | "installing" | "launching" | "installed" | "running" | "error";
  createdAt: string;
  lastPlayedAt: string | null;
  lastLaunchedAt?: string | null;
  playtimeSeconds: number;
  javaPath: string | null;
  memoryMinMb: number;
  memoryMaxMb: number;
  gameDir: string;
  configSchemaVersion: number;
  bedrockProfileMode: "isolated" | "shared";
}

export type ToastParams = Record<string, string | number>;

export interface UpdateInstanceRequest {
  instanceId: string;
  name: string;
  iconKey: string;
  iconBackground: string;
  iconForeground: string;
  memoryMinMb: number;
  memoryMaxMb: number;
  minecraftVersion?: string;
  loaderType?: Instance["loaderType"];
  loaderVersion?: string | null;
  bedrockProfileMode?: Instance["bedrockProfileMode"];
}

export interface Account {
  id: string;
  provider: "offline" | "microsoft" | "elyby";
  providerUuid: string;
  xboxXuid?: string | null;
  username: string;
  avatarCachePath: string | null;
  authStatus: string;
  lastAuthAt: string | null;
  active: boolean;
  createdAt: string;
}

export interface AccountTexture {
  id: string;
  dataUrl: string | null;
  thumbnailDataUrl?: string | null;
  variant: string | null;
  alias: string | null;
  active: boolean;
}

export interface AccountAppearance {
  accountId: string;
  provider: Account["provider"];
  username: string;
  canChangeSkin: boolean;
  canChangeCape: boolean;
  message: string | null;
  skins: AccountTexture[];
  capes: AccountTexture[];
}

export interface LocaleDescriptor {
  code: string;
  name: string;
  path: string;
}

export interface ProviderAvailability {
  provider: Account["provider"] | "modrinth" | "curseforge";
  available: boolean;
  message: string | null;
}

export interface CurseForgeKeyStatus {
  configured: boolean;
  source: "environment" | "portable" | "unavailable" | "none" | string;
  message: string;
}

export interface GeneralSettings {
  language: string;
  viewMode: ViewMode;
  rememberSection: boolean;
  lastSection: string;
  closeBehavior: string;
  hideOnLaunch: boolean;
  restoreOnExit: boolean;
  /** Use the active Microsoft/Ely.by name as a temporary offline identity when there is no connection. */
  offlineFallbackWhenOffline?: boolean;
  keyboardZoom?: boolean;
  visibleNavigation?: SidebarNavigationItem[];
  /** Stable order for all navigation entries, including hidden ones. */
  navigationOrder?: SidebarNavigationItem[];
  /** Stable order for the settings sub-navigation. Hidden entries stay in this order. */
  settingsNavigationVisible?: string[];
  settingsNavigationOrder?: string[];
  /** Hide the synthetic Ungrouped section in the library. */
  hideUngrouped?: boolean;
  /** Keep the synthetic Ungrouped section collapsed, like a regular group. */
  ungroupedCollapsed?: boolean;
  /** Position of the non-deletable Ungrouped section among regular groups. */
  ungroupedPosition?: number;
  checkUpdatesAutomatically?: boolean;
  /** Dock the selected instance details panel to either side of the library. */
  instancePanelPosition?: "left" | "right";
  /** Dock the instance-page tab strip around its content. */
  instanceTabsPosition?: "top" | "left" | "right" | "bottom";
  /** Dock the main launcher navigation around the workspace. */
  navigationPosition?: "left" | "right" | "top" | "bottom";
  /** Dock the settings sub-navigation to either side of its content. */
  settingsNavigationPosition?: "left" | "right";
  accountOrder?: string[];
  /** Shared visibility options for the instance details panel in Library. */
  instancePanel?: {
    showArtwork: boolean;
    showMetadata: boolean;
    hiddenActions: string[];
    actionOrder?: string[];
  };
  /** Shared visibility and order for the tabs shown on every instance page. */
  instanceTabs?: {
    order: string[];
    visible: string[];
  };
}

export type SidebarNavigationItem = "home" | "library" | "discover" | "settings";

export interface AppearanceColors {
  background: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  accentPressed: string;
}

export interface AppearancePreset {
  id: string;
  name: string;
  colors: AppearanceColors;
}

export interface AppearanceSettings extends AppearanceColors {
  beautifulHome?: boolean;
  homeCharacterFps?: number;
  homeStatusVisible?: string[];
  homeStatusOrder?: string[];
  homeMetricsScope?: "launcher" | "system";
  radius: number;
  density: string;
  scalePercent: number;
  activePresetId: string;
  presets: AppearancePreset[];
  minimalism?: boolean;
  fontFamily?: "pixeloid" | "system" | "monospace" | "local";
  customFontPath?: string | null;
}

export interface NotificationSettings {
  enabled: boolean;
  destination?: "launcher" | "windows";
  maxVisible: number;
  durationMs: number;
  showInfo: boolean;
  showSuccess: boolean;
  showErrors: boolean;
}

export interface ConsoleSettings {
  background: string;
  foreground: string;
  info: string;
  warning: string;
  error: string;
  debug: string;
  timestamp: string;
  fontSize: number;
  maxLines: number;
  wrapLines: boolean;
  showTimestamps: boolean;
  autoScroll: boolean;
  openOnLaunch: boolean;
  /** Quick launch on Home stays on Home unless explicitly enabled. */
  openOnHomeLaunch?: boolean;
}

export interface MinecraftSettings {
  javaMode: string;
  javaPath: string | null;
  memoryMinMb: number;
  memoryMaxMb: number;
  resolutionWidth: number;
  resolutionHeight: number;
  jvmArgs: string[];
}

export interface JavaSettings {
  installDirectory: string | null;
  detectedPath?: string | null;
}

export interface BedrockSettings {
  enabled: boolean;
  defaultProfileMode: "shared" | "isolated";
  showPreviewVersions: boolean;
  cardClickAction?: "none" | "summary" | "curseforge";
}

export interface AppSettings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
  minecraft: MinecraftSettings;
  java: JavaSettings;
  bedrock: BedrockSettings;
  downloads: {
    concurrency: number;
    retries: number;
    bandwidthLimitKbps: number | null;
  };
  privacy: {
    telemetry: boolean;
    crashReporting: boolean;
  };
  sync: {
    backupRetention: number;
    worldsEnabled: boolean;
  };
  notifications: NotificationSettings;
  console: ConsoleSettings;
  onboarding: {
    completed: boolean;
  };
}

export interface BootstrapData {
  capabilities?: { bedrock: boolean; portableDefault: boolean; credentialStore: string };
  version: string;
  buildUnix: number;
  portableRoot: string;
  firstRun: boolean;
  locales: LocaleDescriptor[];
  settings: AppSettings;
  groups: InstanceGroup[];
  instances: Instance[];
  accounts: Account[];
  providers: ProviderAvailability[];
}

export interface LauncherUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseUrl: string;
  publishedAt: string | null;
  updateAvailable: boolean;
}

export interface MinecraftVersionSummary {
  id: string;
  versionType: "release" | "snapshot" | "old_alpha" | "old_beta";
  releaseTime: string;
  url: string;
  sha1: string;
  mirrors?: string[];
  md5?: string | null;
  sizeBytes?: number | null;
  packageType?: "gdk" | "uwp";
  installMethod?: "windows_update" | "native_msixvc" | "registered_store" | string;
  packageFamilyName?: string | null;
  channel?: "release" | "preview";
  architecture?: string;
  installability?: string;
  installReason?: string | null;
  status?: string;
}

export interface BedrockMirrorProbe {
  url: string;
  host: string;
  latencyMs: number | null;
  ok: boolean;
  status: number | null;
  contentLength: number | null;
  error: string | null;
}

export interface BedrockInstalledPackage {
  name: string;
  version: string;
  packageFamilyName: string;
  packageFullName: string;
  installLocation: string;
  appUserModelId: string | null;
  channel: "release" | "preview" | string;
  signatureKind?: string | null;
}

export interface BedrockRuntimeStatus {
  microsoftAuthenticated: boolean;
  storeSession: "detected" | "unknown" | "required" | string;
  xboxSession: "oauth" | "required" | string;
  minecraftLicense: "release" | "preview" | "unknown" | string;
  nativeInstallerAvailable?: boolean;
  storeAccountStatus?: "ready" | "interaction_required" | "license_missing" | "account_mismatch" | "unavailable" | string;
  storeAccountXuid?: string | null;
  storeAccountGamertag?: string | null;
  gamingServicesInstalled: boolean;
  gameInputInstalled: boolean;
  developerMode: boolean;
  wdappAvailable: boolean;
  wdappPath: string | null;
  architecture: string;
  installedPackages: BedrockInstalledPackage[];
  launchReady: boolean;
  message: string | null;
}

export interface BedrockPackageMetadata {
  version: string;
  packageType: "gdk" | "uwp" | string;
  channel: "release" | "preview" | string;
  architecture: string;
  packagePath: string | null;
  installMethod: "windows_update" | "native_msixvc" | "registered_store" | "wdapp" | string;
  packageFamilyName: string | null;
  appUserModelId: string | null;
  installLocation: string | null;
  launchReady: boolean;
  status: string;
  reason: string | null;
  profileMode: "isolated" | "shared" | string;
  registeredBySlh: boolean;
  extractedRoot: string | null;
  xboxXuid: string | null;
}

export interface JavaInstallation {
  path: string;
  version: string;
  majorVersion: number;
  source: string;
  compatible: boolean;
}

export interface LoaderVersion {
  id: string;
  stable: boolean;
  recommended: boolean;
}

export interface SyncMapping {
  id: string;
  category: "options" | "servers" | "resourcepacks" | "screenshots" | "mod-configs" | "worlds";
  instanceIds: string[];
  direction: "pull" | "push" | "bidirectional";
  enabled: boolean;
  sourceRelativePath: string;
  targetRelativePath: string;
  safetyLevel: "normal" | "caution" | "danger";
  lastSyncAt: string | null;
  createdAt: string;
}

export interface SyncRunResult {
  mappingId: string;
  instanceId: string;
  phase: "pull" | "push";
  copiedFiles: number;
  unchangedFiles: number;
  backupsCreated: number;
}

export interface ConsoleLine {
  timestamp: string | null;
  stream: "stdout" | "stderr" | "log";
  level: "info" | "warning" | "error" | "debug";
  text: string;
}

export interface ConsoleLineEvent extends ConsoleLine {
  launchId: string;
  instanceId: string;
}

export interface InstanceFileEntry {
  name: string;
  path: string;
  entryType: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string | null;
  iconDataUrl: string | null;
}

export interface VersionMigrationEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  fileCount: number;
  sizeBytes: number;
  selectedByDefault: boolean;
}

export interface VersionMigrationContent {
  path: string;
  isDirectory: boolean;
  provider: "modrinth" | "curseforge" | null;
  projectId: string | null;
  projectType: "mod" | "resourcepack" | "shader";
  displayName: string;
  currentVersionId: string | null;
  updateStatus: "available" | "current" | "incompatible" | "unknown" | "error";
  candidateVersion: string | null;
}

export interface InstanceVersionMigrationPreview {
  entries: VersionMigrationEntry[];
  content: VersionMigrationContent[];
  targetLoaderVersion: string | null;
  loaderError: string | null;
  lookupWarnings: string[];
}

export interface VersionMigrationIssue {
  path: string;
  displayName: string;
  projectType: "mod" | "resourcepack" | "shader";
  reason: "incompatible" | "unknown" | "error";
  action: VersionMigrationFallbackAction;
}

export type VersionMigrationFallbackAction = "copy" | "disable" | "skip";

export interface CreateInstanceVersionCopyResult {
  instance: Instance;
  updatedContentFiles: number;
  warnings: string[];
  issues: VersionMigrationIssue[];
}

export interface StorageSummary {
  totalBytes: number;
  databaseBytes: number;
  instancesBytes: number;
  sharedBytes: number;
  cacheBytes: number;
  downloadsBytes: number;
  javaBytes: number;
  logsBytes: number;
  backupsBytes: number;
}

export interface DownloadRecord {
  id: string;
  source: string;
  destination: string;
  status: "queued" | "running" | "complete" | "failed";
  downloadedBytes: number;
  totalBytes: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerEntry {
  index: number;
  name: string;
  address: string;
  acceptTextures: boolean | null;
  hasIcon: boolean;
}

export interface ArchiveInspection {
  archiveType: "slh" | "modrinth" | "curseforge" | "unknown";
  name: string | null;
  minecraftVersion: string | null;
  loaderType: string | null;
  loaderVersion: string | null;
  canImport: boolean;
  message: string;
}

export interface ExportResult {
  path: string;
  filesWritten: number;
  sizeBytes: number;
}

export interface ExportEntry {
  relativePath: string;
  isDirectory: boolean;
  files: number;
  sizeBytes: number;
}

export interface ProgressEvent {
  operationId: string;
  instanceId?: string | null;
  operation: string;
  stage: string;
  message: string;
  completed: number;
  total: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
}

export interface LaunchStateEvent {
  launchId: string;
  instanceId: string;
  state: "running" | "exited" | "crashed";
  exitCode?: number | null;
  durationSeconds?: number;
}

export interface CreateInstanceRequest {
  name: string;
  groupId: string | null;
  minecraftVersion: string;
  loaderType: Instance["loaderType"];
  loaderVersion: string | null;
  javaPath: string | null;
  memoryMinMb: number;
  memoryMaxMb: number;
  iconKey?: string | null;
  iconBackground?: string | null;
  iconForeground?: string | null;
  bedrockProfileMode?: "isolated" | "shared";
}

export interface DeleteInstanceResult {
  instanceId: string;
  backupPath: string | null;
}

export interface ModrinthProject {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  projectType: string;
  iconUrl: string | null;
  downloads: number;
  follows: number;
  author: string;
  categories: string[];
  versions: string[];
  dateModified: string;
}

export interface ModrinthSearchResult {
  hits: ModrinthProject[];
  offset: number;
  limit: number;
  totalHits: number;
}

export interface ProjectGalleryImage {
  url: string;
  thumbnailUrl: string | null;
  title: string | null;
  description: string | null;
}

export interface ModpackVersionOption {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
}

export interface ModrinthProjectDetails {
  projectId: string;
  body: string;
  gallery: ProjectGalleryImage[];
  modpackVersions: ModpackVersionOption[];
}

export interface InstalledContentRecord {
  provider: "modrinth" | "curseforge";
  projectId: string;
  versionId: string;
  projectType: "mod" | "resourcepack" | "shader" | "world";
  displayName: string;
  filePath: string;
}

export interface ContentInstallPlanItem {
  projectId: string;
  versionId: string;
  displayName: string;
  versionNumber: string;
  fileName: string;
  destination: string;
  sizeBytes: number;
  action: "install" | "update" | "unchanged";
}

export interface ContentInstallPlan {
  provider: "modrinth" | "curseforge";
  rootProjectId: string;
  instanceId: string;
  projectType: string;
  items: ContentInstallPlanItem[];
  conflicts: string[];
  totalBytes: number;
}

export interface ContentInstallResult {
  plan: ContentInstallPlan;
  installedFiles: number;
  unchangedFiles: number;
  backupsCreated: number;
}

export interface CommandFailure {
  code: string;
  message: string;
}

export interface SystemMetrics {
  cpuPercent: number | null;
  launcherCpuPercent: number | null;
  launcherMemoryBytes: number;
  launcherGpuPercent: number | null;
  launcherIoReadPerSecond: number | null;
  launcherIoWritePerSecond: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  networkReceivedPerSecond: number | null;
  networkSentPerSecond: number | null;
  gpuPercent: number | null;
  diskAvailableBytes: number | null;
  diskTotalBytes: number | null;
}
