# Repaired CSS rect capture audit

The frozen candidate executable is SHA-256
`85742ec2efcdd5e517a7ca8de6a40534fd248f04afb01c4366a5414a6ac8a86a`.
Its 16 existing captures passed the file-only audit. No build, source preparation
or recapture ran.

- Exactly four case payloads and PNGs changed from frozen baseline `8802b1fd…`:
  the half-opacity covered-blue state, with and without P, at each DPR.
  Their 608/1,216 changed pixels are all on R's perimeter. The other 12 case
  payloads and encoded PNGs are byte-identical.
- Candidate and Chrome now both have 0/8 exact invariant groups. This agrees on
  the observed noninvariance classification; it does not establish full
  antialias parity. Every pair difference remains on R's perimeter.
- All 16 candidate images retain the expected 21,777/87,713 subject pixels and
  608/1,216 intermediate pixels at DPR 1/2. Every interior pixel matches the
  declared subject color within tolerance two; all pixels outside R's inclusive
  support are white. Adding P changes no PNG bytes.
- Browser versus candidate has differences above two channel levels only at
  the four corners of R in every case. Uniform interiors match in all 16;
  combined comparison remains 0/16 because each case retains the four known
  native CSSOM x/y translation differences.
- Single-fill DPR 2 PNGs are unchanged from the prior fractional-coverage audit.
  Their correctly scaled translation remains established for this capture path,
  with no new claim about cached-document DPR transitions.
- Both saved candidate comparator reports regenerate byte for byte. All 190
  prior case payloads, complete reports and encoded PNGs were independently
  compared with the previous archive and are byte-identical; their decoded RGBA
  hashes also match their reports.

The candidate and regression reports record one paint per case, no GPU errors,
and Metal validation in their associated stderr receipts. Candidate metadata
also records an offscreen Metal device and checked native device/queue identity.
The executable bytes match the frozen binary receipt. This audit does not
reconstruct build provenance or certify other devices.

`candidate-addendum.json` records exact PNG/report/source/binary identities,
perimeter deltas, browser corner differences, guards and all 190 regression PNG
checks. `candidate-addendum.mjs` reproduces the read-only analysis and writes
only scratch audit/comparison reports. The original baseline audit is preserved.
