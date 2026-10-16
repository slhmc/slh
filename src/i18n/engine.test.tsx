// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { createTranslationEngine, engine, type LocaleSnapshot } from "./engine";
import { useUiText } from "./UiText";
const snapshot = (code: string, messages: Record<string, unknown>, valid = true): LocaleSnapshot => ({ code, messages, valid, locales: [], diagnostics: [] });
afterEach(() => { cleanup(); engine.apply(snapshot("en-US", {})); });

describe("translation engine", () => {
  it("resolves sections, fallbacks and placeholders without interpreting HTML", () => {
    const value = createTranslationEngine();
    value.apply(snapshot("fr-FR", { installation: { installNamed: "Installer {name}" } }));
    expect(value.t("installation.installNamed", undefined, { name: "<script>" })).toBe("Installer <script>");
    expect(value.t("common.close")).toBe("Close");
  });
  it("uses the language's plural categories", () => {
    const value = createTranslationEngine();
    value.apply(snapshot("ru-RU", { library: { instanceCount: { one: "{count} сборка", few: "{count} сборки", many: "{count} сборок", other: "{count} сборки" } } }));
    expect([1, 2, 5, 21].map(count => value.t("library.instanceCount", undefined, { count }))).toEqual(["1 сборка", "2 сборки", "5 сборок", "21 сборка"]);
  });
  it("formats numeric parameters and known diagnostics in the selected language", () => {
    const value = createTranslationEngine();
    value.apply(snapshot("de-DE", { installation: { installNamed: "Installieren: {name}" }, errors: { network_error: "Download fehlgeschlagen. Erneut versuchen." } }));
    expect(value.t("installation.installNamed", undefined, { name: 1234.5 })).toBe("Installieren: 1.234,5");
    value.rememberDiagnostic("download: HTTP 503", "errors.network_error");
    expect(value.tr("download: HTTP 503")).toBe("Download fehlgeschlagen. Erneut versuchen.");
  });
  it("keeps the last valid active language while a file is partially saved and recovers", () => {
    const value = createTranslationEngine();
    value.apply(snapshot("fr-FR", { common: { close: "Fermer" } }));
    value.apply({ ...snapshot("fr-FR", {}, false), diagnostics: [{ path: "fr-FR.json", reason: "invalid JSON" }] });
    expect(value.t("common.close")).toBe("Fermer");
    expect(value.getSnapshot().diagnostics).toHaveLength(1);
    value.apply(snapshot("fr-FR", { common: { close: "Fermer la fenêtre" } }));
    expect(value.t("common.close")).toBe("Fermer la fenêtre");
  });
  it("reads old source-key dictionaries and captures notification keys", () => {
    const value = createTranslationEngine();
    value.apply(snapshot("fr-FR", { legacy: { Close: "Fermer" } }));
    expect(value.tr("Close")).toBe("Fermer");
    expect(value.t("common.close")).toBe("Fermer");
    expect(value.keyOf("Fermer")).toBe("common.close");
  });
  it("updates text and attributes without remounting, losing input or repeating effects", () => {
    let mounts = 0;
    function Form() {
      const text = useUiText();
      const [input, setInput] = useState(() => { mounts++; return ""; });
      return <div><input aria-label={text("common.close")} value={input} onChange={event => setInput(event.target.value)} /><button>{text("common.close")}</button></div>;
    }
    render(<Form />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unfinished pack name" } });
    const before = screen.getByRole("textbox");
    act(() => engine.apply(snapshot("fr-FR", { common: { close: "Fermer" } })));
    expect(screen.getByRole("button").textContent).toBe("Fermer");
    expect(screen.getByRole("textbox", { name: "Fermer" })).toBe(before);
    expect((before as HTMLInputElement).value).toBe("Unfinished pack name");
    expect(mounts).toBe(1);
    expect(document.documentElement.lang).toBe("fr-FR");
  });
});
