import { expect, it, vi, afterEach } from "vitest";
import { candidateGenres, describedModCount, emptyAnswers, randomIndex, rankPacks, type PackCandidate } from "./modpackFinder";
const pack = (id: string, description: string, categories: string[] = []): PackCandidate => ({ provider: "modrinth", project: {
  projectId: id, slug: id, title: id, description, categories, projectType: "modpack", downloads: 100,
  follows: 0, author: "Author", iconUrl: null, versions: ["1.20.1"], dateModified: "",
} });
afterEach(() => vi.restoreAllMocks());
it("needs no answers, and a single genre works without filling technical fields", () => {
  const magic = pack("magic", "Magic and quests", ["magic"]);
  const tech = pack("tech", "Technology with automation", ["technology"]);
  expect(rankPacks([tech, magic], emptyAnswers)).toHaveLength(2);
  expect(rankPacks([tech, magic], { ...emptyAnswers, genres: ["magic"] }).map(item => item.project.projectId)).toEqual(["magic"]);
});
it("weights explicit answers above popularity and never presents missing counts as verified", () => {
  const known = pack("known", "Magic with 80 mods and quests");
  const unknown = pack("unknown", "Magic lightweight");
  unknown.project.downloads = 100000000;
  const ranked = rankPacks([unknown, known], { ...emptyAnswers, genres: ["magic"], size: "small", progression: "quests" });
  expect(ranked[0].project.projectId).toBe("known");
  expect(ranked[1].sizeUnknown).toBe(true);
  expect(ranked[1].reasons).not.toContain("options.small");
  expect(describedModCount(pack("ru", "Сборка из 240 модов.").project)).toBe(240);
});
it("keeps hard version constraints and removes duplicate provider/project pairs", () => {
  const candidate = pack("one", "A magic modpack");
  expect(rankPacks([candidate, candidate], emptyAnswers)).toHaveLength(1);
  expect(rankPacks([candidate, { ...candidate, provider: "curseforge" }], emptyAnswers)).toHaveLength(1);
  expect(rankPacks([candidate], { ...emptyAnswers, gameVersion: "1.21.1" })).toHaveLength(0);
  expect(candidateGenres(candidate.project)).toContain("magic");
});
it("samples the entire requested integer range without modulo bias", () => {
  let call = 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(array => {
    (array as Uint32Array)[0] = call++ === 0 ? 0xffffffff : 9;
    return array;
  });
  expect(randomIndex(10)).toBe(9);
  expect(call).toBe(2);
  expect(() => randomIndex(0)).toThrow();
});
