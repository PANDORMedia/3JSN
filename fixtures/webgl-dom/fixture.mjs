import * as THREE from 'three';

const checks = [];
const resources = [];
function check(name, passed, observed) {
  checks.push({ name, passed, observed });
  if (!passed) throw new Error(`Reference check failed: ${name}`);
}
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function rendererFor(id) {
  const canvas = document.getElementById(id);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(160, 120, false);
  resources.push(renderer);
  return renderer;
}

function centerPixel(renderer) {
  const context = renderer.getContext();
  const pixel = new Uint8Array(4);
  context.readPixels(80, 60, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
  check('WebGL readback has no error', context.getError() === context.NO_ERROR);
  return [...pixel];
}

async function run() {
  const panel = document.getElementById('panel');
  const button = document.getElementById('change');
  const message = document.getElementById('message');
  const canvas = document.getElementById('texture');
  const context = canvas.getContext('2d');
  check('Canvas 2D context identity', context === canvas.getContext('2d'));
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, 16, 16);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  const material = new THREE.ShaderMaterial({
    uniforms: { image: { value: texture } },
    vertexShader: 'varying vec2 uvCoord; void main(){uvCoord=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform sampler2D image; varying vec2 uvCoord; void main(){gl_FragColor=texture2D(image,uvCoord);}',
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  resources.push(texture, material, geometry);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const renderer = rendererFor('scene');
  const preview = rendererFor('preview');
  check('Independent WebGL contexts', renderer.getContext() !== preview.getContext());
  renderer.render(scene, camera);
  const red = centerPixel(renderer);
  check('GLSL samples the red Canvas 2D texture', red[0] > 250 && red[1] < 5 && red[2] < 5, red);
  preview.setClearColor(0x00ff00, 1);
  preview.clear();
  const green = centerPixel(preview);
  check('Second canvas retains independent green output', green[0] < 5 && green[1] > 250 && green[2] < 5, green);

  let clicks = 0;
  let bubbles = 0;
  let targetIdentity = false;
  panel.addEventListener('click', (event) => {
    bubbles++;
    targetIdentity = event.target === button && event.currentTarget === panel;
  });
  button.addEventListener('click', () => {
    clicks++;
    context.fillStyle = '#0000ff';
    context.fillRect(0, 0, 16, 16);
    texture.needsUpdate = true;
    message.innerHTML = '<strong data-state="updated">Texture updated</strong>';
    message.classList.add('updated');
    renderer.render(scene, camera);
  });
  await nextFrame();
  const rect = button.getBoundingClientRect();
  check('Grid/flex layout produces queryable geometry', rect.width >= 130 && rect.height >= 30 && rect.x > 24 && rect.y > 120, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  button.focus();
  check('Programmatic focus updates activeElement', document.activeElement === button);
  button.click();
  check('Bubbling event retains live DOM identity', clicks === 1 && bubbles === 1 && targetIdentity, { clicks, bubbles, targetIdentity });
  check('Sibling innerHTML does not replace the control', document.querySelector('#change') === button && button.parentElement === document.getElementById('controls'));
  check('Mutation updates selector, class and text behavior', document.querySelector('#message strong').dataset.state === 'updated' && message.classList.contains('updated') && message.textContent === 'Texture updated');
  const blue2d = [...context.getImageData(0, 0, 1, 1).data];
  check('Canvas 2D exposes updated ImageData', blue2d[0] === 0 && blue2d[1] === 0 && blue2d[2] === 255, blue2d);
  const blue = centerPixel(renderer);
  check('Existing GLSL draws the updated CanvasTexture', blue[0] < 5 && blue[1] < 5 && blue[2] > 250, blue);
  button.click();
  check('Retained control listener handles a second click', clicks === 2 && bubbles === 2, { clicks, bubbles });
  await nextFrame();
  check('Browser animation-frame callback runs', true);
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return { threeRevision: THREE.REVISION, renderer: 'WebGLRenderer', gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable', input: 'programmatic click/focus; physical input untested' };
}

try {
  const environment = await run();
  globalThis.__3jsnFixtureResult = { schemaVersion: 1, fixture: 'webgl-dom', status: 'passed', environment, checks };
} catch (error) {
  globalThis.__3jsnFixtureResult = { schemaVersion: 1, fixture: 'webgl-dom', status: 'failed', checks, error: error.message };
}
document.documentElement.dataset.fixtureStatus = globalThis.__3jsnFixtureResult.status;
document.getElementById('result').textContent = JSON.stringify(globalThis.__3jsnFixtureResult, null, 2);
window.addEventListener('pagehide', () => { for (const resource of resources) resource.dispose(); }, { once: true });
