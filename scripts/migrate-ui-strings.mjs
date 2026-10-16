// One-time migration helper. Edits offsets to preserve the project's formatting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '@babel/parser';

throw new Error('This migration has already been applied. Use check:ui to check new interface text.');

const codes = ['en-US', 'ru-RU', 'de-DE'];
const bundles = Object.fromEntries(codes.map(code => [code, JSON.parse(fs.readFileSync(`resources/languages/${code}.json`, 'utf8'))]));
const mapping = JSON.parse(fs.readFileSync('src/i18n/sources.json', 'utf8'));
const flatten = (obj, prefix = '', out = {}) => {
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'legacy' || key === 'meta') continue;
    if (typeof value === 'string') out[value] ??= prefix + key;
    else if (value && typeof value === 'object') flatten(value, prefix + key + '.', out);
  }
  return out;
};
Object.assign(mapping, flatten(bundles['en-US']), mapping);
const put = (tree, key, value) => {
  const parts = key.split('.');
  for (const part of parts.slice(0, -1)) tree = tree[part] ??= {};
  tree[parts.at(-1)] ??= value;
};
const words = source => source.replace(/\{[^}]+\}/g, '').match(/[a-zA-Z0-9]+/g) ?? ['message'];
function register(source, section) {
  if (!mapping[source]) {
    const parts = words(source).slice(0, 9);
    let leaf = parts[0].toLowerCase() + parts.slice(1).map(p => p[0].toUpperCase() + p.slice(1).toLowerCase()).join('');
    let key = `${section}.texts.${leaf}`;
    if (Object.values(mapping).includes(key)) key += crypto.createHash('sha256').update(source).digest('hex').slice(0, 6);
    mapping[source] = key;
  }
  const key = mapping[source];
  for (const code of codes) put(bundles[code], key, code === 'en-US' ? source : bundles[code].legacy?.[source] ?? source);
  return key;
}
const files = fs.readdirSync('src', { recursive: true }).filter(name => name.endsWith('.tsx') && !name.includes('.test.') && !name.startsWith('vendor') && !name.startsWith('i18n'));
const attrs = new Set(['title', 'description', 'placeholder', 'aria-label', 'alt', 'label']);
for (const name of files) {
  const file = path.join('src', name);
  const source = fs.readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const section = name.includes('routes') ? name.split(/[\\/]/)[1].toLowerCase() : name.includes('instance') ? 'installation' : name.includes('account') ? 'accounts' : name.includes('shell') ? 'shell' : 'common';
  const edits = [];
  const owners = new Set();
  function walk(node, parents = []) {
    if (!node || typeof node !== 'object' || !node.type) return;
    const owner = [...parents].reverse().find(p => p.type === 'FunctionDeclaration' && /^[A-Z]|^use[A-Z]/.test(p.id?.name ?? '') && p.body?.type === 'BlockStatement'
      || p.type === 'ArrowFunctionExpression' && p.body?.type === 'BlockStatement' && parents.find(v => v.type === 'VariableDeclarator' && v.init === p && /^[A-Z]|^use[A-Z]/.test(v.id?.name ?? '')));
    const textCall = (text, params) => `uiText(${JSON.stringify(register(text, section))}, ${JSON.stringify(text)}${params ? ', ' + params : ''})`;
    if (owner && node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'tr' && node.arguments[0]?.type === 'StringLiteral') {
      owners.add(owner);
      edits.push({ start: node.start, end: node.end, value: textCall(node.arguments[0].value, node.arguments[1] ? source.slice(node.arguments[1].start, node.arguments[1].end) : null) });
      return;
    }
    if (owner && node.type === 'JSXText' && /[A-Za-z]/.test(node.value)) {
      const text = node.value.replace(/\s+/g, ' ').trim();
      owners.add(owner);
      const before = !node.value.includes('\n') && /^\s/.test(node.value) ? '{" "}' : '';
      const after = !node.value.includes('\n') && /\s$/.test(node.value) ? '{" "}' : '';
      edits.push({ start: node.start, end: node.end, value: before + '{' + textCall(text) + '}' + after });
      return;
    }
    if (owner && node.type === 'JSXAttribute' && attrs.has(node.name.name) && node.value?.type === 'StringLiteral' && /[A-Za-z]/.test(node.value.value)) {
      owners.add(owner);
      edits.push({ start: node.value.start, end: node.value.end, value: '{' + textCall(node.value.value) + '}' });
      return;
    }
    // Visible string literals in expressions, including conditional labels.
    if (owner && node.type === 'StringLiteral' && parents.some(p => p.type === 'JSXExpressionContainer') && /[A-Za-z]/.test(node.value) && bundles['en-US'].legacy?.[node.value]
      && !parents.some(p => p.type === 'JSXAttribute' && !attrs.has(p.name.name))
      && !['ObjectProperty', 'CallExpression', 'BinaryExpression', 'MemberExpression'].includes(parents.at(-1)?.type)) {
      owners.add(owner);
      edits.push({ start: node.start, end: node.end, value: textCall(node.value) });
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, [...parents, node]));
      else if (value?.type) walk(value, [...parents, node]);
    }
  }
  walk(ast.program);
  for (const owner of owners) edits.push({ start: owner.body.start + 1, end: owner.body.start + 1, value: '\n  const uiText = useUiText();' });
  if (!edits.length) continue;
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  const rel = path.relative(path.dirname(file), 'src/i18n/UiText').replaceAll('\\', '/');
  if (!source.includes('useUiText }')) result = `import { useUiText } from "${rel.startsWith('.') ? rel : './' + rel}";\n` + result;
  fs.writeFileSync(file, result);
}
for (const source of Object.keys(bundles['en-US'].legacy)) register(source, 'common');
for (const code of codes) fs.writeFileSync(`resources/languages/${code}.json`, JSON.stringify(bundles[code], null, 2) + '\n');
fs.writeFileSync('src/i18n/sources.json', JSON.stringify(mapping, null, 2) + '\n');
console.log(`Registered ${Object.keys(mapping).length} source strings; React renders every migrated translation.`);
