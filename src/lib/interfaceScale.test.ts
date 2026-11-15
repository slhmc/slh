import { expect, it } from "vitest";
import { interfaceZoom } from "./interfaceScale";

it("maps the displayed scale onto the 90% baseline without changing the saved percentage", () => {
  expect(interfaceZoom(100)).toBe(0.9);
  expect(interfaceZoom(90)).toBe(0.81);
  expect(interfaceZoom(150)).toBe(1.35);
  expect(interfaceZoom(200)).toBe(1.8);
});
