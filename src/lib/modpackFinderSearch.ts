import { command } from "./tauri";
import type { ModrinthSearchResult, ProviderAvailability } from "./types";
import { candidateGenres, candidateKey, emptyAnswers, genreTerms, randomIndex, rankPacks, type FinderAnswers, type PackCandidate, type PackProvider } from "./modpackFinder";

export type FinderSearchResult = { candidates: PackCandidate[]; unavailable: PackProvider[]; random: boolean };
const providers: PackProvider[] = ["modrinth", "curseforge"];
async function search(provider: PackProvider, answers: FinderAnswers, query: string, offset = 0, limit = 40, sort = "downloads") {
  return command<ModrinthSearchResult>(`search_${provider}`, {
    projectType: "modpack", query, gameVersion: answers.gameVersion || null,
    loader: answers.loader || null, category: null, offset, limit, sort,
  });
}
async function availableProviders(source: FinderAnswers["source"]): Promise<{ available: PackProvider[]; unavailable: PackProvider[] }> {
  const status = await command<ProviderAvailability[]>("list_content_providers");
  const requested = source === "both" ? providers : [source];
  return { available: requested.filter(provider => status.some(item => item.provider === provider && item.available)),
    unavailable: requested.filter(provider => !status.some(item => item.provider === provider && item.available)) };
}
export async function findPacks(answers: FinderAnswers): Promise<FinderSearchResult> {
  const { available, unavailable } = await availableProviders(answers.source);
  if (!available.length) throw new Error("packFinder.offline");
  const queries = answers.query.trim() ? [answers.query.trim()] : [...new Set(["", ...answers.genres.slice(0, 3).map(genre => genreTerms[genre]?.[0] ?? genre)])];
  const requests = available.flatMap(provider => queries.map(query => ({ provider, query })));
  const results = await Promise.allSettled(requests.map(async ({ provider, query }) => ({ provider, result: await search(provider, answers, query) })));
  const failed = new Set<PackProvider>(unavailable);
  const candidates: PackCandidate[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") candidates.push(...result.value.result.hits.map(project => ({ provider: result.value.provider, project })));
    else failed.add(requests[index].provider);
  }
  if (results.every(result => result.status === "rejected")) throw new Error("packFinder.offline");
  return { candidates: rankPacks(candidates, answers), unavailable: [...failed], random: false };
}

export async function randomPack(exclude?: string): Promise<FinderSearchResult> {
  // Random ignores every answer, including the chosen provider, query, and version.
  const { available, unavailable } = await availableProviders("both");
  const totals = await Promise.allSettled(available.map(async provider => ({ provider, result: await search(provider, emptyAnswers, "", 0, 1, "newest") })));
  const failed = new Set(unavailable);
  const catalogs = totals.flatMap((result, index) => {
    if (result.status === "rejected") { failed.add(available[index]); return []; }
    // CurseForge's public API only exposes the first 10,000 search positions.
    // Modrinth has no corresponding search-window cap in its documented schema.
    const count = Math.floor(Math.max(0, Math.min(result.value.result.totalHits, result.value.provider === "curseforge" ? 10000 : 0x7fffffff)));
    return count ? [{ provider: result.value.provider, count }] : [];
  });
  if (!catalogs.length) {
    if (failed.size) throw new Error("packFinder.offline");
    return { candidates: [], unavailable: [], random: true };
  }
  let last: PackCandidate | undefined;
  for (let attempt = 0; attempt < 4 && catalogs.length; attempt++) {
    let position = randomIndex(catalogs.reduce((sum, catalog) => sum + catalog.count, 0));
    let chosen = catalogs[0];
    for (const catalog of catalogs) {
      chosen = catalog;
      if (position < catalog.count) break;
      position -= catalog.count;
    }
    try {
      const page = await search(chosen.provider, emptyAnswers, "", position, 1, "newest");
      const project = page.hits.find(project => project.projectType === "modpack");
      if (!project) continue; // Catalog may have changed between the two requests.
      last = { provider: chosen.provider, project };
      if (candidateKey(last) !== exclude) return { candidates: [last], unavailable: [...failed], random: true };
    } catch {
      failed.add(chosen.provider);
      catalogs.splice(catalogs.indexOf(chosen), 1);
    }
  }
  if (!last && failed.size) throw new Error("packFinder.offline");
  return { candidates: last ? [last] : [], unavailable: [...failed], random: true };
}

export async function similarPacks(candidate: PackCandidate, answers: FinderAnswers): Promise<FinderSearchResult> {
  const genres = candidateGenres(candidate.project);
  const result = await findPacks({ ...answers, genres: genres.length ? genres : answers.genres, source: candidate.provider });
  result.candidates = result.candidates.filter(item => candidateKey(item) !== candidateKey(candidate));
  return result;
}


export interface RandomPackOptions { genres: string[]; downloadsMode: "any" | "more" | "less" | "closest"; downloads: number }
export function chooseRandomPack(candidates: PackCandidate[], options: RandomPackOptions, exclude?: string, excludeTitle?: string): PackCandidate | null {
  const unique = new Map(candidates.map(candidate => [candidateKey(candidate), candidate]));
  let pool = [...unique.values()].filter(candidate => candidate.project.projectType === "modpack" && candidateKey(candidate) !== exclude && (!excludeTitle || candidate.project.title.trim().toLowerCase() !== excludeTitle.trim().toLowerCase())
    && (!options.genres.length || candidateGenres(candidate.project).some(genre => options.genres.includes(genre)))
    && (options.downloadsMode !== "more" || candidate.project.downloads > options.downloads)
    && (options.downloadsMode !== "less" || candidate.project.downloads < options.downloads));
  if (options.downloadsMode === "closest" && pool.length) {
    const distance = Math.min(...pool.map(candidate => Math.abs(candidate.project.downloads - options.downloads)));
    pool = pool.filter(candidate => Math.abs(candidate.project.downloads - options.downloads) === distance);
  }
  return pool.length ? pool[randomIndex(pool.length)] : null;
}
/** Probe download-sorted catalog positions instead of downloading every search page. */
export async function filteredRandomPack(options: RandomPackOptions, exclude?: string, excludeTitle?: string): Promise<PackCandidate | null> {
  if (!Number.isSafeInteger(options.downloads) || options.downloads < 0) throw new Error("packRandom.invalidDownloads");
  const { available } = await availableProviders("both");
  if (!available.length) throw new Error("packFinder.offline");
  const queries = options.genres.length ? options.genres.map(genre => genreTerms[genre]?.[0] ?? genre) : [""];
  const jobs = available.flatMap(provider => queries.map(query => ({ provider, query })));
  const candidates: PackCandidate[] = [];
  let succeeded = 0;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { provider, query } = jobs[next++];
      try {
        const first = await search(provider, emptyAnswers, query, 0, 40, "downloads");
        const count = Math.floor(Math.max(0, Math.min(first.totalHits, provider === "curseforge" ? 10000 : 0x7fffffff)));
        if (!count) { succeeded++; continue; }
        let boundary = count;
        if (options.downloadsMode !== "any") {
          let low = 0, high = count;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            const item = middle < first.hits.length ? first.hits[middle] : (await search(provider, emptyAnswers, query, middle, 1, "downloads")).hits[0];
            if (!item) { high = middle; continue; }
            const before = options.downloadsMode === "less" ? item.downloads >= options.downloads : item.downloads > options.downloads;
            if (before) low = middle + 1; else high = middle;
          }
          boundary = low;
        }
        const begin = options.downloadsMode === "less" ? boundary : 0;
        const end = options.downloadsMode === "more" ? boundary : count;
        if (begin >= end) { succeeded++; continue; }
        const offset = options.downloadsMode === "closest" ? Math.max(0, boundary - 20) : begin + randomIndex(end - begin);
        const window = await search(provider, emptyAnswers, query, offset, Math.min(40, count - offset), "downloads");
        candidates.push(...[...first.hits, ...window.hits].map(project => ({ provider, project })));
        succeeded++;
      } catch { /* Another catalog/genre may still provide a matching result. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  if (!succeeded) throw new Error("packFinder.offline");
  return chooseRandomPack(candidates, options, exclude, excludeTitle);
}
