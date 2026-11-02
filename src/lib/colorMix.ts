/** Resolve palette mixes before CSS reaches older WebKit. CSS keeps semantic tokens. */
export type ColorMixRegistry = Record<string, string>;
function split(value: string): string[] {
  let depth = 0, start = 0;
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;
    if (value[i] === "," && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}
export function replaceColorMixes(value: string, replace: (expression: string) => string): string {
  let result = "", start = 0, index: number;
  while ((index = value.indexOf("color-mix(", start)) !== -1) {
    let end = index + 10, depth = 1;
    while (end < value.length && depth) { if (value[end] === "(") depth++; if (value[end] === ")") depth--; end++; }
    if (depth) throw new Error("Unclosed palette mix");
    result += value.slice(start, index) + replace(value.slice(index, end)); start = end;
  }
  return result + value.slice(start);
}
export function lowerColorMixes(value: string, registry: ColorMixRegistry): string {
  return replaceColorMixes(value, expression => {
    let hash = 2166136261;
    for (const char of expression) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const token = `--color-mix-${(hash >>> 0).toString(16)}`;
    if (registry[token] && registry[token] !== expression) throw new Error("Palette token collision");
    registry[token] = expression;
    return `var(${token})`;
  });
}
type RGBA = [number, number, number, number];
function color(value: string, tokens: Record<string, unknown>, depth = 0): RGBA {
  if (depth > 20) throw new Error("Circular palette token");
  value = value.trim();
  if (value.startsWith("var(")) {
    const [name, fallback] = split(value.slice(4, -1));
    return color(String(tokens[name] ?? fallback ?? "transparent"), tokens, depth + 1);
  }
  if (value === "transparent") return [0, 0, 0, 0];
  if (/^#[\da-f]{6}$/i.test(value)) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).concat(1) as RGBA;
  if (/^rgba?\(/.test(value)) { const parts = value.slice(value.indexOf("(") + 1, -1).split(",").map(Number); return [parts[0], parts[1], parts[2], parts[3] ?? 1]; }
  if (value.startsWith("color-mix(")) {
    const [space, first, second] = split(value.slice(10, -1));
    if (space !== "in srgb") throw new Error(`Unsupported palette space: ${space}`);
    const part = (text: string) => { const match = text.match(/\s+([\d.]+)%$/); return { rgba: color(match ? text.slice(0, match.index) : text, tokens, depth + 1), weight: match ? Number(match[1]) / 100 : undefined }; };
    const a = part(first), b = part(second);
    const wa = a.weight ?? (b.weight === undefined ? .5 : 1 - b.weight), wb = b.weight ?? 1 - wa;
    const sum = wa + wb, alpha = (a.rgba[3] * wa + b.rgba[3] * wb) / sum;
    return [0, 1, 2].map(i => alpha ? (a.rgba[i] * a.rgba[3] * wa + b.rgba[i] * b.rgba[3] * wb) / sum / alpha : 0).concat(alpha * Math.min(1, sum)) as RGBA;
  }
  throw new Error(`Unsupported palette color: ${value}`);
}
export function resolveColorMixes(value: string, tokens: Record<string, unknown>): string {
  return replaceColorMixes(value, expression => { const [r, g, b, a] = color(expression, tokens); return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(4))})`; });
}
