// Cargo/Tauri use numeric build metadata for the fourth and later parts.
export function releaseVersion(internal) {
  const match = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?\+(\d+(?:\.\d+)*)$/.exec(internal);
  return match ? `${match[1]}.${match[3]}${match[2] ?? ""}` : internal;
}
