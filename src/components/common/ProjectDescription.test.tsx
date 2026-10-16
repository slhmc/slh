// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { descriptionUrl, MarkdownRenderer } from "./ProjectDescription";
const opener = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opener }));
afterEach(() => { cleanup(); opener.mockClear(); });
it("keeps full HTML, external images, tables and decoded CurseForge links", () => {
  render(<MarkdownRenderer onImage={vi.fn()} markdown={'<h2>Features</h2><p>Full description</p><img src="https://i.imgur.com/banner.webp" alt="banner" width="850"><table><tr><td>Details</td></tr></table><a href="/linkout?remoteUrl=https%253a%252f%252fexample.com%252fguide">Guide</a>'} />);
  expect(screen.getByRole("heading").textContent).toBe("Features");
  expect(screen.getByRole("img").getAttribute("src")).toBe("https://i.imgur.com/banner.webp");
  expect(screen.getByRole("table").textContent).toBe("Details");
  fireEvent.click(screen.getByText("Guide"));
  expect(opener).toHaveBeenCalledWith("https://example.com/guide");
});
it("shows YouTube previews without executing iframes or their surrounding sponsor link", () => {
  const { container } = render(<MarkdownRenderer onImage={vi.fn()} markdown={'<a href="https://sponsor.example"><iframe src="https://www.youtube.com/embed/hALnQl07S7E"></iframe></a><iframe src="https://attacker.example"></iframe><script>alert(1)</script>'} />);
  expect(container.querySelector("iframe, script")).toBeNull();
  const preview = screen.getByRole("link", { name: "YouTube" });
  fireEvent.click(preview);
  expect(opener).toHaveBeenCalledExactlyOnceWith("https://www.youtube.com/watch?v=hALnQl07S7E");
});
it("rejects executable and credential-bearing URLs including encoded linkouts", () => {
  expect(descriptionUrl("javascript:alert(1)")).toBeNull();
  expect(descriptionUrl("https://user:password@example.com")).toBeNull();
  expect(descriptionUrl("/linkout?remoteUrl=javascript%253Aalert(1)")).toBeNull();
});
