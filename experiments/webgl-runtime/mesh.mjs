import { WebGLRenderer, Scene, PerspectiveCamera, BoxGeometry, MeshBasicMaterial, MeshNormalMaterial, ShaderMaterial, Mesh, Color, REVISION } from 'three';

const { createContext, closeContext, observeFrame } = globalThis.__webglHost;
function check(value, message) { if (!value) throw new Error(message); }
const canvas = { width: 128, height: 128, style: {}, addEventListener() {}, removeEventListener() {} };
const gl = createContext(canvas, canvas.width, canvas.height);
const renderer = new WebGLRenderer({ canvas, context: gl });
const scene = new Scene();
scene.background = new Color(0x102030);
const camera = new PerspectiveCamera(50, 1, 0.1, 100);
camera.position.z = 4;
const geometry = new BoxGeometry(1.6, 1.6, 1.6);
const material = new MeshBasicMaterial({ color: 0xff8822 });
const cube = new Mesh(geometry, material);
scene.add(cube);
function frame() {
  renderer.render(scene, camera);
  check(gl.getError() === gl.NO_ERROR, 'Render generated a GL error');
  const data = new Uint8Array(128 * 128 * 4);
  observeFrame(gl, data);
  return data;
}
const first = frame();
cube.rotation.set(0.4, 0.65, 0.2);
const second = frame();
let changed = 0;
for (let i = 0; i < first.length; i += 4) if (first[i] !== second[i] || first[i + 1] !== second[i + 1] || first[i + 2] !== second[i + 2]) changed++;
check(changed > 100, 'Rotating the indexed mesh did not change enough pixels');
const center = (64 * 128 + 64) * 4;
check(second[center] > 200 && second[center + 1] > 80 && second[center + 2] < 100, 'MeshBasicMaterial center pixel is missing');
const nonIndexed = geometry.toNonIndexed();
cube.geometry = nonIndexed;
const third = frame();
check(third.every((byte, i) => byte === second[i]), 'Equivalent indexed and nonindexed draws differ');
const shader = new ShaderMaterial({
  uniforms: { tint: { value: new Color(0.1, 0.3, 0.9) } },
  vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform vec3 tint; void main() { gl_FragColor = vec4(tint, 1.0); }',
});
cube.material = shader;
const fourth = frame();
check(fourth[center + 2] > 200 && fourth[center] < 80, 'Unmodified GLSL ShaderMaterial did not draw blue');
const custom = new MeshBasicMaterial({ color: 0xffffff });
custom.onBeforeCompile = source => {
  source.fragmentShader = source.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vec3(0.0, 1.0, 0.0);');
};
cube.material = custom;
const fifth = frame();
check(fifth[center + 1] > 240 && fifth[center] < 10 && fifth[center + 2] < 10, 'onBeforeCompile shader customization was not preserved');
const normalMaterial = new MeshNormalMaterial();
cube.material = normalMaterial;
const sixth = frame();
const normalColors = new Set();
for (let i = 0; i < sixth.length; i += 4) {
  if (sixth[i] !== sixth[0] || sixth[i + 1] !== sixth[1] || sixth[i + 2] !== sixth[2]) normalColors.add(`${sixth[i]},${sixth[i + 1]},${sixth[i + 2]}`);
}
check(normalColors.size >= 3, 'MeshNormalMaterial did not distinguish cube faces');
normalMaterial.dispose();
geometry.dispose(); nonIndexed.dispose(); material.dispose(); shader.dispose(); custom.dispose(); renderer.dispose();
check(gl.getError() === gl.NO_ERROR, 'Disposal generated GL errors');
closeContext(gl);
globalThis.__rendererInitReport = {
  status: 'offscreen-upstream-three-mesh', threeRevision: REVISION, width: 128, height: 128,
  changedPixels: changed, basicCenter: [...second.slice(center, center + 4)],
  shaderCenter: [...fourth.slice(center, center + 4)], customCenter: [...fifth.slice(center, center + 4)],
  indexedEqualsNonIndexed: true, rgba: [...second], shaderRgba: [...fourth], customRgba: [...fifth], normalRgba: [...sixth], normalFaceColors: normalColors.size,
  limitations: ['Injected canvas fixture; no DOM/window integration', 'Partial WebGL bindings', 'macOS Metal only'],
};
