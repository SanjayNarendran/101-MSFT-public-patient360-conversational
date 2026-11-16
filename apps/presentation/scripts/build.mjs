// Builds the Rayfin static site in dist/ from presentation/ at the repository root (index.html and assets/).
// Every script and stylesheet URL in index.html gets a content-hash query string, so browsers never mix cached and
// freshly deployed files. The icons are loaded by the figure scripts from assets/icons/ and keep their names.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(app, '..', '..', 'presentation');
const out = join(app, 'dist');

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(site, 'index.html'), join(out, 'index.html'));
cpSync(join(site, 'assets'), join(out, 'assets'), { recursive: true, filter: (p) => !/(^|\/)\.DS_Store$/.test(p) });

const hashOf = (path) => createHash('sha256').update(readFileSync(join(out, path))).digest('hex').slice(0, 10);
let versioned = 0;
const indexPath = join(out, 'index.html');
const html = readFileSync(indexPath, 'utf8').replace(/\b(src|href)="(assets\/[^"?#]+)"/g, (m, attr, path) => {
  if (!existsSync(join(out, path))) throw new Error(`index.html references missing file ${path}`);
  versioned += 1;
  return `${attr}="${path}?v=${hashOf(path)}"`;
});
writeFileSync(indexPath, html);

// Every icon the figure scripts name must be in the build
const icons = new Set();
readdirSync(join(out, 'assets', 'js')).forEach((n) => {
  const src = readFileSync(join(out, 'assets', 'js', n), 'utf8');
  for (const m of src.matchAll(/['`]([\w-]+\.(?:svg|png))['`]/g)) icons.add(m[1]);
});
const missing = [...icons].filter((f) => f !== 'favicon.svg' && !existsSync(join(out, 'assets', 'icons', f)));
if (missing.length) throw new Error(`Icons named in the scripts but missing: ${missing.join(', ')}`);

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(out);
const bytes = files.reduce((s, f) => s + statSync(f).size, 0);
console.log(`Built ${files.length} files (${(bytes / 1024).toFixed(0)} KB), ${versioned} asset URLs versioned → ${relative(app, out)}/`);
