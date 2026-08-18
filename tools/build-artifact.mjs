/**
 * Strips ai4food-app.html down to what a page host that supplies its own
 * document wrapper will accept: no <!doctype>, <html> or <body> of our own,
 * just the title, the font links, the stylesheet and the body content.
 *
 *   node tools/build-artifact.mjs [out.html]
 *
 * The result is a build output, not a source file — it is gitignored, and the
 * app itself stays the single source of truth.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../ai4food-app.html', import.meta.url), 'utf8');
const out = process.argv[2] ?? new URL('../ai4food-artifact.html', import.meta.url).pathname;

const head = src.slice(src.indexOf('<head>') + 6, src.indexOf('</head>'));
const body = src.slice(src.indexOf('<body>') + 6, src.lastIndexOf('</body>'));

const fonts = head.match(/<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>/g) ?? [];
const style = head.slice(head.indexOf('<style>'), head.lastIndexOf('</style>') + 8);

// The charset belongs first: the app is written in French and a host that
// serves it without a charset would otherwise mangle every accent.
const page = [
  '<meta charset="utf-8">',
  '<title>AI4Food</title>',
  ...fonts,
  style,
  body.trim(),
  '',
].join('\n');

writeFileSync(out, page);
console.log(`${out} — ${(page.length / 1024).toFixed(0)} KB`);
