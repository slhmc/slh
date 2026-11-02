export interface LiveServerEdit { kind: string; value: string; rule?: string }
export interface LiveServerResult { command: string; lines: string[] }

export function serverVersionAtLeast(version: string, minor: number, patch = 0) {
  const snapshot = /^(\d+)w(\d+)/.exec(version);
  if (snapshot && Number(snapshot[1]) >= 25) {
    const snapshotPatch = Number(snapshot[1]) > 25 || Number(snapshot[2]) >= 44 ? 11 : Number(snapshot[2]) >= 35 ? 9 : 5;
    return minor < 21 || minor === 21 && patch <= snapshotPatch;
  }
  const release = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!release) return false;
  return Number(release[1]) > 1 || Number(release[2]) > minor || Number(release[2]) === minor && Number(release[3] ?? 0) >= patch;
}
export function namespacedGameRules(version: string) {
  const snapshot = /^(\d+)w(\d+)/.exec(version);
  return snapshot ? Number(snapshot[1]) > 25 || Number(snapshot[1]) === 25 && Number(snapshot[2]) >= 44 : serverVersionAtLeast(version, 21, 11);
}
// Explicit mappings: new names are not a mechanical camelCase conversion.
const rules = [
  ["keepInventory", "keep_inventory", "boolean", 4],
  ["mobGriefing", "mob_griefing", "boolean", 4],
  ["doFireTick", "fire_spread_radius_around_player", "boolean", 4],
  ["doDaylightCycle", "advance_time", "boolean", 6],
  ["doWeatherCycle", "advance_weather", "boolean", 11],
  ["doMobSpawning", "spawn_mobs", "boolean", 4],
  ["doMobLoot", "mob_drops", "boolean", 4],
  ["doTileDrops", "block_drops", "boolean", 4],
  ["naturalRegeneration", "natural_health_regeneration", "boolean", 6],
  ["doImmediateRespawn", "immediate_respawn", "boolean", 15],
  ["showDeathMessages", "show_death_messages", "boolean", 4],
  ["sendCommandFeedback", "send_command_feedback", "boolean", 8],
  ["commandBlockOutput", "command_block_output", "boolean", 4],
  ["randomTickSpeed", "random_tick_speed", "number", 8],
  ["spawnRadius", "respawn_radius", "number", 9],
  ["maxEntityCramming", "max_entity_cramming", "number", 11],
  ["playersSleepingPercentage", "players_sleeping_percentage", "number", 17],
  ["doInsomnia", "spawn_phantoms", "boolean", 13],
  ["fallDamage", "fall_damage", "boolean", 15],
  ["fireDamage", "fire_damage", "boolean", 15],
  ["drowningDamage", "drowning_damage", "boolean", 15],
  ["freezeDamage", "freeze_damage", "boolean", 17],
  ["doPatrolSpawning", "spawn_patrols", "boolean", 15],
  ["doTraderSpawning", "spawn_wandering_traders", "boolean", 15],
  ["doWardenSpawning", "spawn_wardens", "boolean", 19],
  ["pvp", "pvp", "boolean", 21],
  ["commandBlocksEnabled", "command_blocks_work", "boolean", 21],
  ["allowEnteringNetherUsingPortals", "allow_entering_nether_using_portals", "boolean", 21],
] as const;
export function serverGameRules(version: string) {
  const modern = namespacedGameRules(version);
  return rules.filter(([key, , , minor]) => ["pvp", "commandBlocksEnabled", "allowEnteringNetherUsingPortals"].includes(key)
    ? serverVersionAtLeast(version, 21, 9) : serverVersionAtLeast(version, minor))
    .map(([key, name, type]) => ({ key, command: modern ? `minecraft:${name}` : key, type: key === "doFireTick" && modern ? "number" as const : type }));
}
