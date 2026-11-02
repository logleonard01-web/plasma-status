/*
 * PlasmaStatus release build.
 * Scrambles your server-side .js and copies everything else into dist/.
 * config.yml here is the shipping base template, so it is included.
 *
 * Run with:  npm run build
 */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const options = require('./obfuscator.config.json');

// These get SCRAMBLED (every .js inside them).
const OBFUSCATE = ['index.js', 'discord-bot.js', 'license.js', 'settings.js', 'models'];

// These get COPIED as-is.
const COPY = [
  'views', 'public', 'config.yml', 'package.json', 'package-lock.json',
  '.dockerignore', 'Dockerfile', 'docker-compose.yml', 'README.md'
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

function obfuscateFile(srcAbs) {
  const rel = path.relative(ROOT, srcAbs);
  const code = fs.readFileSync(srcAbs, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
  const dest = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, result);
  console.log('  scrambled  ' + rel);
}

// Fresh dist/
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

console.log('\nScrambling your code...');
for (const item of OBFUSCATE) {
  const abs = path.join(ROOT, item);
  if (!fs.existsSync(abs)) { console.log('  (skip, not found) ' + item); continue; }
  if (fs.statSync(abs).isDirectory()) {
    for (const f of walk(abs)) if (f.endsWith('.js')) obfuscateFile(f);
  } else {
    obfuscateFile(abs);
  }
}

console.log('\nCopying the rest...');
for (const item of COPY) {
  const abs = path.join(ROOT, item);
  if (!fs.existsSync(abs)) { console.log('  (skip, not found) ' + item); continue; }
  fs.cpSync(abs, path.join(DIST, item), { recursive: true });
  console.log('  copied     ' + item);
}

console.log('\nDone. Your release is in the  dist/  folder.\n');
