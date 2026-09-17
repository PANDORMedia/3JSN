import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { WebSocketServer } from 'ws';

/** Loopback browser-reference services, with no access to acceptance-game files. */
export function createFixtureServer(root) {
  const timers = new Set();
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (path === '/fixture-api/message' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'X-Fixture': '3jsn-reference' });
        response.end(JSON.stringify({ message: 'same-origin reference', version: 1 }));
        return;
      }
      if (path === '/fixture-api/echo' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 1024) { response.writeHead(413); response.end(); return; }
        }
        const value = JSON.parse(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ received: value }));
        return;
      }
      if (path === '/fixture-api/binary' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end(Buffer.from([0, 255, 17, 42]));
        return;
      }
      if (path === '/fixture-api/error' && request.method === 'GET') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'intentional fixture failure' }));
        return;
      }
      if (path === '/fixture-api/delay' && request.method === 'GET') {
        const timer = setTimeout(() => { timers.delete(timer); response.writeHead(200); response.end('late response'); }, 500);
        timers.add(timer);
        response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
        return;
      }
      if (request.method !== 'GET' || !(path.startsWith('/fixtures/') || path.startsWith('/node_modules/three/build/')) || path.includes('\\') || path.split('/').includes('..')) throw new Error('Not served');
      const absolute = await realpath(join(root, path));
      const relativePath = relative(await realpath(root), absolute).split(sep).join('/');
      if (!(relativePath.startsWith('fixtures/') || relativePath.startsWith('node_modules/three/build/'))) throw new Error('Not served');
      const mime = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'application/javascript';
      const content = await readFile(absolute);
      response.writeHead(200, { 'Content-Type': mime });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });

  const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
  let nextConnection = 0;
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/fixture-ws') { socket.destroy(); return; }
    websocketServer.handleUpgrade(request, socket, head, (connection) => websocketServer.emit('connection', connection));
  });
  websocketServer.on('connection', (connection) => {
    const connectionId = ++nextConnection;
    connection.send(JSON.stringify({ type: 'welcome', connectionId }));
    connection.on('error', () => { connection.terminate(); });
    connection.on('message', (bytes, binary) => {
      if (binary) { connection.send(bytes, { binary: true }); return; }
      try {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'drop') connection.terminate();
        else if (message.type === 'echo') connection.send(JSON.stringify({ type: 'echo', payload: message.payload, connectionId }));
        else connection.close(1003, 'Unsupported fixture message');
      } catch {
        connection.close(1007, 'Invalid fixture JSON');
      }
    });
  });

  return {
    server,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const client of websocketServer.clients) client.terminate();
      await new Promise((resolve) => websocketServer.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
