# Native packaged raster images

`native-window-v1` currently supports a bounded path for raster images that are
statically imported by the JavaScript/TypeScript bundle. The builder writes
content-hashed files under `app/assets/`, records their byte lengths and SHA-256
hashes in `app.json`, and declares the `package-assets-v1` capability. It refuses
image imports when the supplied player does not advertise that capability.

For example, existing source can import a URL without a 3JSN-specific runtime
API:

```js
import textureUrl from './textures/arena.png';

const bitmap = await new THREE.ImageBitmapLoader().loadAsync(textureUrl);
```

Three.js r186's upstream `ImageBitmapLoader` calls `fetch`, reads a `Blob` and
passes it to `createImageBitmap`. The player retains package-verified image bytes
in memory and provides the standard Deno `Request`, `Response` and `Headers`
objects. Its global `fetch` resolves only paths at
`threejsn://package/app/`; requests for missing resources, non-package origins,
queries, fragments and non-canonical encoded paths reject with `TypeError`.
This profile does not expose remote or filesystem fetch. Resource bytes stay
independent of the process working directory after package verification.

The initial format allowlist is PNG, JPEG, GIF, BMP, ICO and WebP. Each file is
limited to 32 MiB, a package can declare at most 64 image resources, and their
combined bytes are limited to 64 MiB. Missing or hash-mismatched package files
fail before JavaScript starts. Unsupported request paths fail when fetched;
decoder errors propagate from `createImageBitmap`.

This path covers statically imported raster URLs emitted by esbuild. It does not
discover Vite `public/` files, HTML/CSS URLs, arbitrary `fetch()` strings,
computed paths, SVG, glTF sidecar files, audio or fonts. Those require build-graph
and runtime contracts of their own. The image bytes are decoded and staged in
CPU memory before the existing narrow WebGPU texture copy. An ignored hardware-
GPU integration test now verifies manifest-checked package bytes through the
unmodified Three.js loader and WebGPURenderer to Metal readback on Apple M1 Pro.
In addition, the [CLI package relocation probe](validation/2026-09-25-packaged-image-loading.md)
builds this fixture with the actual CLI, relocates and launches the packaged
executable, and verifies the texture's GPU readback. Native decoding and
zero-copy uploads are not established, and other platforms remain unverified.

See the [packaged image loading validation](validation/2026-09-25-packaged-image-loading.md)
for the current test evidence and remaining gates.
