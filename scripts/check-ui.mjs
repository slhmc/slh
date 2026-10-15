import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
const base = JSON.parse(readFileSync('resources/languages/en-US.json', 'utf8')).updater;
for (const locale of ['en-US', 'ru-RU', 'de-DE']) {
  const values = JSON.parse(readFileSync(`resources/languages/${locale}.json`, 'utf8')).updater;
  assert.deepEqual(Object.keys(values).sort(), Object.keys(base).sort());
  for (const [key, value] of Object.entries(values)) {
    assert.equal(typeof value, 'string'); assert.ok(value.trim());
    assert.deepEqual(value.match(/\{\w+\}/g) ?? [], base[key].match(/\{\w+\}/g) ?? []);
  }
}
const markdown = readFileSync('node_modules/mdast-util-gfm-autolink-literal/lib/index.js', 'utf8');
assert.ok(!markdown.includes('(?<='), 'Markdown must parse in Monterey WebKit');
for (const file of readdirSync('dist/assets').filter(name => name.endsWith('.js'))) {
  assert.ok(!/\(\?<([=!])/.test(readFileSync(`dist/assets/${file}`, 'utf8')), `Unsupported lookbehind in ${file}`);
}
console.log('UI translations and Monterey JavaScript compatibility checks passed.');
