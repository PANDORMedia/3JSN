import * as THREE from 'three/webgpu';

// Shared scene code: no Node, Deno, DOM, filesystem, or native handles.
export function createScene(width = 640, height = 400) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101522);
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(4.5, 3.2, 6);
  camera.lookAt(0, 0.2, 0);

  const geometry = new THREE.TorusKnotGeometry(0.85, 0.26, 128, 24);
  const material = new THREE.MeshStandardMaterial({
    color: 0x5ae0ce, metalness: 0.35, roughness: 0.28,
  });
  const subject = new THREE.Mesh(geometry, material);
  scene.add(subject);

  const floorGeometry = new THREE.BoxGeometry(5, 0.15, 5);
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x293349, roughness: 0.85,
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.position.y = -1.6;
  scene.add(floor);

  scene.add(new THREE.HemisphereLight(0xa8caff, 0x172033, 2));
  const key = new THREE.DirectionalLight(0xffffff, 4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7f70ff, 3);
  rim.position.set(-4, 2, -2);
  scene.add(rim);

  return {
    scene,
    camera,
    update(seconds) {
      subject.rotation.set(seconds * 0.35, seconds * 0.6, 0);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      floorGeometry.dispose();
      floorMaterial.dispose();
    },
  };
}
