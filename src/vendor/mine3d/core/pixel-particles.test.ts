import { expect, it } from "vitest";
import { Mesh, Vector3 } from "three";
import { PixelParticles } from "./pixel-particles";

it("shares dust geometry inside a scene and releases it without affecting another scene", () => {
  const first = new PixelParticles();
  const second = new PixelParticles();
  first.spawnDust(new Vector3(), 2);
  second.spawnDust(new Vector3(), 1);
  const geometry = (first.group.children[0] as Mesh).geometry;
  const other = (second.group.children[0] as Mesh).geometry;
  expect((first.group.children[1] as Mesh).geometry).toBe(geometry);
  expect(other).not.toBe(geometry);
  let disposed = 0;
  let otherDisposed = 0;
  geometry.addEventListener("dispose", () => disposed++);
  other.addEventListener("dispose", () => otherDisposed++);
  first.dispose();
  expect(disposed).toBe(1);
  expect(otherDisposed).toBe(0);
  expect(first.group.children).toHaveLength(0);
  second.dispose();
  expect(otherDisposed).toBe(1);
});
