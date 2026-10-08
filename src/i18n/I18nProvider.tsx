import { createContext, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { command } from "../lib/tauri";

type LocaleTree = Record<string, unknown>;
type LegacyDictionary = Record<string, string>;
type TranslationParams = Record<string, string | number>;

interface I18nContextValue {
  locale: string;
  t: (key: string, fallback?: string) => string;
  tr: (source: string, params?: TranslationParams) => string;
  isLocalized: (text: string) => boolean;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "en-US",
  t: (_key, fallback) => fallback ?? _key,
  tr: (source, params) => interpolate(source, params),
  isLocalized: () => false,
});

function interpolate(source: string, params?: TranslationParams) {
  return Object.entries(params ?? {}).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    source,
  );
}

// Legacy views still contain source-language literals. Keep their original
// values so a live locale switch can translate from the source again instead
// of trying to translate text that was already replaced by another locale.
const originalText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<HTMLElement, Map<string, string>>();

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const [bundle, setBundle] = useState<{ code: string; messages: LocaleTree; revision: number }>({
    code: locale,
    messages: {},
    revision: 0,
  });

  useEffect(() => {
    let active = true;
    command<LocaleTree>("load_locale", { code: locale })
      .then((value) => {
        if (active) setBundle((current) => ({ code: locale, messages: value, revision: current.revision + 1 }));
      })
      .catch(() => {
        if (active) setBundle((current) => ({ code: locale, messages: {}, revision: current.revision + 1 }));
      });
    return () => {
      active = false;
    };
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => {
    const legacy = bundle.messages.legacy;
    const dictionary = typeof legacy === "object" && legacy !== null ? legacy as LegacyDictionary : null;
    const localizedTexts = new Set<string>();
    if (dictionary) {
      for (const [source, translated] of Object.entries(dictionary)) {
        localizedTexts.add(source);
        localizedTexts.add(translated);
      }
    }

    return {
      locale: bundle.code,
      t: (key, fallback) => {
        const resolved = key.split(".").reduce<unknown>((current, part) => {
          if (typeof current !== "object" || current === null) return undefined;
          return (current as LocaleTree)[part];
        }, bundle.messages);
        return typeof resolved === "string" ? resolved : fallback ?? key;
      },
      tr: (source, params) => {
        if (!dictionary) return interpolate(source, params);
        const translated = dictionary[source];
        return interpolate(typeof translated === "string" ? translated : source, params);
      },
      isLocalized: (text) => localizedTexts.has(text),
    };
  }, [bundle]);

  useEffect(() => {
    const legacy = bundle.messages.legacy;
    if (typeof legacy !== "object" || legacy === null) return undefined;
    const dictionary = legacy as LegacyDictionary;
    const translate = (source: string) => dictionary[source.trim()];
    const translateNode = (node: Text) => {
      if (node.parentElement?.closest("[data-content-provider]")) return;
      const current = node.nodeValue ?? "";
      const original = originalText.get(node) ?? current;
      if (!originalText.has(node)) originalText.set(node, original);
      const replacement = translate(original);
      if (!replacement) return;
      const leading = original.match(/^\s*/)?.[0] ?? "";
      const trailing = original.match(/\s*$/)?.[0] ?? "";
      const next = `${leading}${replacement}${trailing}`;
      if (current !== next) node.nodeValue = next;
    };
    const translateTree = (root: Node) => {
      if (root instanceof Element && root.closest("[data-content-provider]")) return;
      if (root.parentElement?.closest("[data-content-provider]")) return;
      if (root.nodeType === Node.TEXT_NODE) translateNode(root as Text);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) translateNode(node as Text);
      const element = root instanceof Element ? root : root.parentElement;
      element?.querySelectorAll<HTMLElement>("[placeholder], [title], [aria-label]").forEach((item) => {
        let sources = originalAttributes.get(item);
        if (!sources) {
          sources = new Map();
          originalAttributes.set(item, sources);
        }
        for (const attribute of ["placeholder", "title", "aria-label"] as const) {
          const current = item.getAttribute(attribute);
          if (current !== null && !sources.has(attribute)) sources.set(attribute, current);
          const original = sources.get(attribute);
          const replacement = original ? translate(original) : undefined;
          if (replacement && replacement !== current) item.setAttribute(attribute, replacement);
        }
      });
    };
    translateTree(document.body);
    let scheduled = false;
    let disposed = false;
    let timer: number | undefined;
    const pending = new Set<Node>();
    const flush = () => {
      scheduled = false;
      timer = undefined;
      if (disposed || pending.size === 0) return;
      const roots = Array.from(pending);
      pending.clear();
      observer.disconnect();
      roots.forEach((root) => {
        if (root.nodeType === Node.TEXT_NODE) translateNode(root as Text);
        else translateTree(root);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    const schedule = (node: Node) => {
      pending.add(node);
      if (!scheduled) {
        scheduled = true;
        timer = window.setTimeout(flush, 0);
      }
    };
    const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => {
      if (mutation.type === "characterData") schedule(mutation.target);
      mutation.addedNodes.forEach(schedule);
    }));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      pending.clear();
      observer.disconnect();
    };
  }, [bundle]);

  // Remount the translated tree when the locale changes. Besides reloading the
  // dictionary, this gives the legacy text observer a fresh set of source
  // strings, so switching back and forth between languages never leaves stale
  // text from the previous locale in the DOM.
  return (
    <I18nContext.Provider value={value}>
      <Fragment key={`${bundle.code}:${bundle.revision}`}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
