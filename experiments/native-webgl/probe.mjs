import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REVISION, WebGLRenderer } from 'three';
import { createScene } from './scene.mjs';

const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: {
  'deps-dir': { type: 'string', default: '.cache/native-webgl' },
  backend: { type: 'string', default: { darwin: 'metal', linux: 'vulkan', win32: 'd3d11' }[process.platform] },
} });
const expectedBackend = { metal: /ANGLE Metal Renderer/, vulkan: /Vulkan/, d3d11: /Direct3D11/ }[values.backend];
assert.ok(expectedBackend, 'Choose --backend metal, vulkan or d3d11.');
process.env.ANGLE_DEFAULT_PLATFORM = values.backend;
const candidate = createRequire(join(resolve(root, values['deps-dir']), 'package.json'));
const candidateDirectory = dirname(candidate.resolve('gl/package.json'));
const packageInfo = candidate('gl/package.json');
assert.equal(packageInfo.version, '9.0.0-rc.10', 'This investigation is pinned to an experimental binding.');
const createGL = candidate('gl');
// The candidate hides renderer metadata behind fixed strings. Inspect its pinned internal API.
const { NativeWebGLRenderingContext } = candidate(join(candidateDirectory, 'src/javascript/native-gl.js'));
const native = new NativeWebGLRenderingContext(1, 1, true, true, false, false, true, true, false, false, true);
const nativeInfo = {
  renderer: native.getParameter(0x1f01),
  version: native.getParameter(0x1f02),
  shadingLanguage: native.getParameter(0x8b8c),
};
assert.match(nativeInfo.renderer, expectedBackend, 'Requested native backend was not selected.');
native.destroy();

const width = 128;
const height = 128;
const gl = createGL(width, height, { createWebGL2Context: true, preserveDrawingBuffer: true });
assert.ok(gl, 'Native WebGL2 context creation failed.');
const report = {
  status: 'partial',
  binding: `gl@${packageInfo.version}`,
  threeRevision: REVISION,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  kernel: release(),
  backend: values.backend,
  native: nativeInfo,
  width,
  height,
  publicVersion: gl.getParameter(gl.VERSION),
  publicShadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
  extensions: gl.getSupportedExtensions(),
  tests: [],
  limitations: [
    'Synthetic host canvas; no DOM, native window or presentation.',
    'No Rust embedding, GPU composition, CtF or cross-platform acceptance.',
    'Pixel readbacks are test measurements, not a proposed presentation transport.',
    'No performance measurement or full WebGL conformance run.',
  ],
};
const programs = [];
const shaders = [];
let renderer;
let fixture;
try {
  function compile(type, source) {
    const shader = gl.createShader(type);
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    assert.ok(gl.getShaderParameter(shader, gl.COMPILE_STATUS), gl.getShaderInfoLog(shader));
    return shader;
  }
  const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
const vec2 p[3] = vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));
void main() { gl_Position = vec4(p[gl_VertexID],0,1); }
`);
  const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
out vec4 outputColor;
void main() { outputColor = vec4(0.25,0.5,0.75,1); }
`);
  const program = gl.createProgram();
  programs.push(program);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  assert.ok(gl.getProgramParameter(program, gl.LINK_STATUS), gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  function pixels() {
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    assert.equal(gl.getError(), gl.NO_ERROR);
    return data;
  }
  const triangle = pixels();
  const expected = [64, 128, 191, 255];
  assert.ok(triangle.every((value, i) => Math.abs(value - expected[i % 4]) <= 1));
  report.tests.push({ name: 'GLSL ES 3.00 draw', status: 'pass', pixels: width * height, expectedRGBA: expected, tolerance: 1 });

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([3, 5, 7, 9]), gl.STATIC_DRAW);
  const output = new Uint8Array(4);
  gl.getBufferSubData(gl.ARRAY_BUFFER, 0, output);
  const error = gl.getError();
  gl.deleteBuffer(buffer);
  assert.deepEqual(Array.from(output), [0, 0, 0, 0], 'Known failure changed; investigate and update evidence.');
  assert.equal(error, gl.NO_ERROR);
  report.tests.push({ name: 'getBufferSubData', status: 'known-failure', expected: [3, 5, 7, 9], actual: Array.from(output), error });
  assert.match(report.publicVersion, /^WebGL 1\.0 /);
  assert.match(report.publicShadingLanguage, /^WebGL GLSL ES 1\.0 /);
  report.tests.push({ name: 'WebGL2 version reporting', status: 'known-failure', expected: 'WebGL 2.0 / WebGL GLSL ES 3.00', actual: [report.publicVersion, report.publicShadingLanguage] });

  gl.useProgram(null);
  const canvas = { width, height, style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => gl };
  renderer = new WebGLRenderer({ context: gl, canvas });
  fixture = createScene();
  function frame(rotation) {
    fixture.update(rotation);
    renderer.render(fixture.scene, fixture.camera);
    return pixels();
  }
  const first = frame(0);
  const second = frame(0.7);
  let foreground = 0;
  let changed = 0;
  for (let i = 0; i < first.length; i += 4) {
    if (first[i + 1] > 8) foreground++;
    if (first[i] !== second[i] || first[i + 1] !== second[i + 1] || first[i + 2] !== second[i + 2]) changed++;
  }
  assert.ok(foreground > 1000, 'Expected visible PBR geometry.');
  assert.ok(changed > 1000, 'Expected animated geometry.');
  report.tests.push({ name: 'Upstream Three.js WebGLRenderer PBR scene', status: 'pass', foregroundPixels: foreground, changedPixels: changed });
} finally {
  fixture?.dispose();
  renderer?.dispose();
  for (const program of programs) gl.deleteProgram(program);
  for (const shader of shaders) gl.deleteShader(shader);
  gl.getExtension('STACKGL_destroy_context').destroy();
}

const libraryNames = { darwin: ['libEGL.dylib', 'libGLESv2.dylib'], linux: ['libEGL.so', 'libGLESv2.so'], win32: ['libEGL.dll', 'libGLESv2.dll'] }[process.platform];
report.nativeLibraries = [];
for (const name of ['webgl.node', ...libraryNames]) {
  const data = await readFile(join(candidateDirectory, 'build/Release', name));
  report.nativeLibraries.push({ file: basename(name), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const outputDirectory = join(root, 'artifacts/native-webgl');
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log('Probe completed with known WebGL incompatibilities. This is not a compatibility pass.');
