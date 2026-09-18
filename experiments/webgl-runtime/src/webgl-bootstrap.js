import { ExperimentalWebGLContext, closeContext, observePixel } from 'ext:angle_probe/webgl.js';
globalThis.__webglHost = Object.freeze({
  createContext: (canvas, width, height) => new ExperimentalWebGLContext(canvas, width, height),
  closeContext, observePixel,
});
