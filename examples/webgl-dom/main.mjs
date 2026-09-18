import { WebGLRenderer, Scene, PerspectiveCamera, BoxGeometry, MeshNormalMaterial, Mesh, Color } from 'three';

const renderer = new WebGLRenderer();
renderer.setSize(96, 96);
renderer.domElement.id = 'scene';
document.body.appendChild(renderer.domElement);
const scene = new Scene();
scene.background = new Color(0x102030);
const camera = new PerspectiveCamera(50, 1, 0.1, 100);
camera.position.z = 4;
const mesh = new Mesh(new BoxGeometry(1.6, 1.6, 1.6), new MeshNormalMaterial());
mesh.rotation.set(0.4, 0.65, 0.2);
scene.add(mesh);
renderer.render(scene, camera);
