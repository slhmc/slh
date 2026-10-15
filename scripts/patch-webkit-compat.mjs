import { readFileSync, writeFileSync } from "node:fs";
const file = new URL('../node_modules/mdast-util-gfm-autolink-literal/lib/index.js', import.meta.url);
const before = String.raw`/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`;
const after = String.raw`/([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`;
const source = readFileSync(file, 'utf8');
if (!source.includes('!previous(match, true)')) throw Error('Review Markdown email boundary validation before upgrading');
if (source.includes(before)) writeFileSync(file, source.replace(before, after));
else if (!source.includes(after)) throw Error('Review Markdown WebKit compatibility patch before upgrading');
