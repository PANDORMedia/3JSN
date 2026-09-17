import * as THREE from 'three';

export function createScene() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 4;
  const geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  const material = new THREE.MeshStandardMaterial({ color: 0x30bba8, metalness: 0.3, roughness: 0.4 });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh, new THREE.AmbientLight(0xffffff, 0.3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(2, 3, 4);
  scene.add(light);
  return {
    scene,
    camera,
    update(rotation) { mesh.rotation.set(rotation, rotation * 0.7, 0); },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}
