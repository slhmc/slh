import english from "../../resources/languages/en-US.json";
import sources from "./sources.json";
import type { LocaleDescriptor } from "../lib/types";

export type LocaleTree = Record<string, unknown>;
export type TranslationParams = Record<string, string | number>;
export interface LocaleDiagnostic { path: string; reason: string }
export interface LocaleSnapshot {
  code: string;
  messages: LocaleTree;
  locales: LocaleDescriptor[];
  diagnostics: LocaleDiagnostic[];
  valid: boolean;
}
const sourceKeys = sources as Record<string, string>;
function resolve(tree: LocaleTree, key: string): unknown {
  return key.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as LocaleTree)[part] : undefined, tree);
}
export function interpolate(text: string, params: TranslationParams = {}, locale = "en-US") {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (params[key] === undefined) return match;
    if (typeof params[key] === "number") {
      try { return new Intl.NumberFormat(locale).format(params[key]); } catch { /* Legacy locale identifiers. */ }
    }
    return String(params[key]);
  });
}
export function createTranslationEngine() {
  let state: LocaleSnapshot = { code: "en-US", messages: english, locales: [], diagnostics: [], valid: true };
  const listeners = new Set<() => void>();
  const diagnostics = new Map<string, { key: string; params?: TranslationParams }>();
  const t = (key: string, fallback?: string, params?: TranslationParams): string => {
    const original = key;
    key = sourceKeys[key] ?? key;
    const select = (value: unknown): string | undefined => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && typeof params?.count === "number") {
        let category = "other";
        try { category = new Intl.PluralRules(state.code).select(params.count); } catch { /* Old locale codes use other. */ }
        const forms = value as Record<string, unknown>;
        const result = forms[category] ?? forms.other;
        if (typeof result === "string") return result;
      }
      return undefined;
    };
    const source = typeof resolve(english, key) === "string" ? resolve(english, key) as string : fallback;
    const legacy = state.messages.legacy as Record<string, unknown> | undefined;
    const value = select(resolve(state.messages, key)) ?? (source ? select(legacy?.[source]) : undefined)
      ?? select(resolve(english, key)) ?? fallback ?? original;
    return interpolate(value, params, state.code);
  };
  const tr = (source: string, params?: TranslationParams): string => {
    const diagnostic = diagnostics.get(source);
    if (diagnostic) return t(diagnostic.key, undefined, diagnostic.params);
    if (sourceKeys[source]) return t(sourceKeys[source], source, params);
    if (resolve(english, source) !== undefined) return t(source, undefined, params);
    const legacy = state.messages.legacy as Record<string, unknown> | undefined;
    return interpolate(typeof legacy?.[source] === "string" ? legacy[source] as string : source, params, state.code);
  };
  return {
    t, tr,
    rememberDiagnostic: (message: string, key: string, params?: TranslationParams) => {
      if (resolve(english, key) === undefined) return;
      if (diagnostics.size >= 200) diagnostics.delete(diagnostics.keys().next().value!);
      diagnostics.set(message, { key, params });
    },
    isDiagnostic: (message: string) => diagnostics.has(message),
    keyOf: (value: string, params?: TranslationParams): string => {
      if (!value) return value;
      if (diagnostics.has(value)) return diagnostics.get(value)!.key;
      if (sourceKeys[value]) return sourceKeys[value];
      // Notifications may arrive already localized. Store their key so an open toast also switches language.
      for (const key of Object.values(sourceKeys)) if (t(key, undefined, params) === value) return key;
      return value;
    },
    isLocalized: (source: string) => Boolean(diagnostics.has(source) || sourceKeys[source] || resolve(english, source) !== undefined || (state.messages.legacy as Record<string, unknown> | undefined)?.[source]),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    apply: (next: LocaleSnapshot) => {
      const value = !next.valid && state.code === next.code ? {
        ...next, messages: state.messages,
        locales: next.locales.some(item => item.code === next.code) ? next.locales
          : [...next.locales, ...state.locales.filter(item => item.code === next.code)],
      } : next;
      if (JSON.stringify(value) === JSON.stringify(state)) return;
      state = value;
      if (typeof document !== "undefined") {
        document.documentElement.lang = state.code;
        document.documentElement.dir = /^(ar|he|fa|ur)(-|$)/i.test(state.code) ? "rtl" : "ltr";
      }
      listeners.forEach((listener) => listener());
    },
  };
}
export const engine = createTranslationEngine();
