export function createSceneControls(camera, canvas, keyTarget = globalThis, onChange = () => {}) {
  const initial = { x: camera.position.x, y: camera.position.y - 0.2, z: camera.position.z };
  const initialDistance = Math.hypot(initial.x, initial.y, initial.z);
  const initialYaw = Math.atan2(initial.x, initial.z);
  const initialPitch = Math.asin(initial.y / initialDistance);
  let distance = initialDistance;
  let yaw = initialYaw;
  let pitch = initialPitch;
  let drag;
  let paused = false;
  let elapsed = 0;
  let previousTime;
  const listeners = [];
  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  };
  const changed = reason => {
    pitch = Math.max(-1.3, Math.min(1.3, pitch));
    distance = Math.max(3, Math.min(20, distance));
    camera.position.set(distance * Math.sin(yaw) * Math.cos(pitch),
      0.2 + distance * Math.sin(pitch), distance * Math.cos(yaw) * Math.cos(pitch));
    camera.lookAt(0, 0.2, 0);
    onChange({ reason, paused, distance, yaw, pitch });
  };
  const endDrag = () => { drag = undefined; };
  listen(canvas, 'mousedown', event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY };
    event.preventDefault();
  });
  listen(canvas, 'mousemove', event => {
    if (!drag) return;
    if (!(event.buttons & 1)) { endDrag(); return; }
    yaw -= (event.clientX - drag.x) * 0.01;
    pitch += (event.clientY - drag.y) * 0.01;
    drag = { x: event.clientX, y: event.clientY };
    changed('drag');
  });
  listen(canvas, 'mouseup', event => { if (event.button === 0) endDrag(); });
  listen(canvas, 'mouseleave', endDrag);
  listen(keyTarget, 'blur', endDrag);
  listen(canvas, 'wheel', event => {
    const step = event.deltaMode === 1 ? 0.06 : event.deltaMode === 2 ? 0.3 : 0.002;
    distance *= Math.exp(Math.max(-2, Math.min(2, event.deltaY * step)));
    event.preventDefault();
    changed('wheel');
  }, { passive: false });
  listen(keyTarget, 'keydown', event => {
    switch (event.code) {
      case 'Space':
        if (event.repeat) return;
        paused = !paused; previousTime = undefined;
        break;
      case 'KeyR':
        if (event.repeat) return;
        distance = initialDistance; yaw = initialYaw; pitch = initialPitch;
        elapsed = 0; previousTime = undefined;
        break;
      case 'ArrowLeft': yaw -= 0.15; break;
      case 'ArrowRight': yaw += 0.15; break;
      case 'ArrowUp': pitch += 0.1; break;
      case 'ArrowDown': pitch -= 0.1; break;
      default: return;
    }
    event.preventDefault();
    changed(event.code);
  });
  return {
    advance(time) {
      if (previousTime !== undefined && !paused) elapsed += Math.max(0, time - previousTime) / 1000;
      previousTime = time;
      return elapsed;
    },
    dispose() { listeners.splice(0).forEach(remove => remove()); endDrag(); },
  };
}
