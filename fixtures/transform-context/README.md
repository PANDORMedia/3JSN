# Transform context hit fixture

The browser and native tests load the same original HTML. Two overlapping boxes
distinguish whether their host creates a real stacking context. The shared point
is `(32,32)` in a 448×256 CSS-pixel viewport; all nodes remain connected.

In positive mode the subject uses z-index 2 and the later peer uses 1. The subject
wins without a host context; the peer wins when the host contains its subject's
stacking level. In negative mode both boxes use -1 and the expected targets
reverse. Ancestors use `pointer-events:none` while both boxes explicitly restore
`auto`, allowing negative-z targets to be observed independently of transparent
ancestor backgrounds.

The 19-state sequence covers transform none, identity translation/matrix,
nonidentity translation, individual translate/rotate/scale, perspective and
preserve-3d, with repeated resets. Replacing the host's inline style resets all
previous transform properties. The sequence runs three times in each mode,
sampling twice after every mutation: 228 assertions. Native samples use a resolve
immediately after the mutation and a subsequent cached resolve. Browser samples
wait two animation frames; each cycle uses a bounded CDP command.

```sh
node scripts/compatibility/transform-hit-reference.mjs /path/to/chrome artifacts/auto-paint/browser-hit-reference.json
```

The output directory must already exist. The report records browser identity,
fixture/test/runner hashes, and every target. Native tests additionally inspect
context membership and initially authored styles without a warm resolve. These
internal ownership assertions are distinct from browser-visible evidence.

Identity transforms still establish a context under
[CSS Transforms](https://www.w3.org/TR/css-transforms-1/#transform-rendering).
The fixture tests stacking and a point within simple overlapping boxes. It does
not certify general transformed bounds, 3D projection, perspective rendering,
fixed/absolute containing blocks, clipping, scrolling, input dispatch or native
window presentation. All code is covered by the repository's MIT license.
