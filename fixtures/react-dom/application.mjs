import { createElement as h, useEffect, useState, version as reactVersion } from 'react';
import { createRoot } from 'react-dom/client';

const initialItems = () => [
  { id: 'a', label: 'Prepare the scene' },
  { id: 'b', label: 'Update the dashboard' },
  { id: 'c', label: 'Keep the same nodes' },
];
const effects = { mounts: [], unmounts: [], setups: [], cleanups: [], rowMounts: [], rowCleanups: [] };
const clicks = [];
const waiters = new Set();
let root, generation = 0, committed, failure, verification;

function check(condition, message) {
  if (!condition) throw new Error(`React fixture: ${message}`);
}

function settleWaiters() {
  for (const waiter of [...waiters]) {
    if (failure || waiter.predicate()) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      if (failure) waiter.reject(failure);
      else waiter.resolve();
    }
  }
}

function fail(error) {
  failure = error instanceof Error ? error : new Error(String(error));
  settleWaiters();
}

function waitFor(predicate, description) {
  if (failure) return Promise.reject(failure);
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, timer: undefined };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`React fixture timed out waiting for ${description}`));
    }, 10_000);
    waiters.add(waiter);
  });
}

function Task({ item, generation: instance }) {
  useEffect(() => {
    const key = `${instance}:${item.id}`;
    effects.rowMounts.push(key);
    return () => { effects.rowCleanups.push(key); };
  }, [instance, item.id]);
  return h('li', { 'data-key': item.id },
    h('span', { className: 'task-key' }, item.id.toUpperCase()),
    h('span', { className: 'task-label' }, item.label));
}

function Dashboard({ generation: instance }) {
  const [state, setState] = useState(() => ({ count: 0, phase: 'ready', items: initialItems() }));
  useEffect(() => {
    effects.mounts.push(instance);
    return () => { effects.unmounts.push(instance); };
  }, [instance]);
  useEffect(() => {
    const key = `${instance}:${state.phase}:${state.count}`;
    effects.setups.push(key);
    committed = { generation: instance, count: state.count, phase: state.phase };
    settleWaiters();
    return () => { effects.cleanups.push(key); };
  }, [instance, state]);

  function action(event, update) {
    event.preventDefault();
    clicks.push({ listener: 'button', type: event.type, target: event.target.id,
      currentTarget: event.currentTarget.id, defaultPrevented: event.defaultPrevented,
      nativeDefaultPrevented: event.nativeEvent.defaultPrevented });
    setState(update);
  }
  const active = state.count > 0;
  const style = { '--accent': active ? '#d5b6ff' : '#65d8b1', paddingLeft: active ? 24 : 16,
    borderLeftWidth: active ? 5 : 3, ...(active ? {} : { marginTop: 4 }) };
  return h('section', { id: 'dashboard', className: active ? 'dashboard active' : 'dashboard', style,
    'data-count': state.count, 'data-generation': instance,
    onClick: event => clicks.push({ listener: 'dashboard', target: event.target.id, currentTarget: event.currentTarget.id }) },
  h('p', { className: 'eyebrow' }, 'REACT / LIVE TASK BOARD'),
  h('h1', null, 'A little progress'),
  h('p', { id: 'mixed' }, active ? 'Progress: ' : 'Completed: ',
    h('strong', { id: 'count-value' }, state.count), active ? ' task completed.' : ' tasks so far.'),
  h('p', { id: 'phase' }, `Phase: ${state.phase}`),
  h('div', { className: 'controls' },
    h('button', { id: 'advance', type: 'button', onClick: event => action(event,
      previous => ({ ...previous, count: previous.count + 1, phase: 'advanced' })) },
    h('span', { id: 'advance-label' }, 'Advance task')),
    h('button', { id: 'insert', type: 'button', onClick: event => action(event,
      previous => ({ ...previous, phase: 'inserted', items: previous.items.some(item => item.id === 'd')
        ? previous.items : [previous.items[0], { id: 'd', label: 'A newly inserted task' }, ...previous.items.slice(1)] })) }, 'Insert'),
    h('button', { id: 'reorder', type: 'button', onClick: event => action(event,
      previous => ({ ...previous, phase: 'reordered', items: [...previous.items].reverse() })) }, 'Reverse'),
    h('button', { id: 'remove', type: 'button', onClick: event => action(event,
      previous => ({ ...previous, phase: 'removed', items: previous.items.filter(item => item.id !== 'b') })) }, 'Remove B')),
  h('ul', { id: 'tasks', 'aria-label': 'Tasks' }, state.items.map(item => h(Task, { key: item.id, item, generation: instance }))),
  h('p', { className: 'footnote' }, 'React owns this dashboard. Three.js owns the adjacent canvas.'));
}

export function mount() {
  check(!root, 'mount called while a root is active');
  const instance = ++generation;
  root = createRoot(document.getElementById('root'), { onUncaughtError: fail, onRecoverableError: fail });
  root.render(h(Dashboard, { generation: instance }));
  return waitFor(() => committed?.generation === instance, `mount ${instance}'s passive effects`);
}

function node(id) {
  const value = document.getElementById(id);
  check(value, `missing #${id}`);
  return value;
}

function rows() {
  return [...node('tasks').children];
}

export function snapshot() {
  if (failure) throw failure;
  const dashboard = node('dashboard');
  return { reactVersion, generation: Number(dashboard.getAttribute('data-generation')),
    count: Number(dashboard.getAttribute('data-count')), phase: node('phase').textContent,
    mixedText: node('mixed').textContent, className: dashboard.className,
    style: { accent: dashboard.style.getPropertyValue('--accent'), paddingLeft: dashboard.style.paddingLeft,
      borderLeftWidth: dashboard.style.borderLeftWidth, marginTop: dashboard.style.marginTop },
    tasks: rows().map(row => ({ key: row.getAttribute('data-key'), text: row.textContent })),
    effects: Object.fromEntries(Object.entries(effects).map(([key, values]) => [key, [...values]])),
    clicks: clicks.map(value => ({ ...value })) };
}

async function activate(id, phase) {
  const accepted = node(id).dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  check(accepted === false, `delegated ${id} click did not cancel its native event`);
  await waitFor(() => committed?.generation === generation && committed.phase === phase, `${phase} commit`);
  return snapshot();
}

function checkOrder(expected) {
  check(JSON.stringify(rows().map(row => row.getAttribute('data-key'))) === JSON.stringify(expected), `key order differs from ${expected}`);
}

async function verifyOnce() {
  check(generation === 1 && committed?.phase === 'ready', 'verification requires the untouched first mount');
  const phases = { initial: snapshot() };
  checkOrder(['a', 'b', 'c']);
  const retained = new Map(rows().map(row => [row.getAttribute('data-key'), row]));
  const mixed = node('mixed'), text = mixed.firstChild, strong = node('count-value');
  check(text.nodeType === 3 && text.textContent === 'Completed: ', 'initial mixed text node missing');
  check(phases.initial.effects.mounts.length === 1 && phases.initial.effects.rowMounts.length === 3, 'initial effects did not run exactly once');

  phases.advanced = await activate('advance-label', 'advanced');
  check(node('mixed') === mixed && mixed.firstChild === text && node('count-value') === strong, 'mixed text/element identity changed');
  check(text.textContent === 'Progress: ' && phases.advanced.mixedText === 'Progress: 1 task completed.', 'mixed children did not update');
  check(phases.advanced.count === 1 && phases.advanced.className === 'dashboard active', 'state or class update failed');
  check(phases.advanced.style.accent === '#d5b6ff' && phases.advanced.style.paddingLeft === '24px'
    && phases.advanced.style.borderLeftWidth === '5px' && phases.advanced.style.marginTop === '', 'style property update/removal failed');
  check(JSON.stringify(clicks.slice(0, 2)) === JSON.stringify([
    { listener: 'button', type: 'click', target: 'advance-label', currentTarget: 'advance', defaultPrevented: true, nativeDefaultPrevented: true },
    { listener: 'dashboard', target: 'advance-label', currentTarget: 'dashboard' },
  ]), 'React delegated target/currentTarget/bubbling differs');

  phases.inserted = await activate('insert', 'inserted');
  checkOrder(['a', 'd', 'b', 'c']);
  for (const [key, original] of retained) check(rows().find(row => row.getAttribute('data-key') === key) === original, `insert replaced key ${key}`);
  retained.set('d', rows()[1]);
  phases.reordered = await activate('reorder', 'reordered');
  checkOrder(['c', 'b', 'd', 'a']);
  for (const row of rows()) check(retained.get(row.getAttribute('data-key')) === row, 'reorder replaced a keyed node');
  check(effects.rowMounts.length === 4 && effects.rowCleanups.length === 0, 'reorder remounted a keyed component');

  phases.removed = await activate('remove', 'removed');
  checkOrder(['c', 'd', 'a']);
  check(retained.get('b').parentNode === null && retained.get('b').textContent === 'BUpdate the dashboard', 'removed row identity/content invalidated');
  check(JSON.stringify(effects.rowCleanups) === JSON.stringify(['1:b']), 'removed row effect did not clean up exactly once');

  root.unmount();
  root = undefined;
  check(node('root').childNodes.length === 0, 'unmount left DOM children');
  check(JSON.stringify(effects.unmounts) === JSON.stringify([1]), 'dashboard unmount cleanup missing');
  check(effects.cleanups.length === effects.setups.length && effects.rowCleanups.length === 4, 'unmount left live effects');
  for (const original of retained.values()) check(original.isConnected === false, 'unmount retained a connected row');
  const cleaned = effects.rowCleanups.length;
  const oldChild = retained.get('a').firstChild;
  await mount();
  phases.remounted = snapshot();
  checkOrder(['a', 'b', 'c']);
  check(phases.remounted.count === 0 && phases.remounted.className === 'dashboard', 'remount retained prior state');
  for (const row of rows()) check(retained.get(row.getAttribute('data-key')) !== row, 'remount reused an old root node');
  check(JSON.stringify(effects.mounts) === JSON.stringify([1, 2]) && effects.rowMounts.length === 7
    && effects.rowCleanups.length === cleaned && effects.setups.length === 6 && effects.cleanups.length === 5, 'effect lifecycle counts differ');
  check(retained.get('a').firstChild === oldChild && retained.get('a').textContent === 'APrepare the scene', 'detached row changed during remount');
  return { passed: true, phases, keyedIdentity: true, mixedIdentity: true, effectCleanup: true, remounted: true };
}

export function verify() {
  verification ??= verifyOnce();
  return verification;
}

export function unmount() {
  if (root) { root.unmount(); root = undefined; }
}
