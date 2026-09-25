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
const url = core.loadExtScript("ext:deno_web/00_url.js");
const abort = core.loadExtScript("ext:deno_web/03_abort_signal.js");
const headers = core.loadExtScript("ext:deno_fetch/20_headers.js");
const request = core.loadExtScript("ext:deno_fetch/23_request.js");
const response = core.loadExtScript("ext:deno_fetch/23_response.js");
const { DOMException } = core.loadExtScript("ext:deno_web/01_dom_exception.js");
const { Console } = core.loadExtScript("ext:deno_web/01_console.js");
const webgpu = core.createLazyLoader("ext:deno_webgpu/01_webgpu.js")();
const packageBase = "threejsn://package/app/index.html";

function packagedMimeType(pathname) {
  const extension = pathname.slice(pathname.lastIndexOf(".")).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".webp": "image/webp" })[extension];
}

async function fetchPackageAsset(input, init = {}) {
  const inputUrl = input instanceof request.Request ? input.url
    : input instanceof url.URL ? input.href : String(input);
  const target = new url.URL(inputUrl, packageBase);
  if (target.protocol !== "threejsn:" || target.hostname !== "package"
    || target.username || target.password || target.port || target.search || target.hash) {
    throw new TypeError("fetch only supports declared packaged assets");
  }
  if (!target.pathname.startsWith("/app/")) target.pathname = `/app${target.pathname}`;
  if (target.pathname.includes("%") || target.pathname.includes("\\")) {
    throw new TypeError("packaged asset URL must use a canonical path");
  }
  const method = String(init.method ?? (input instanceof request.Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" || (init.body ?? (input instanceof request.Request ? input.body : null)) !== null) {
    throw new TypeError("packaged asset fetch supports GET requests without a body");
  }
  const signal = init.signal ?? (input instanceof request.Request ? input.signal : undefined);
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const mime = packagedMimeType(target.pathname);
  if (!mime) throw new TypeError(`Unsupported packaged image type: ${target.pathname}`);
  let bytes;
  try {
    bytes = core.ops.op_native_load_package_asset(target.href);
  } catch (error) {
    throw new TypeError(error.message, { cause: error });
  }
  return new response.Response(bytes, { status: 200, headers: { "content-type": mime } });
}

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
  URL: url.URL,
  URLSearchParams: url.URLSearchParams,
  AbortController: abort.AbortController,
  AbortSignal: abort.AbortSignal,
  Headers: headers.Headers,
  Request: request.Request,
  Response: response.Response,
  fetch: fetchPackageAsset,
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
