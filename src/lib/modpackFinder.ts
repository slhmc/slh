import type { ModrinthProject } from "./types";

export type PackProvider = "modrinth" | "curseforge";
export type PackCandidate = { provider: PackProvider; project: ModrinthProject; preferredGameVersion?: string; preferredLoader?: string };
export type FinderAnswers = {
  genres: string[]; size: string; difficulty: string; activity: string;
  progression: string; company: string; gameVersion: string; loader: string;
  query: string; source: PackProvider | "both";
};
export const emptyAnswers: FinderAnswers = { genres: [], size: "", difficulty: "", activity: "", progression: "", company: "", gameVersion: "", loader: "", query: "", source: "both" };
export const genreTerms: Record<string, string[]> = {
  adventure: ["adventure", "exploration", "приключен"],
  technology: ["technology", "tech", "automation", "create", "технолог"],
  magic: ["magic", "fantasy", "магия"],
  rpg: ["rpg", "roleplay", "role-playing", "dungeon"],
  survival: ["survival", "hardcore", "выживан"],
  skyblock: ["skyblock", "sky-block", "stoneblock"],
  horror: ["horror", "scary", "хоррор"],
  cozy: ["cozy", "farming", "relax", "cottage", "уют"],
  pokemon: ["pokemon", "pokémon", "cobblemon", "pixelmon"],
  vanilla: ["vanilla", "optimization", "lightweight", "ваниль"],
};
const preferenceTerms: Record<string, string[]> = {
  relaxed: ["cozy", "relax", "casual", "beginner", "easy"],
  challenging: ["expert", "hardcore", "difficult", "challeng", "hard"],
  exploration: ["exploration", "adventure", "biome", "worldgen"],
  building: ["building", "decorat", "creative", "architect"],
  automation: ["automation", "tech", "factory", "create"],
  combat: ["combat", "boss", "dungeon", "rpg"],
  quests: ["quest", "progression", "story"],
  sandbox: ["sandbox", "kitchen-sink", "kitchen sink", "creative"],
  solo: ["singleplayer", "single-player", "solo"],
  friends: ["multiplayer", "co-op", "coop", "friends", "server"],
};
export const candidateKey = (candidate: PackCandidate) => `${candidate.provider}:${candidate.project.projectId}`;
const textOf = (project: ModrinthProject) => `${project.title} ${project.description} ${project.categories.join(" ")}`.toLowerCase();
const contains = (text: string, terms: string[]) => terms.some(term => text.includes(term));
/** This is a statement in the author's description, not a manifest inspection. */
export function describedModCount(project: ModrinthProject): number | null {
  const match = project.description.match(/\b([1-9]\d{0,3})\s*\+?\s*(?:mods\b|мод(?:ов|а)?(?=\s|[.,!?]|$))/i);
  return match ? Number(match[1]) : null;
}
export function candidateGenres(project: ModrinthProject): string[] {
  const text = textOf(project);
  return Object.keys(genreTerms).filter(genre => contains(text, genreTerms[genre]));
}
export type RankedPack = PackCandidate & { score: number; reasons: string[]; sizeUnknown: boolean };
export function rankPacks(candidates: PackCandidate[], answers: FinderAnswers): RankedPack[] {
  const seen = new Set<string>();
  const identities = new Set<string>();
  return candidates.flatMap(candidate => {
    const { project } = candidate;
    if (project.projectType !== "modpack" || seen.has(candidateKey(candidate))) return [];
    seen.add(candidateKey(candidate));
    if (answers.gameVersion && !project.versions.includes(answers.gameVersion)) return [];
    // Providers enforce loader/version facets; loader is not always in the DTO categories.
    const text = textOf(project);
    const genres = answers.genres.filter(genre => contains(text, genreTerms[genre] ?? []));
    if (answers.genres.length && !genres.length) return [];
    const identity = `${project.title.trim().toLowerCase()}:${project.slug?.toLowerCase() ?? project.projectId}`;
    if (identities.has(identity)) return [];
    identities.add(identity);
    const reasons = genres.map(genre => `genres.${genre}`);
    let score = genres.length * 12;
    for (const field of ["difficulty", "activity", "progression", "company"] as const) {
      const value = answers[field];
      if (value && contains(text, preferenceTerms[value] ?? [])) { score += 5; reasons.push(`options.${value}`); }
    }
    const count = describedModCount(project);
    const knownSize = count === null ? null : count <= 100 ? "small" : count <= 250 ? "medium" : "large";
    const taggedSmall = contains(text, ["lightweight", "light-weight", "light weight"]);
    if (answers.size && knownSize === answers.size) {
      score += 7; reasons.push(`options.${answers.size}`);
    } else if (answers.size && knownSize) { score -= 7; }
    else if (answers.size === "small" && taggedSmall) { score += 4; reasons.push("lightweight"); }
    // Popularity only breaks close matches; it cannot outweigh a genre match.
    score += Math.min(3, Math.log10(Math.max(1, project.downloads)) / 3);
    return [{ ...candidate, score, reasons, sizeUnknown: Boolean(answers.size && knownSize === null) }];
  }).sort((a, b) => b.score - a.score || candidateKey(a).localeCompare(candidateKey(b)));
}

/** Rejection sampling avoids modulo bias, including when the catalog size is small. */
export function randomIndex(length: number): number {
  if (!Number.isSafeInteger(length) || length < 1 || length > 0xffffffff) throw new Error("Invalid random range");
  const ceiling = Math.floor(0x100000000 / length) * length;
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= ceiling);
  return value[0] % length;
}

export type FinderRequest = { query?: string; source?: PackProvider; random?: boolean; exclude?: string; excludeTitle?: string };
export function openModpackFinder(request: FinderRequest = {}) {
  window.dispatchEvent(new CustomEvent<FinderRequest>("slh-find-modpack", { detail: request }));
}
