import fs from 'node:fs';
import { parse } from '@babel/parser';

const flatten = (value, prefix = '', result = {}) => {
  for (const [key, item] of Object.entries(value)) {
    if (key === 'meta' || key === 'legacy') continue;
    if (typeof item === 'string') result[prefix + key] = item;
    else if (item && typeof item === 'object') flatten(item, prefix + key + '.', result);
  }
  return result;
};
const parameters = text => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort().join(',');
const english = flatten(JSON.parse(fs.readFileSync('resources/languages/en-US.json', 'utf8')));
const issues = [];
const template = flatten(JSON.parse(fs.readFileSync('resources/language-template.json', 'utf8')));
for (const [key, text] of Object.entries(english)) if (template[key] !== text) issues.push(`template: outdated ${key}`);
for (const code of ['ru-RU', 'de-DE']) {
  const values = flatten(JSON.parse(fs.readFileSync(`resources/languages/${code}.json`, 'utf8')));
  for (const [key, value] of Object.entries(english)) {
    if (!(key in values)) issues.push(`${code}: missing ${key}`);
    else if (parameters(value) !== parameters(values[key])) issues.push(`${code}: mismatched placeholders in ${key}`);
  }
}
const exceptions = JSON.parse(fs.readFileSync('scripts/ui-audit-exceptions.json', 'utf8'));
for (const name of fs.readdirSync('src', { recursive: true })) {
  if (name.includes('.test.') || name.startsWith('vendor')) continue;
  if (!name.endsWith('.tsx') && !name.endsWith('.ts') && !name.endsWith('.css')) continue;
  const file = 'src/' + name.replaceAll('\\', '/');
  const source = fs.readFileSync(file, 'utf8');
  if (!exceptions.colorFiles.includes(file)) {
    for (const match of source.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)) issues.push(`${file}: fixed color ${match[0]}`);
  }
  if (!name.endsWith('.tsx')) continue;
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  function walk(node) {
    if (!node || typeof node !== 'object' || !node.type) return;
    if (node.type === 'JSXText' && /[A-Za-zА-Яа-я]/.test(node.value) && !exceptions.text.includes(node.value.trim())) issues.push(`${file}:${node.loc.start.line}: raw UI text ${node.value.trim()}`);
    if (node.type === 'JSXAttribute' && ['title', 'description', 'aria-label', 'placeholder', 'alt', 'label'].includes(node.name.name) && node.value?.type === 'StringLiteral' && /[A-Za-zА-Яа-я]/.test(node.value.value)) issues.push(`${file}:${node.loc.start.line}: raw ${node.name.name}`);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['uiText', 't'].includes(node.callee.name) && node.arguments[0]?.type === 'StringLiteral') {
      const key = node.arguments[0].value;
      if (!english[key] && !Object.keys(english).some(item => item.startsWith(key + '.'))) issues.push(`${file}:${node.loc.start.line}: unknown translation ${key}`);
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value?.type) walk(value);
  }
  walk(ast.program);
}
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`UI audit passed: ${Object.keys(english).length} catalog values, matching parameters, no raw JSX copy or fixed surface colors.`);

const markdownDependency = fs.readFileSync('node_modules/mdast-util-gfm-autolink-literal/lib/index.js', 'utf8');
if (markdownDependency.includes('(?<=')) throw Error('Markdown must parse in Monterey WebKit');
if (fs.existsSync('dist/assets')) for (const file of fs.readdirSync('dist/assets').filter(name => name.endsWith('.js'))) {
  if (/\(\?<([=!])/.test(fs.readFileSync(`dist/assets/${file}`, 'utf8'))) throw Error(`Unsupported lookbehind in ${file}`);
}
