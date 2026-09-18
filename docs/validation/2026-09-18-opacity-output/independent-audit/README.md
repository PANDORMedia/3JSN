# Independent opacity-output witness audit

`audit.json` records a read-only inspection and recomputation of existing captures.
No browser/GPU run, renderer edit or build was performed. The forthcoming native
repeat and the separate full regression suite are explicitly outside its scope.

All paths are relative to the 3JSN repository root. Capture report hashes bind
each case filename and decoded RGBA hash; the audit additionally records every
new-fixture tile and every escape/signed/restored state. Region coordinates and
comparison tolerances are explicit. Seven comparator outputs were regenerated
into temporary files and matched the recorded reports byte for byte.

Verified: 144 PNGs, candidate binary, 19 prepared source hashes, 11 patch hashes,
all 26 later tiles and nine escape states in each of Chrome/baseline/candidate.
Only the three recorded covered-blue old case payloads changed; 19 remain exact.
This is bounded evidence, not full-image browser/native parity or platform support.
