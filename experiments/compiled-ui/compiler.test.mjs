import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, link, symlink, truncate, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { defaultTreeAdapter as adapter, parse, serialize } from 'parse5';
import { compileHtml, LIMITS } from './compiler.mjs';

// Reconstruct with the maintained tree adapter, independently of the compiler.
// Equality checks parser state as well as HTML serialization, which alone loses
// document mode and can conceal differences in attribute namespace identity.
function reconstruct(ir) {
  const live = ir.nodes.map(node => {
    switch (node.kind) {
      case 'document': return adapter.createDocument();
      case 'fragment': return adapter.createDocumentFragment();
      case 'element': return adapter.createElement(node.name, node.namespace, node.attributes.map(attr => ({
        name: attr.name, value: attr.value,
        ...(attr.namespace === null ? {} : { namespace: attr.namespace }),
        ...(attr.prefix === null ? {} : { prefix: attr.prefix }),
      })));
      case 'text': return adapter.createTextNode(node.value);
      case 'comment': return adapter.createCommentNode(node.value);
      case 'doctype': {
        const holder = adapter.createDocument();
        adapter.setDocumentType(holder, node.name, node.publicId, node.systemId);
        return holder.childNodes[0];
      }
      default: assert.fail(`Unexpected kind ${node.kind}`);
    }
  });
  ir.nodes.forEach((node, index) => {
    for (const child of node.children ?? []) adapter.appendChild(live[index], live[child]);
    if (node.templateContents !== undefined) adapter.setTemplateContent(live[index], live[node.templateContents]);
  });
  adapter.setDocumentMode(live[0], ir.document.mode);
  return live[0];
}

const observable = document => JSON.parse(JSON.stringify(document, (key, value) =>
  key === 'parentNode' || key === 'sourceCodeLocation' ? undefined : value));

for (const [name, html] of Object.entries({
  plain: '<!doctype html><!--before--><html lang="fr"><title>T &amp; Q</title><body>🙂<canvas id="anything"></canvas><button>Go</button><!--after-->',
  malformed: '<!doctype html><table>before<tr><td>A&amp;B</table><p><b>one<i>two</b>three</i><div ID="first" id="second">a\0b',
  foreign: '<!doctype html><svg viewBox="0 0 4 4"><use xlink:href="#x" xml:lang="fr" xmlns:xlink="http://www.w3.org/1999/xlink"/><foreignObject><P>x</P></foreignObject></svg><math><mi>x</mi></math>',
  rawText: '<!doctype html><style>p::after{content:"<x>"}</style><script>window.x="<div>";</script><noscript><p>fallback</p></noscript><textarea>\n&lt;b&gt;</textarea>',
  templates: '<!doctype html><template id="outer">before<template><table><tr><td>nested</table></template><!--inert--></template><svg><template>foreign</template></svg>',
  quirks: '<p>no doctype',
  limitedQuirks: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><p>limited',
  empty: '',
})) {
  test(`${name}: JSON round trip preserves actual parse5 observable structure`, () => {
    const errors = [];
    const parsed = parse(html, { scriptingEnabled: false, onParseError: error => errors.push(error), sourceCodeLocationInfo: true });
    const ir = JSON.parse(JSON.stringify(compileHtml(html)));
    const restored = reconstruct(ir);
    assert.deepEqual(observable(restored), observable(parsed));
    assert.equal(serialize(restored), serialize(parsed));
    assert.deepEqual(ir.diagnostics, errors);
    assert.equal(ir.document.mode, parsed.mode);
    assert.equal(ir.document.scriptingEnabled, false);
    assert.equal(ir.diagnosticsTotal, errors.length);
    assert.equal(ir.diagnosticsTruncated, false);
    const parsedNodes = [];
    function visit(node) {
      parsedNodes.push(node);
      for (const child of node.childNodes ?? []) visit(child);
      if (node.content) visit(node.content);
    }
    visit(parsed);
    assert.equal(ir.nodes.length, parsedNodes.length);
    for (const [index, node] of ir.nodes.entries()) {
      assert.deepEqual(node.source, parsedNodes[index].sourceCodeLocation ? JSON.parse(JSON.stringify(parsedNodes[index].sourceCodeLocation)) : null);
      const references = [...(node.children ?? []), ...(node.templateContents === undefined ? [] : [node.templateContents])];
      for (const child of references) {
        assert.ok(child > index && child < ir.nodes.length, `Node ${index} must reference a later node`);
      }
    }
  });
}

test('provenance retains UTF-16 ranges, normalized attributes and implied locations', () => {
  const html = '<!doctype html>\r\n<p TITLE="🙂 &amp;">é</p>';
  const ir = compileHtml(html, { sourceName: 'fixtures/source.html' });
  assert.deepEqual(ir.source, { name: 'fixtures/source.html', sha256: createHash('sha256').update(html).digest('hex'), byteLength: Buffer.byteLength(html) });
  const p = ir.nodes.find(node => node.name === 'p');
  assert.equal(html.slice(p.source.startOffset, p.source.endOffset), '<p TITLE="🙂 &amp;">é</p>');
  assert.equal(html.slice(p.source.attrs.title.startOffset, p.source.attrs.title.endOffset), 'TITLE="🙂 &amp;"');
  assert.equal(p.attributes[0].value, '🙂 &');
  assert.equal(p.source.startLine, 2);
  assert.equal(ir.nodes.find(node => node.name === 'body').source, null);
});

test('fragment ownership is separate from template element children', () => {
  const ir = compileHtml('<!doctype html><template><template>x</template></template>');
  const templates = ir.nodes.filter(node => node.name === 'template');
  assert.equal(templates.length, 2);
  for (const template of templates) {
    assert.deepEqual(template.children, []);
    assert.equal(ir.nodes[template.templateContents].kind, 'fragment');
    assert.equal(template.templateContents, ir.nodes.indexOf(template) + 1);
  }
});

test('all limits fail explicitly and cannot be increased or disabled', () => {
  for (const [html, limits, code] of [
    ['🙂', { inputBytes: 3 }, 'INPUT_LIMIT'],
    ['<!doctype html><div><span>x</span></div>', { depth: 3 }, 'DEPTH_LIMIT'],
    ['<!doctype html><p>x', { nodes: 5 }, 'NODE_LIMIT'],
    ['<!doctype html><p>' + 'x'.repeat(70), { stringBytes: 64 }, 'STRING_LIMIT'],
    ['<!doctype html><div data-x="' + 'x'.repeat(70) + '">', { stringBytes: 64 }, 'STRING_LIMIT'],
    ['<!doctype html><!--' + 'x'.repeat(70) + '-->', { stringBytes: 64 }, 'STRING_LIMIT'],
    ['<!doctype html><template><div>x</div></template>', { depth: 4 }, 'DEPTH_LIMIT'],
    ['<!doctype html><p a=1 b=2>', { attributes: 1 }, 'ATTRIBUTE_LIMIT'],
    ['<!doctype html><p a=1><p b=2>', { attributes: 1 }, 'ATTRIBUTE_LIMIT'],
    ['<!doctype html>', { outputBytes: 100 }, 'OUTPUT_LIMIT'],
  ]) assert.throws(() => compileHtml(html, { limits }), { code });
  for (const limits of [{ nodes: 0 }, { depth: 1.5 }, { inputBytes: Infinity }, { nodes: LIMITS.nodes + 1 }, { bogus: 2 }, [], null]) {
    assert.throws(() => compileHtml('', { limits }), { code: 'INVALID_LIMIT' });
  }
  assert.throws(() => compileHtml(Buffer.from('x')), { code: 'INVALID_INPUT' });
  assert.throws(() => compileHtml('', { sourceName: null }), { code: 'INVALID_INPUT' });
});

test('recoverable diagnostics are truncated without rejecting normalized markup', () => {
  const html = '<!doctype html><p a=1 a=2 b=1 b=2 c=1 c=2>ok';
  const errors = [];
  const parsed = parse(html, { scriptingEnabled: false, onParseError: error => errors.push(error) });
  const ir = compileHtml(html, { limits: { diagnostics: 1 } });
  assert.deepEqual(observable(reconstruct(ir)), observable(parsed));
  assert.deepEqual(ir.diagnostics, errors.slice(0, 1));
  assert.equal(ir.diagnosticsTotal, errors.length);
  assert.equal(ir.diagnosticsTruncated, true);
});

test('BOM is ignored by parsing while hashes and source ranges refer to original input', () => {
  const html = '\ufeff<!doctype html><p A="🙂">first</p>\n<p>second</p>';
  const ir = compileHtml(html);
  assert.equal(ir.document.mode, 'no-quirks');
  assert.deepEqual(ir.diagnostics, []);
  assert.equal(ir.source.sha256, createHash('sha256').update(html).digest('hex'));
  assert.equal(ir.source.byteLength, Buffer.byteLength(html));
  assert.equal(ir.nodes[1].source.startOffset, 1);
  assert.equal(ir.nodes[1].source.startCol, 2);
  const paragraphs = ir.nodes.filter(node => node.name === 'p');
  for (const node of paragraphs) {
    assert.ok(html.slice(node.source.startOffset, node.source.endOffset).startsWith('<p'));
  }
  assert.equal(html.slice(paragraphs[0].source.attrs.a.startOffset, paragraphs[0].source.attrs.a.endOffset), 'A="🙂"');
  assert.equal(paragraphs[1].source.startCol, 1);
  const malformed = compileHtml('\ufeff<!doctype html><p a=1 a=2>');
  const duplicate = malformed.diagnostics.find(item => item.code === 'duplicate-attribute');
  const ordinary = compileHtml('<!doctype html><p a=1 a=2>').diagnostics.find(item => item.code === 'duplicate-attribute');
  assert.equal(duplicate.startOffset, ordinary.startOffset + 1);
  assert.equal(duplicate.startCol, ordinary.startCol + 1);
});

test('attributes merged onto an implied body have optional source locations', () => {
  const html = '<!doctype html><p>x<body data-merged="yes">';
  const ir = compileHtml(html);
  const body = ir.nodes.find(node => node.name === 'body');
  assert.equal(body.source, null);
  assert.equal(body.attributes.find(attr => attr.name === 'data-merged').value, 'yes');
  assert.deepEqual(observable(reconstruct(ir)), observable(parse(html, { scriptingEnabled: false })));
});

test('unpaired UTF-16 input is rejected without changing valid non-BMP characters', () => {
  for (const surrogate of ['\ud800', '\udfff', 'before\ud800after', '\udfff\ud800']) {
    assert.throws(() => compileHtml(`<!doctype html><p>${surrogate}`), { code: 'INVALID_UNICODE' });
    assert.throws(() => compileHtml('<!doctype html>', { sourceName: surrogate }), { code: 'INVALID_UNICODE' });
  }
  const ir = compileHtml('<!doctype html><p>🙂𝄞', { sourceName: '🙂.html' });
  assert.equal(ir.nodes.find(node => node.kind === 'text').value, '🙂𝄞');
  assert.equal(ir.source.name, '🙂.html');
});

test('CLI writes deterministic data and never overwrites source or existing output', async t => {
  const dir = await mkdtemp(join(tmpdir(), '3jsn compiled ui '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'unchanged.html');
  const output = join(dir, 'tree.json');
  const html = '<!doctype html><main><canvas></canvas><p>Original source</p></main>';
  await writeFile(input, html);
  const compiler = fileURLToPath(new URL('./compiler.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [compiler, ...args], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run(input, output).status, 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), compileHtml(html, { sourceName: input }));
  assert.match(run(input, output).stderr, /EEXIST/);
  assert.match(run(input, input).stderr, /OUTPUT_IS_SOURCE/);
  const alias = join(dir, 'source-link.html');
  await link(input, alias);
  assert.match(run(input, alias).stderr, /EEXIST/);
  assert.equal(await readFile(input, 'utf8'), html);
  await writeFile(join(dir, 'bad.html'), Buffer.from([0xff]));
  assert.match(run(join(dir, 'bad.html'), join(dir, 'bad.json')).stderr, /INVALID_ENCODING/);
  const oversized = join(dir, 'large.html');
  await writeFile(oversized, '');
  await truncate(oversized, LIMITS.inputBytes + 1);
  assert.match(run(oversized, join(dir, 'large.json')).stderr, /INPUT_LIMIT/);
  await assert.rejects(access(join(dir, 'large.json')), { code: 'ENOENT' });
  assert.match(run(dir, join(dir, 'directory.json')).stderr, /INVALID_INPUT_FILE/);
  const bomInput = join(dir, 'bom.html');
  await writeFile(bomInput, '\ufeff' + html);
  assert.equal(run(bomInput, join(dir, 'bom.json')).status, 0);
  const bom = JSON.parse(await readFile(join(dir, 'bom.json'), 'utf8'));
  assert.equal(bom.document.mode, 'no-quirks');
  assert.equal(bom.source.sha256, createHash('sha256').update(await readFile(bomInput)).digest('hex'));
  if (process.platform !== 'win32') {
    const compilerLink = join(dir, 'compiler link.mjs');
    await symlink(compiler, compilerLink);
    const result = spawnSync(process.execPath, [compilerLink, input, join(dir, 'linked.json')], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'linked.json'), 'utf8')), compileHtml(html, { sourceName: input }));
    const sourceLink = join(dir, 'source symlink.html');
    await symlink(input, sourceLink);
    assert.match(run(input, sourceLink).stderr, /EEXIST/);
  }
});
