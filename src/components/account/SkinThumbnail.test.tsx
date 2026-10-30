// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SkinThumbnail } from "./SkinThumbnail";

const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../../lib/homePortrait", () => ({ homePortrait: mocks.render }));
afterEach(() => { cleanup(); window.dispatchEvent(new Event("slh-release-scenes")); vi.unstubAllGlobals(); });

it("shares one static render between duplicate cards and releases their image URLs", async () => {
  const OriginalURL = URL;
  const create = vi.fn().mockImplementation(() => `blob:thumbnail-${create.mock.calls.length}`);
  const revoke = vi.fn();
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = create; static revokeObjectURL = revoke; });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  mocks.render.mockResolvedValue(new Blob(["PNG"], { type: "image/png" }));
  const view = render(<><SkinThumbnail skin="fixture" model="slim" label="One" /><SkinThumbnail skin="fixture" model="slim" label="Two" /></>);
  await waitFor(() => expect(view.container.querySelectorAll('img[src^="blob:"]').length).toBe(2));
  expect(mocks.render).toHaveBeenCalledOnce();
  expect(view.container.querySelectorAll("canvas").length).toBe(0);
  view.unmount();
  expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(["blob:thumbnail-1", "blob:thumbnail-2"]);
});
