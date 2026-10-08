import { Coffee, Cube, DownloadSimple, FolderOpen, HardDrives } from "../components/icons";

export const homeStatusItems = [
  { id: "launcher", label: "Launcher", icon: Cube },
  { id: "java", label: "Java", icon: Coffee },
  { id: "downloads", label: "Downloads", icon: DownloadSimple },
  { id: "storage", label: "Storage", icon: HardDrives },
  { id: "folder", label: "Data folder", icon: FolderOpen },
] as const;
export type HomeStatusId = typeof homeStatusItems[number]["id"];
export const homeStatusIds: HomeStatusId[] = homeStatusItems.map((item) => item.id);
export function homeStatusOrder(saved?: string[]): HomeStatusId[] {
  return [...new Set([...(saved ?? []), ...homeStatusIds])].filter((id): id is HomeStatusId => homeStatusIds.includes(id as HomeStatusId));
}
