import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareHtml } from './html.mjs';
import { DOM_PROFILE, validateDescription, validateProfileTarget } from './contract.mjs';

const page = (extra = '', script = '<script type="module" src="./app.mjs"></script>') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Original fixture</title></head><body>${extra}<canvas id="scene"></canvas>${script}</body></html>`;
const prepare = (source, entry = 'ui/index.html') => prepareHtml(Buffer.from(source), entry);
const rejected = (source, code = /^(?:UNSUPPORTED_HTML|UNSUPPORTED_CSS)$/) =>
  assert.throws(() => prepare(source), error => code.test(error.code), source);

test('generated HTML preserves every byte except the src attribute, including emoji and CRLF', () => {
  for (const src of ['SRC=../code/app.ts', "src='../code/app.ts'", 'src="../code/app.ts"']) {
    const source = page('<!-- 😀 fake <script type=module src=bad.js> -->\r\n<p>Original &amp; unchanged</p>',
      `<script type=MODULE ${src}></script>`).replaceAll('><', '>\r\n<');
    const result = prepare(source);
    assert.equal(result.entry, 'code/app.ts');
    assert.equal(result.bytes.toString(), source.replace(src, 'src="./main.mjs"'));
    assert.equal(result.metadata.interpretation, 'interim-runtime-html-css');
  }
});

test('parser distinguishes raw text, comments, CSS strings and decoded source paths', () => {
  const source = page('<style>/* url(fake.png) */ p::before { content: "url(fake.png) <script>"; } p { background: linear-gradient(red, blue); color:var(--x, rgb(1,2,3)); --x:#123; }</style>',
    '<script type="module" src="./a&#112;p.mjs"></script>');
  assert.equal(prepare(source).entry, 'ui/app.mjs');
  assert.equal(prepare(page('<div style="color:rgb(1, 2, 3); --x:4px; width:calc(var(--x) + 2px)"></div>')).entry, 'ui/app.mjs');
});

test('requires ordinary UTF-8 HTML5 and rejects parser recovery or duplicate attributes', () => {
  for (const source of [page().replace('<!doctype html>', ''), page().replace('<!doctype html>', '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">'),
    page().replace('<!doctype html>', '<!DOCTYPE html><!-- XHTML in this comment triggers native XML sniffing -->'),
    page().replace('<html>', '<html xmlns="http://www.w3.org/1999/xhtml">'), '<?xml version="1.0"?>' + page(),
    page().replace('charset="utf-8"', 'charset="windows-1252"'),
    page().replace('src="./app.mjs"', 'src="./app.mjs" src="other.mjs"'),
    page().replace('type="module"', 'type="module" type="text/javascript"')]) rejected(source);
  assert.throws(() => prepareHtml(Buffer.from([0xff, 0xfe]), 'index.html'), { code: 'INVALID_HTML_ENCODING' });
  rejected('\ufeff' + page());
});

test('rejects inactive, foreign, inline and controlled scripts rather than selecting a different entry', () => {
  for (const extra of ['<template><script type="module" src="fake.mjs"></script></template>',
    '<noscript><script type="module" src="fake.mjs"></script></noscript>', '<svg></svg>', '<math></math>',
    '<script type="importmap">{}</script>', '<script src="classic.js"></script>', '<script type="module" src="extra.mjs"></script>']) rejected(page(extra));
  for (const script of ['', '<script type="module ">console.log(1)</script>', '<script type="module" src="app.mjs">console.log(1)</script>',
    '<script src="app.mjs"></script>', '<script type="module" src="app.mjs" async></script>',
    '<script type="module" src="app.mjs" integrity="sha256-x"></script>']) rejected(page('', script));
});

test('requires exactly one unique scene canvas without fallback markup', () => {
  for (const source of [page().replace('id="scene"', 'id="other"'), page().replace('<canvas id="scene"></canvas>', ''),
    page('<div id="scene"></div>'), page('<canvas id="second"></canvas>'),
    page().replace('<canvas id="scene"></canvas>', '<canvas id="scene"><p>Fallback</p></canvas>')]) rejected(source);
});

test('rejects URL interpretation, escaping module paths and unsupported static resource/navigation behavior', () => {
  for (const src of ['../../app.mjs', '/app.mjs', '//host/app.mjs', 'https://host/app.mjs', 'file:app.mjs',
    './app.mjs?x', './app.mjs#x', './%2e%2e/app.mjs', './a\\app.mjs', './app.mjs&#63;x', './app.mjs&#10;', './app.css']) {
    rejected(page('', `<script type="module" src="${src}"></script>`));
  }
  for (const extra of ['<base href="./">', '<link rel="stylesheet" href="style.css">', '<img src="image.png">',
    '<iframe src="frame.html"></iframe>', '<video></video>', '<object data="x"></object>', '<a href="https://example.com">Link</a>',
    '<meta http-equiv="refresh" content="0">', '<div onclick="run()"></div>', '<div background="x"></div>']) rejected(page(extra));
});

test('CSS rejects resources in custom properties, escaped identifiers, recovery, at-rules and inactive branches', () => {
  for (const css of ['p{background:url(x.png)}', 'p{background:url(#fragment)}', 'p{--asset:url(x.png);background:var(--asset)}',
    'p{--asset:image-set("x.png" 1x);background:var(--asset)}', 'p{background:u\\72l(x.png)}',
    'p{background:var(--x,url(x.png))}', '@import "x.css";', '@font-face{src:url(x.woff2)}',
    '@media(width:0px){p{background:url(x.png)}}', 'p{color:???}', 'p{color:&#114;ed}', 'p{color:red; width:expression(1)}']) {
    rejected(page(`<style>${css}</style>`));
  }
  for (const extra of ['<style type="text/plain">p{color:red}</style>', '<style media="print">p{color:red}</style>',
    '<p style="background:&#117;rl(x.png)"></p>']) rejected(page(extra));
});

test('DOM runtime contract accepts only macOS Metal and explicitly advertised profile', () => {
  for (const target of ['macos-arm64', 'macos-x64']) {
    validateProfileTarget(DOM_PROFILE, target);
    const desc = { schemaVersion: 1, playerVersion: '0.0.0', packageVersions: [1], profiles: [DOM_PROFILE], target, backend: 'metal', v8: 'test' };
    assert.equal(validateDescription(desc, target, DOM_PROFILE), desc);
    assert.throws(() => validateDescription({ ...desc, profiles: ['native-window-v1'] }, target, DOM_PROFILE), { code: 'INCOMPATIBLE_RUNTIME' });
  }
  for (const target of ['windows-x64', 'linux-x64']) assert.throws(() => validateProfileTarget(DOM_PROFILE, target), { code: 'UNSUPPORTED_TARGET' });
});
