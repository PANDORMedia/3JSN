(() => {
  const checks = {};
  const parent = document.createElement('div');
  const child = document.createElement('button');
  const other = document.createElement('div');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const registrations = [];
  const removeListener = EventTarget.prototype.removeEventListener;
  const listen = (target, type, callback, options) => {
    target.addEventListener(type, callback, options);
    registrations.push([target, type, callback, options]);
  };

  try {
    document.body.appendChild(parent);
    document.body.appendChild(other);
    parent.appendChild(child);
    checks.nativeBrands = child instanceof EventTarget && new Event('brand') instanceof Event;
    checks.domRoots = child.nodeType === 1 && document.nodeType === 9
      && child.getRootNode() === document && document.parentNode === null;

    const order = [];
    listen(parent, 'ancestor-only', event => order.push(['capture', event.eventPhase]), true);
    listen(parent, 'ancestor-only', event => order.push(['bubble', event.eventPhase]));
    child.dispatchEvent(new Event('ancestor-only', { bubbles: true }));
    checks.ancestorOnly = same(order, [['capture', 1], ['bubble', 3]]);

    const cancelled = new Event('pre-cancelled', { cancelable: true });
    cancelled.preventDefault();
    checks.preCancelled = child.dispatchEvent(cancelled) === false && cancelled.defaultPrevented;

    const branded = new Event('branded', { bubbles: true, cancelable: true });
    let nativeCall = false;
    const onBranded = event => {
      nativeCall = event === branded && event.target === child;
    };
    EventTarget.prototype.addEventListener.call(child, 'branded', onBranded);
    registrations.push([child, 'branded', onBranded]);
    EventTarget.prototype.dispatchEvent.call(child, branded);
    checks.nativePrototypeInterop = nativeCall && branded.currentTarget === null && branded.eventPhase === 0;
    checks.readonlyEvent = Reflect.set(branded, 'target', other) === false
      && Reflect.set(branded, 'type', 'replacement') === false
      && Reflect.set(branded, 'bubbles', false) === false
      && branded.target === child && branded.type === 'branded' && branded.bubbles;

    const moved = [];
    let pathWasCaptured = false;
    listen(parent, 'move', () => moved.push('old-parent'));
    listen(other, 'move', () => moved.push('new-parent'));
    listen(child, 'move', event => {
      moved.push('target');
      other.appendChild(child);
      const path = event.composedPath();
      pathWasCaptured = path[0] === child && path[1] === parent && !path.includes(other);
      event.preventDefault();
    }, { once: true });
    const moving = new Event('move', { bubbles: true, cancelable: true });
    checks.pathMutation = child.dispatchEvent(moving) === false && pathWasCaptured
      && same(moved, ['target', 'old-parent']) && moving.composedPath().length === 0;
    moved.length = 0;
    child.dispatchEvent(new Event('move', { bubbles: true }));
    checks.nextDispatchPath = same(moved, ['new-parent']);

    let removedCalls = 0;
    const removed = () => removedCalls++;
    listen(child, 'remove', () => child.removeEventListener('remove', removed));
    listen(child, 'remove', removed);
    child.dispatchEvent(new Event('remove'));
    checks.listenerMutation = removedCalls === 0;

    const proto = EventTarget.prototype;
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    const additions = [];
    const removals = [];
    let reentryRejected = false;
    listen(child, 'cleanup', event => {
      try { child.dispatchEvent(event); }
      catch (error) { reentryRejected = error.name === 'InvalidStateError'; }
    });
    // Observe the adapter's temporary listeners on both the outer dispatch and
    // the rejected nested dispatch; both must be removed by their own finally.
    proto.addEventListener = function(type, callback, ...args) {
      if (this === child && type === 'cleanup') additions.push(callback);
      return add.call(this, type, callback, ...args);
    };
    proto.removeEventListener = function(type, callback, ...args) {
      if (this === child && type === 'cleanup') removals.push(callback);
      return remove.call(this, type, callback, ...args);
    };
    try {
      child.dispatchEvent(new Event('cleanup'));
    } finally {
      proto.addEventListener = add;
      proto.removeEventListener = remove;
    }
    checks.exceptionCleanup = reentryRejected && additions.length === 2 && removals.length === 2
      && additions.every(callback => removals.includes(callback));
  } finally {
    for (const [target, type, callback, options] of registrations) {
      removeListener.call(target, type, callback, options);
    }
    if (parent.parentNode) parent.parentNode.removeChild(parent);
    if (other.parentNode) other.parentNode.removeChild(other);
  }

  for (const [name, passed] of Object.entries(checks)) {
    if (passed !== true) throw new Error(`DOM event integration failed: ${name}`);
  }
  __blitz_send_message(JSON.stringify({ domEventChecks: checks }));
})();
