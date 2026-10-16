import { useEffect } from "react";
import { command, isTauri } from "./tauri";
import type { ArchiveInspection, Instance } from "./types";
import { runPackInstall, usePackJobs } from "../stores/packJobs";

// Kept outside the effect so a settings refresh cannot restart a failed import.
const attempted = new Set<string>();

export function useCurseForgeArchiveImport(enabled: boolean, directory?: string | null) {
  useEffect(() => {
    if (!enabled || !isTauri) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous = new Set<string>();
    const scan = async () => {
      try {
        const files = await command<[string, string][]>("scan_curseforge_archives");
        if (!active) return;
        const current = new Set(files.map(([, signature]) => signature));
        if (attempted.size > 1024) attempted.clear();
        for (const [archivePath, signature] of files) {
          if (!active) break;
          if (!previous.has(signature) || attempted.has(signature)) continue;
          const key = `archive:${archivePath}`;
          if (usePackJobs.getState().jobs.some(job => job.key === key)) continue;
          let inspection: ArchiveInspection;
          try { inspection = await command<ArchiveInspection>("inspect_archive", { archivePath }); }
          catch { continue; /* An incomplete ZIP must not block other packs. */ }
          if (!active) break;
          if (!inspection.canImport || inspection.archiveType !== "curseforge") { attempted.add(signature); continue; }
          attempted.add(signature);
          try {
            await runPackInstall({ key, name: inspection.name ?? "CurseForge", minecraftVersion: inspection.minecraftVersion ?? "",
              loaderType: (inspection.loaderType ?? "vanilla") as Instance["loaderType"],
              commandName: "import_curseforge_pack", args: { request: { archivePath, name: null } }, showDialog: true });
          } catch { /* The tracked job provides error details, downloads and retry. */ }
        }
        previous = current;
      } catch { /* A browser can rename or lock a file while completing it. */ }
      finally { if (active) timer = setTimeout(() => void scan(), 5000); }
    };
    void scan();
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, directory]);
}
