import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProjectFiles } from './check-discovery.mjs';

test('manifest discovery retains metadata without commands or endpoint versions', () => {
  const result = analyzeProjectFiles([{ path: 'package.json', source: JSON.stringify({ name: '@sample/app', scripts: { build: 'send SECRET', dev: 'https://secret.invalid' }, dependencies: { three: '^0.186.0', vite: '1' }, workspaces: ['apps/*', 42] }) }, { path: 'apps/a/package.json', source: '{"dependencies":{"three":"https://SECRET.invalid/a?token=SECRET"}}' }, { path: 'vite.config.ts', source: 'throw new Error("SECRET")' }]);
  assert.deepEqual(result.packages[0], { path: 'package.json', name: '@sample/app', scripts: ['build', 'dev'], dependencies: ['three', 'vite'], three: '^0.186.0', workspaces: ['apps/*'] });
  assert.equal(result.buildSystems.length, 2);
  assert.equal(result.packages[1].three, undefined);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('npm lockfiles report exact Three.js version candidates without package metadata', () => {
  const lockV3 = { lockfileVersion: 3, packages: {
    '': { name: 'sample' }, 'node_modules/three': { link: true, resolved: 'packages/local three' },
    'packages/local three': { name: 'three', version: '0.186.1' },
    'apps/my game/node_modules/three': { version: '0.185.0' },
    'node_modules/vite': { version: '7.0.0', resolved: 'https://user:SECRET@example.test/vite.tgz?token=SECRET' },
    'node_modules/alias/node_modules/three': { name: 'other-package', version: '1.2.3' },
    'https://user:SECRET@example.test/node_modules/three': { version: '0.183.0' },
  } };
  const lockV1 = { lockfileVersion: 1, dependencies: { vite: { version: '7.0.0', dependencies: { three: { version: '0.184.0' } } } } };
  const result = analyzeProjectFiles([
    { path: 'package-lock.json', source: JSON.stringify(lockV3) },
    { path: 'apps/game/npm-shrinkwrap.json', source: JSON.stringify(lockV1) },
  ]);
  assert.ok(result.uncertainties.some(row => row.code === 'npm-three-alias-omitted'));
  assert.ok(result.uncertainties.some(row => row.code === 'npm-three-path-omitted'));
  assert.deepEqual(result.dependencyResolutions.map(({ lockfile, packagePath, name, version, evidence }) => ({ lockfile, packagePath, name, version, evidence })), [
    { lockfile: 'package-lock.json', packagePath: 'node_modules/three', name: 'three', version: '0.186.1', evidence: 'Version recorded in an npm lockfile; installation and runtime use are unverified.' },
    { lockfile: 'package-lock.json', packagePath: 'apps/my game/node_modules/three', name: 'three', version: '0.185.0', evidence: 'Version recorded in an npm lockfile; installation and runtime use are unverified.' },
    { lockfile: 'apps/game/npm-shrinkwrap.json', packagePath: 'node_modules/vite/node_modules/three', name: 'three', version: '0.184.0', evidence: 'Version recorded in an npm lockfile; installation and runtime use are unverified.' },
  ]);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(!JSON.stringify(result).includes('resolved'));
});

test('invalid npm lockfiles and unreportable Three.js versions are explicit and source-free', () => {
  const result = analyzeProjectFiles([
    { path: 'package-lock.json', source: '{"SECRET' },
    { path: 'npm-shrinkwrap.json', source: JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/three': { version: 'file:../SECRET' } } }) },
    { path: 'apps/game/package-lock.json', source: JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/three': { link: true, resolved: '../../SECRET' } } }) },
  ]);
  assert.ok(result.uncertainties.some(row => row.code === 'invalid-lockfile'));
  assert.ok(result.uncertainties.some(row => row.code === 'npm-three-resolution-omitted'));
  assert.ok(result.uncertainties.some(row => row.code === 'npm-three-link-omitted'));
  assert.deepEqual(result.dependencyResolutions, []);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('invalid manifests produce located errors without input excerpts', () => {
  const result = analyzeProjectFiles([{ path: 'package.json', source: '{"SECRET' }, { path: 'nested/package.json', source: 'null' }]);
  assert.equal(result.uncertainties.length, 2);
  assert.deepEqual(result.uncertainties[0].location, { path: 'package.json', line: 1, column: 1 });
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('HTML module, classic and inline scripts retain original positions and sanitize references', () => {
  const result = analyzeProjectFiles([{ path: 'index.html', source: '<!doctype html>\n<script type="module" src="https://user:SECRET@example.com/main.js?token=SECRET#SECRET"></script>\n<script src="old.js?v=SECRET"></script>\n<script>\nconst value = 1;\n</script>\n<canvas></canvas><img src="data:text/plain,SECRET"><link href="style.css?SECRET">' }]);
  assert.deepEqual(result.entryPages[0].scripts, [
    { kind: 'module', src: 'https://example.com/main.js', line: 2, column: 1 },
    { kind: 'classic', src: 'old.js', line: 3, column: 1 },
    { kind: 'inline', source: '\nconst value = 1;\n', line: 4, column: 9 },
  ]);
  assert.ok(result.requirements.some(row => row.feature === 'ui.dom'));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('CSS AST extracts imports and URLs without matching comments', () => {
  const result = analyzeProjectFiles([{ path: 'app.css', source: '/* url(SECRET) */\n@import "base.css?SECRET";\n.a { background:url(https://user:SECRET@example.com/img.png?SECRET); }' }]);
  assert.deepEqual(result.resources.map(row => row.url), ['base.css', 'https://example.com/img.png']);
  assert.equal(result.resources[0].location.line, 2);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(result.requirements[0].feature, 'ui.css');
});

test('HTML recovery reports generic located uncertainties and still discovers resources', () => {
  const result = analyzeProjectFiles([{ path: 'broken.html', source: '<!doctype html><img src="one.png" src="SECRET"><script type="module" src="./main.js"></script>' }]);
  assert.ok(result.uncertainties.some(row => row.code === 'html-parse-recovery' && row.location.line === 1));
  assert.equal(result.entryPages[0].scripts[0].src, './main.js');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('backslash authority spellings cannot expose credentials in HTML or CSS', () => {
  for (const prefix of ['\\\\', '/\\']) {
    const url = `${prefix}user:SECRET@example.test/main.js`;
    const escapedCss = url.replaceAll('\\', '\\\\');
    const result = analyzeProjectFiles([
      { path: 'index.html', source: `<!doctype html><script src="${url}"></script>` },
      { path: 'app.css', source: `a {background:url("${escapedCss}")}` },
    ]);
    assert.equal(result.resources.length, 2);
    assert.ok(result.resources.every(row => row.url === undefined && row.dynamic));
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('inline CSS discovery locates stylesheet bodies and explicitly bounds decoded attributes and HTML gaps', () => {
  const result = analyzeProjectFiles([{ path: 'index.html', source: '<!doctype html>\n<style>@import "base.css";\na{background:url(image.png?SECRET)}</style>\n<div style="background:url(&quot;attr.png?SECRET&quot;)" onclick="SECRET()"></div>\n<img srcset="SECRET 1x">\n<script type="importmap">{"imports":{"SECRET":"SECRET"}}</script>' }]);
  assert.equal(result.requirements.filter(row => row.feature === 'ui.css').length, 2);
  assert.deepEqual(result.resources.map(row => [row.url, row.location.line, row.location.column]), [
    ['base.css', 2, 16], ['image.png', 3, 14], ['attr.png', 4, 6],
  ]);
  for (const code of ['style-attribute-location', 'inline-handler-unresolved', 'srcset-unresolved', 'import-map-unresolved']) {
    assert.ok(result.uncertainties.some(row => row.code === code), code);
  }
  assert.equal(result.entryPages[0].scripts.length, 0);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('script colons and BOM manifests are retained; omitted metadata is explicit', () => {
  const result = analyzeProjectFiles([{ path: 'package.json', source: '\uFEFF' + JSON.stringify({
    scripts: { 'build:prod': 'SECRET', 'test:unit': 'SECRET', ['x\nSECRET']: 'SECRET' },
    workspaces: ['apps/*', 'apps with spaces/*', 42, 'https://SECRET.invalid'],
  }) }]);
  assert.deepEqual(result.packages[0].scripts, ['build:prod', 'test:unit']);
  assert.deepEqual(result.packages[0].workspaces, ['apps/*', 'apps with spaces/*']);
  assert.ok(result.uncertainties.some(row => row.code === 'script-names-omitted'));
  assert.ok(result.uncertainties.some(row => row.code === 'workspace-entries-omitted'));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('deep HTML stops with explicit incomplete coverage without recursive traversal failure', () => {
  const result = analyzeProjectFiles([{ path: 'deep.html', source: '<!doctype html>' + '<div>'.repeat(1000) + '<script src="deep.js"></script>' }]);
  assert.ok(result.uncertainties.some(row => row.code === 'ANALYSIS_INCOMPLETE' && /depth/.test(row.message)));
  assert.equal(result.entryPages[0].scripts.length, 0);
});

test('many HTML findings are capped with explicit incomplete coverage', () => {
  const result = analyzeProjectFiles([{ path: 'wide.html', source: '<!doctype html>' + '<img src="a.png">'.repeat(22000) }]);
  assert.ok(result.resources.length <= 10000);
  assert.ok(result.uncertainties.some(row => row.code === 'ANALYSIS_INCOMPLETE'));
});
