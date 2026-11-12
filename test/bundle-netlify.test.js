'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('esbuild puede bundlear la función de Netlify dejando @libsql/client externo (web-push entra al bundle)', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-esbuild-'));
  const outfile = path.join(outDir, 'app.js');
  // Preferí el esbuild del tree si está; si no, npx (sin agregar dependencia).
  const r = spawnSync('npx', ['--yes', 'esbuild', 'netlify/functions/app.js', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`, '--external:@libsql/client', '--log-level=warning'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 120000,
  });
  try {
    assert.equal(r.status, 0, (r.stderr || r.stdout || 'esbuild falló').slice(0, 2000));
    assert.ok(fs.existsSync(outfile));
    const js = fs.readFileSync(outfile, 'utf8');
    assert.match(js, /require\(["']@libsql\/client["']\)/, '@libsql/client debe quedar como require externo');
    assert.match(js, /web-push|WebPushError|sendNotification/, 'web-push tiene que quedar dentro del bundle');
    assert.doesNotMatch(js, /require\(["']web-push["']\)/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
