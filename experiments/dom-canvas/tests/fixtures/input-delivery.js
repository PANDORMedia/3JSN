const button = document.getElementById('button');
const parent = document.getElementById('parent');
const observation = globalThis.__inputDelivery = {
  rows: [], timeline: [], pendingMicrotasks: 0, completedMicrotasks: 0,
};

function record(row) {
  const index = observation.rows.length;
  observation.rows.push(row);
  observation.timeline.push(`event:${index}`);
  observation.pendingMicrotasks++;
  Promise.resolve().then(() => {
    button.setAttribute('data-last-microtask', String(index));
    observation.timeline.push(`microtask:${index}`);
    observation.pendingMicrotasks--;
    observation.completedMicrotasks++;
  });
}

function mouse(event) {
  if (!(event instanceof Event) || event.target !== button) {
    throw new Error('native input did not retain the generic DOM event target');
  }
  record([event.type, event.target.id, event.currentTarget.id,
    event.clientX, event.clientY, event.button, event.buttons, event.detail,
    event.cancelable, event.defaultPrevented]);
}

for (const kind of ['mousedown', 'mouseup', 'mousemove']) button.addEventListener(kind, mouse);
button.addEventListener('click', event => {
  event.preventDefault();
  mouse(event);
});
parent.addEventListener('click', mouse);
for (const kind of ['keydown', 'keyup']) {
  addEventListener(kind, event => {
    record([event.type, event.key, event.code, event.repeat,
      event.target === globalThis, event.cancelable]);
  });
}
for (const kind of ['blur', 'focus']) {
  addEventListener(kind, event => record([event.type, event.target === globalThis]));
}
