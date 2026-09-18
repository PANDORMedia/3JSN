import { registerCanvasBackend } from 'ext:dom_canvas/canvas.js';
import { ExperimentalWebGLContext, resizeContext } from 'ext:angle_probe/webgl.js';

// This optional adapter preserves the shared DOM canvas and parser policy. The
// bounded backend currently reports unsupported extents or native failures by
// throwing; it does not turn them into a successful context or resize.
registerCanvasBackend('webgl2', {
  create: (canvas, width, height) => new ExperimentalWebGLContext(canvas, width, height),
  resize: (_canvas, context, width, height) => resizeContext(context, width, height),
});
