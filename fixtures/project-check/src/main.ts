import { WebGLRenderer as Renderer } from 'three';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const renderer = new Renderer({ canvas });
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const socket = new WebSocket('wss://example.invalid/game');
const state = localStorage.getItem('settings');
const audio = new AudioContext();
void audio.audioWorklet.addModule('./audio-worklet.js');
void fetch('./world.wasm').then(response => response.arrayBuffer()).then(bytes => WebAssembly.compile(bytes));
renderer.setAnimationLoop(() => navigator.getGamepads());
void import(`./levels/${state ?? 'default'}.ts`);
worker.postMessage({ connected: socket.readyState });
