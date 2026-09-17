import { core } from "ext:core/mod.js";
import { createAnimationFrames } from "./animation.js";

export function initializeWindow() {
  const ops = core.ops;
  if (!ops.op_native_has_surface()) return;

  const frames = createAnimationFrames({
    now: () => performance.now(),
    checkpoint: () => core.runMicrotasks(),
    reportError: error => globalThis.reportError(error),
    setPending: pending => ops.op_native_frame_pending(pending),
  });

  let width = 1;
  let height = 1;
  let scale = 1;
  let surfaceContext;
  // This canvas protocol is an integration fixture, not an HTMLCanvasElement
  // implementation. The DOM adapter will own production canvas nodes.
  class NativeCanvas extends EventTarget {
    style = {};
    get width() { return width; }
    set width(value) { width = Math.max(1, Number(value) >>> 0); ops.op_native_resize(width, height); }
    get height() { return height; }
    set height(value) { height = Math.max(1, Number(value) >>> 0); ops.op_native_resize(width, height); }
    get clientWidth() { return width / scale; }
    get clientHeight() { return height / scale; }
    getContext(kind) {
      return kind === "webgpu" ? (surfaceContext ??= ops.op_native_canvas_context(this)) : null;
    }
    getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight,
        width: this.clientWidth, height: this.clientHeight };
    }
  }
  const canvas = new NativeCanvas();
  const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
  Object.defineProperty(GPUCanvasContext.prototype, "getCurrentTexture", {
    configurable: true, writable: true,
    value(...args) {
      return this === surfaceContext
        ? ops.op_native_current_texture()
        : Reflect.apply(getCurrentTexture, this, args);
    },
  });
  for (const name of ["configure", "unconfigure"]) {
    const original = GPUCanvasContext.prototype[name];
    Object.defineProperty(GPUCanvasContext.prototype, name, {
      configurable: true, writable: true,
      value(...args) {
        ops.op_native_discard(this);
        return Reflect.apply(original, this, args);
      },
    });
  }
  Object.defineProperty(GPU.prototype, "requestAdapter", {
    configurable: true, writable: true,
    async value(options = {}) {
      if (this !== navigator.gpu) throw new TypeError("Illegal GPU receiver");
      return ops.op_native_request_adapter(options);
    },
  });
  Object.assign(globalThis, {
    window: globalThis,
    self: globalThis,
    requestAnimationFrame: callback => frames.request(callback),
    cancelAnimationFrame: id => frames.cancel(id),
    nativeWindow: Object.freeze({ canvas }),
  });
  ops.op_native_bind_callbacks(() => frames.dispatch(), (nextWidth, nextHeight, nextScale) => {
    width = Math.max(1, nextWidth);
    height = Math.max(1, nextHeight);
    scale = nextScale;
    globalThis.devicePixelRatio = scale;
    globalThis.innerWidth = canvas.clientWidth;
    globalThis.innerHeight = canvas.clientHeight;
    ops.op_native_resize(width, height);
    globalThis.dispatchEvent(new Event("resize"));
  });
  ops.op_native_keep_alive();
}
