// Builds the presentation (presentation/ at the repository root) as one self-contained HTML file to share, for
// example in Teams: the stylesheets and scripts are inlined, the favicon is a data URI, and every image in
// assets/icons and assets/img is embedded. The figure scripts build their markup with paths such as
// "assets/icons/fabric.svg"; a small script at the top of the page turns each one into a blob URL of the embedded file
// as the markup is inserted (innerHTML, outerHTML, insertAdjacentHTML, setAttribute). It opens from disk (file://) in
// Edge or Chrome with no network.
//   node scripts/standalone.mjs [output.html]     default: standalone/Fabric-Rayfin-research.html
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(app, '..', '..', 'presentation');
const out = resolve(process.argv[2] || join(app, 'standalone', 'Fabric-Rayfin-research.html'));

const TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
const read = (path) => readFileSync(join(site, path));
const text = (path) => read(path).toString('utf8');

// Every image the scripts can name, keyed by the path they use
const files = {};
for (const dir of ['assets/icons', 'assets/img']) {
  for (const name of readdirSync(join(site, dir)).sort()) {
    const type = TYPES[extname(name).toLowerCase()];
    if (type && statSync(join(site, dir, name)).isFile()) files[`${dir}/${name}`] = [type, read(`${dir}/${name}`).toString('base64')];
  }
}

const shim = `(function () {
  'use strict';
  var FILES = ${JSON.stringify(files)};
  var urls = Object.create(null);
  function url(path) {
    if (urls[path]) return urls[path];
    var f = FILES[path], bin = atob(f[1]), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return (urls[path] = URL.createObjectURL(new Blob([bytes], { type: f[0] })));
  }
  var RE = /assets\\/(?:icons|img)\\/[\\w.-]+/g;
  function fix(s) {
    s = String(s);
    return s.indexOf('assets/') < 0 ? s : s.replace(RE, function (p) { return FILES[p] ? url(p) : p; });
  }
  function wrap(prop) {
    var d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    Object.defineProperty(Element.prototype, prop, { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, fix(v)); } });
  }
  wrap('innerHTML');
  wrap('outerHTML');
  var insert = Element.prototype.insertAdjacentHTML, setAttr = Element.prototype.setAttribute;
  Element.prototype.insertAdjacentHTML = function (where, html) { return insert.call(this, where, fix(html)); };
  Element.prototype.setAttribute = function (name, value) { return setAttr.call(this, name, /^(src|href|style)$/.test(name) ? fix(value) : value); };
})();`;

const script = (js) => `<script>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`;
const style = (css) => `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`;

let html = text('index.html');
const swaps = [
  [/<script src="(assets\/js\/[^"]+)"><\/script>/g, (m, p) => script(text(p))],
  [/<link rel="stylesheet" href="(assets\/[^"]+\.css)" \/>/g, (m, p) => style(text(p))],
  [/<link rel="icon" type="image\/svg\+xml" href="(assets\/[^"]+)" \/>/g, (m, p) => `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${read(p).toString('base64')}" />`],
];
for (const [re, fn] of swaps) html = html.replace(re, (...a) => {
  if (!existsSync(join(site, a[1]))) throw new Error(`index.html references missing file ${a[1]}`);
  return fn(...a);
});
// The shim goes first, before any script that builds markup
html = html.replace('<head>', `<head>\n${script(shim)}`);

const left = html.match(/\b(?:src|href)="assets\/[^"]*"/g);
if (left) throw new Error(`Not inlined: ${left.join(', ')}`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`Wrote ${relative(process.cwd(), out)} (${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB, ${Object.keys(files).length} images embedded)`);
