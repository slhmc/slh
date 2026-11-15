import { beforeEach, expect, it, vi } from "vitest";
import { emptyAnswers } from "./modpackFinder";
import { findPacks, randomPack, chooseRandomPack, filteredRandomPack } from "./modpackFinderSearch";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("./tauri", () => ({ command: mocks.command }));
const project = { projectId: "pack", title: "Magic pack", description: "Magic and exploration", categories: ["magic"], projectType: "modpack", versions: ["1.20.1"], downloads: 100 };
beforeEach(() => { mocks.command.mockReset(); });
it("random uses catalog totals and a random page with no quiz filters", async () => {
  const queries: Record<string, unknown>[] = [];
  mocks.command.mockImplementation(async (name, args) => {
    if (name === "list_content_providers") return [{ provider: "modrinth", available: true }];
    queries.push(args);
    return { hits: [project], totalHits: 19000, offset: args.offset, limit: 1 };
  });
  const result = await randomPack();
  expect(result.candidates).toHaveLength(1);
  expect(queries).toHaveLength(2);
  expect(queries.every(args => args.query === "" && args.gameVersion === null && args.loader === null && args.limit === 1)).toBe(true);
  expect(Number(queries[1].offset)).toBeLessThan(19000);
});
it("uses available catalogs and preserves quiz facets through every search", async () => {
  mocks.command.mockImplementation(async (name, args) => {
    if (name === "list_content_providers") return [{ provider: "modrinth", available: true }, { provider: "curseforge", available: false }];
    expect(name).toBe("search_modrinth");
    expect(args).toMatchObject({ projectType: "modpack", gameVersion: "1.20.1", loader: "fabric" });
    return { hits: [project], totalHits: 1, offset: 0, limit: 40 };
  });
  const result = await findPacks({ ...emptyAnswers, genres: ["magic"], gameVersion: "1.20.1", loader: "fabric" });
  expect(result.candidates).toHaveLength(1);
  expect(result.unavailable).toEqual(["curseforge"]);
});
it("reports offline providers instead of returning a fabricated fallback", async () => {
  mocks.command.mockResolvedValue([{ provider: "modrinth", available: false }, { provider: "curseforge", available: false }]);
  await expect(randomPack()).rejects.toThrow("packFinder.offline");
  await expect(findPacks(emptyAnswers)).rejects.toThrow("packFinder.offline");
});

it("enforces strict download thresholds, genres, nearest ties and exclusion", () => {
  const pool = [90, 100, 110].map(downloads => ({ provider: "modrinth" as const, project: { ...project, projectId: String(downloads), downloads } as any }));
  const options = { genres: ["magic"], downloadsMode: "more" as const, downloads: 100 };
  expect(chooseRandomPack(pool, options)?.project.downloads).toBe(110);
  expect(chooseRandomPack(pool, { ...options, downloadsMode: "less" })?.project.downloads).toBe(90);
  expect(chooseRandomPack(pool, { ...options, downloadsMode: "closest" })?.project.downloads).toBe(100);
  expect(chooseRandomPack(pool, { ...options, downloadsMode: "closest" }, "modrinth:100")?.project.downloads).not.toBe(100);
  expect(chooseRandomPack(pool, { ...options, genres: ["horror"] })).toBeNull();
});
it("finds the download boundary with bounded catalog probes", async () => {
  let calls = 0;
  mocks.command.mockImplementation(async (name, args) => {
    if (name === "list_content_providers") return [{ provider: "modrinth", available: true }];
    calls++;
    const offset = Number(args.offset);
    return { totalHits: 4096, hits: Array.from({ length: Math.min(args.limit, 4096 - offset) }, (_, index) => ({ ...project, projectId: String(offset + index), downloads: 4096 - offset - index })) };
  });
  const candidate = await filteredRandomPack({ genres: ["magic"], downloadsMode: "closest", downloads: 55 });
  expect(candidate?.project.downloads).toBe(55);
  expect(calls).toBeLessThan(20);
});
it("does not silently loosen filters when no pack qualifies", async () => {
  mocks.command.mockImplementation(async name => name === "list_content_providers" ? [{ provider: "modrinth", available: true }] : { hits: [project], totalHits: 1 });
  expect(await filteredRandomPack({ genres: ["horror"], downloadsMode: "more", downloads: 500 })).toBeNull();
});
