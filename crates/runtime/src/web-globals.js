import { core } from "ext:core/mod.js";
import { installImageBitmapTextureCopy } from "./image-copy.js";

const webidl = core.loadExtScript("ext:deno_webidl/00_webidl.js");
const events = core.loadExtScript("ext:deno_web/02_event.js");
const encoding = core.loadExtScript("ext:deno_web/08_text_encoding.js");
const base64 = core.loadExtScript("ext:deno_web/05_base64.js");
const timers = core.loadExtScript("ext:deno_web/02_timers.js");
const performance = core.loadExtScript("ext:deno_web/15_performance.js");
const file = core.loadExtScript("ext:deno_web/09_file.js");
const image = core.createLazyLoader("ext:deno_image/01_image.js")();
const { DOMException } = core.loadExtScript("ext:deno_web/01_dom_exception.js");
const { Console } = core.loadExtScript("ext:deno_web/01_console.js");
const webgpu = core.createLazyLoader("ext:deno_webgpu/01_webgpu.js")();

webgpu.initGPU();
for (const [name, value] of Object.entries(webgpu)) {
  if (name.startsWith("GPU")) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}
Object.assign(globalThis, {
  Event: events.Event,
  EventTarget: events.EventTarget,
  ErrorEvent: events.ErrorEvent,
  CustomEvent: events.CustomEvent,
  reportError: events.reportError,
  DOMException,
  Blob: file.Blob,
  File: file.File,
  ImageBitmap: image.ImageBitmap,
  createImageBitmap: image.createImageBitmap,
  TextEncoder: encoding.TextEncoder,
  TextDecoder: encoding.TextDecoder,
  atob: base64.atob,
  btoa: base64.btoa,
  setTimeout: timers.setTimeout,
  clearTimeout: timers.clearTimeout,
  setInterval: timers.setInterval,
  clearInterval: timers.clearInterval,
  performance: performance.performance,
  console: new Console((message, isError) => core.print(message, isError)),
});
// Event listener exceptions dispatch an ErrorEvent on the global target. Its
// prototype and WebIDL brand must agree before that error path can run.
Object.setPrototypeOf(globalThis, events.EventTarget.prototype);
Object.defineProperty(globalThis, webidl.brand, { value: webidl.brand });
events.saveGlobalThisReference(globalThis);
events.setEventTargetData(globalThis);
performance.setTimeOrigin();
Object.defineProperty(globalThis, "navigator", { value: Object.freeze({ gpu: webgpu.gpu }) });
installImageBitmapTextureCopy(webgpu);
