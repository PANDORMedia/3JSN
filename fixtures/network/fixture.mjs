import { runFixture, withTimeout } from '../harness.mjs';

function nextMessage(socket) {
  let cleanup;
  return withTimeout(new Promise((resolve, reject) => {
    cleanup = () => { socket.removeEventListener('message', onMessage); socket.removeEventListener('error', onError); socket.removeEventListener('close', onClose); };
    const onMessage = ({ data }) => { cleanup(); resolve(data); };
    const onError = () => { cleanup(); reject(new Error('WebSocket error while awaiting message')); };
    const onClose = () => { cleanup(); reject(new Error('WebSocket closed before its message')); };
    socket.addEventListener('message', onMessage, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
  }), 'WebSocket message').finally(() => cleanup());
}

function closed(socket) {
  let listener;
  return withTimeout(new Promise((resolve) => { listener = resolve; socket.addEventListener('close', listener, { once: true }); }), 'WebSocket close').finally(() => socket.removeEventListener('close', listener));
}

await runFixture('network', async (check) => {
  const response = await fetch('/fixture-api/message');
  const clone = response.clone();
  const json = await response.json();
  check('Relative fetch resolves the application origin', response.ok && json.message === 'same-origin reference' && new URL(response.url).origin === location.origin);
  check('Fetch exposes headers and independent cloned bodies', response.headers.get('x-fixture') === '3jsn-reference' && (await clone.json()).version === 1);
  check('Reading a response marks bodyUsed', response.bodyUsed === true);
  const posted = await fetch('/fixture-api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ round: 3, payload: 'echo' }) }).then((result) => result.json());
  check('JSON POST preserves request payload', posted.received.round === 3 && posted.received.payload === 'echo');
  const binary = new Uint8Array(await fetch('/fixture-api/binary').then((result) => result.arrayBuffer()));
  check('Fetch returns exact binary bytes', binary.join(',') === '0,255,17,42');
  const failure = await fetch('/fixture-api/error');
  check('HTTP error remains a response instead of a rejected fetch', failure.status === 503 && !failure.ok && (await failure.json()).error === 'intentional fixture failure');
  const privatePaths = await Promise.all(['/package.json', '/.cache/not-public', '/fixtures/../package.json'].map((path) => fetch(path)));
  check('Reference server refuses paths outside the public fixture allowlist', privatePaths.every((result) => result.status === 404));
  const controller = new AbortController();
  const delayed = fetch('/fixture-api/delay', { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  let abortName;
  try { await delayed; } catch (error) { abortName = error.name; }
  check('AbortController cancels a pending request', abortName === 'AbortError', abortName);

  const url = new URL('/fixture-ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  try {
    const welcome = JSON.parse(await nextMessage(socket));
    check('WebSocket opens and receives a connection identity', socket.readyState === WebSocket.OPEN && welcome.type === 'welcome' && Number.isInteger(welcome.connectionId));
    let reply = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'echo', payload: 'before-drop' }));
    const echo = JSON.parse(await reply);
    check('WebSocket text echo retains payload and connection identity', echo.payload === 'before-drop' && echo.connectionId === welcome.connectionId);
    reply = nextMessage(socket);
    socket.send(new Uint8Array([0, 255, 42]));
    const echoed = await reply;
    check('WebSocket binaryType and bytes survive an echo', echoed instanceof ArrayBuffer && new Uint8Array(echoed).join(',') === '0,255,42');
    let close = closed(socket);
    socket.send(JSON.stringify({ type: 'drop' }));
    const disconnected = await close;
    check('Server interruption produces an abnormal close', disconnected.code === 1006 && disconnected.wasClean === false, { code: disconnected.code, wasClean: disconnected.wasClean });
    socket = new WebSocket(url);
    const reconnected = JSON.parse(await nextMessage(socket));
    check('Application reconnect opens a new connection', reconnected.type === 'welcome' && reconnected.connectionId > welcome.connectionId);
    reply = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'echo', payload: 'after-reconnect' }));
    const recovered = JSON.parse(await reply);
    check('Messages resume after explicit reconnect', recovered.payload === 'after-reconnect' && recovered.connectionId === reconnected.connectionId);
    close = closed(socket);
    socket.close(1000, 'fixture complete');
    const finished = await close;
    check('Normal client shutdown preserves close code and reason', finished.code === 1000 && finished.reason === 'fixture complete' && finished.wasClean === true);
    return { transport: 'loopback HTTP and WebSocket', reconnect: 'explicit application behavior after forced disconnect', tlsAndCredentials: 'not tested', gameServices: 'not contacted' };
  } finally {
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  }
});
