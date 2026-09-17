(() => {
  const checks = {};
  const root = document.getElementById('root');
  const button = document.getElementById('button');
  const other = document.createElement('div');
  other.id = 'other';
  root.appendChild(other);

  const order = [];
  root.addEventListener('move', () => order.push('capture'), true);
  button.addEventListener('move', event => {
    order.push('target');
    other.appendChild(button);
    button.textContent = 'Moved during dispatch';
    other.style.width = '321px';
    checks.reentrantLayout = other.getBoundingClientRect().width === 321;
    checks.sameRealmCallback = event.target === button && button.parentNode === other;
    event.preventDefault();
  }, { once: true });
  root.addEventListener('move', () => order.push('old-parent'));
  other.addEventListener('move', () => order.push('new-parent'));
  const event = new Event('move', { bubbles: true, cancelable: true });
  checks.cancellation = button.dispatchEvent(event) === false && event.defaultPrevented;
  checks.propagationSnapshot = order.join() === 'capture,target,old-parent';
  order.length = 0;
  button.dispatchEvent(new Event('move', { bubbles: true }));
  checks.updatedPathAndOnce = order.join() === 'capture,new-parent,old-parent';
  checks.dispatchCleanup = event.currentTarget === null && event.eventPhase === 0;

  const retained = button;
  other.innerHTML = '<span class="replacement">Replacement</span>';
  retained.textContent = 'Still alive';
  root.appendChild(retained);
  checks.replacedNodeSurvives = retained === document.getElementById('button') && retained.textContent === 'Still alive';
  checks.selectorIdentity = root.querySelectorAll('#button')[0] === retained;
  checks.liveStyle = retained.style === retained.style && root.getBoundingClientRect().width === 240;

  let lateCalls = 0;
  const removed = () => lateCalls++;
  retained.addEventListener('remove-listener', () => retained.removeEventListener('remove-listener', removed));
  retained.addEventListener('remove-listener', removed);
  retained.dispatchEvent(new Event('remove-listener'));
  checks.removedListenerSkipped = lateCalls === 0;

  let ancestorCalls = 0;
  root.addEventListener('stop', () => ancestorCalls++);
  retained.addEventListener('stop', event => event.stopPropagation());
  retained.dispatchEvent(new Event('stop', { bubbles: true }));
  checks.stopPropagation = ancestorCalls === 0;

  retained.addEventListener('passive', event => event.preventDefault(), { passive: true });
  const passive = new Event('passive', { cancelable: true });
  checks.passive = retained.dispatchEvent(passive) && !passive.defaultPrevented;
  try { retained.appendChild(root); checks.cycleRejected = false; }
  catch { checks.cycleRejected = true; }
  try { other.removeChild(retained); checks.wrongParentRejected = false; }
  catch { checks.wrongParentRejected = true; }
  try { root.querySelector('['); checks.invalidSelectorRejected = false; }
  catch { checks.invalidSelectorRejected = true; }

  __blitz_send_message(JSON.stringify({ behavior: checks }));
})();
