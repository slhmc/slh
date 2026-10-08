/** Zero means no application frame cap; old settings default to 30 FPS. */
export function homeCharacterFps(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 60 ? value : 30;
}

export function fpsFromSlider(position: number, snap: boolean): number {
  if (position === 61) return 0;
  if (snap) {
    const magnet = [30, 60].find((fps) => Math.abs(position - fps) <= 2);
    if (magnet !== undefined) return magnet;
  }
  return homeCharacterFps(position);
}
