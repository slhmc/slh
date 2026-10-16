export type HomeCharacterMode = 0 | 1 | 2;

/** Existing installations retain their animated character. */
export function homeCharacterMode(value: unknown): HomeCharacterMode {
  return value === 0 || value === 1 ? value : 2;
}
