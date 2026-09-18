import { core } from 'ext:core/mod.js';
import { idOf } from 'ext:html_v8_probe/bindings.js';
import { registerCanvasBackend } from 'ext:dom_canvas/canvas.js';
import {
  ExperimentalWebGLContext, closeContext, contextIdentity, resizeContext,
} from 'ext:angle_probe/webgl.js';

registerCanvasBackend('webgl2', {
  create(canvas, width, height) {
    const context = new ExperimentalWebGLContext(canvas, width, height);
    try {
      core.ops.op_webgl_canvas_register(idOf(canvas), contextIdentity(context));
    } catch (error) {
      try { closeContext(context); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'WebGL canvas registration and cleanup failed');
      }
      throw error;
    }
    return context;
  },
  resize(canvas, context, width, height) {
    // Every assignment resets the drawing buffer, including same-value assignments.
    // A failed GPU drain throws before ANGLE can replace the leased surface.
    core.ops.op_webgl_canvas_retire(idOf(canvas));
    resizeContext(context, width, height);
  },
});
