const results = {};
function check(name, run) {
  try { results[name] = run(); }
  catch (error) { results[name] = {error: String(error)}; }
}
const root = document.getElementById('root');
check('identity', () => {
  root.expando = 42;
  return root === document.querySelector('#root') && root.expando === 42;
});
check('mutation', () => {
  root.innerHTML = '<button id="button" class="old">Start</button>';
  const button = root.querySelector('button');
  button.classList.remove('old');
  button.classList.add('active');
  button.textContent = 'Ready';
  return document.querySelector('#root > button.active').textContent === 'Ready';
});
check('geometry', () => {
  root.style.width = '120px';
  const first = root.getBoundingClientRect().width;
  root.style.width = '240px';
  const second = root.getBoundingClientRect().width;
  return [first, second];
});
check('eventOrder', () => {
  const order = [];
  root.addEventListener('click', () => order.push('capture'), true);
  const button = document.getElementById('button');
  button.addEventListener('click', () => order.push('target'));
  root.addEventListener('click', () => order.push('bubble'));
  button.click();
  return order;
});
check('detachedIdentity', () => {
  const button = document.getElementById('button');
  root.removeChild(button);
  button.textContent = 'Detached';
  root.appendChild(button);
  return button === document.getElementById('button') && button.textContent === 'Detached';
});
check('classListSameObject', () => root.classList === root.classList);
check('inputPrototype', () => document.createElement('input') instanceof HTMLInputElement);
check('canvasContextType', () => typeof document.createElement('canvas').getContext);
check('serviceTypes', () => [typeof Worker, typeof WebSocket, typeof AudioContext, typeof MutationObserver]);
__blitz_send_message(JSON.stringify(results));
const frames = [];
requestAnimationFrame((time) => {
  frames.push(time);
  requestAnimationFrame((next) => {
    frames.push(next);
    __blitz_send_message(JSON.stringify({frames}));
  });
});
