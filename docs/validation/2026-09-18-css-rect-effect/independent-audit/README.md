# Own CSS rect boundary audit

Read-only verification of the existing 16 browser and 16 native captures. No
recapture, build, source preparation or renderer edit ran. audit.json pins the
fixture, runner/comparators, report/PNG identities and frozen 8802 binary, and
records physical bounds, interior/edge guards, straight-edge samples and counts.

Chrome: 0/8 exact pairs. Native: 4/8, precisely the half-opacity pairs that Chrome
keeps nonidentical. This is a classification disagreement, not a compatibility
pass. Alpha-one pairs remain nonidentical in both renderers. All 16 interiors
match; all 16 combined comparisons fail on the four documented missing native
CSSOM x/y translations. Physical paint retains the translation at both DPRs.

P strictly contains R, and adding P changes no PNG bytes for any state/scale.
Every nonwhite pixel lies inside the expected raster support of translated R;
all pair changes stay on its perimeter. Intermediate-edge counts are 608/1216
and subject counts 21777/87713 at 1x/2x. All three saved comparator reports
regenerate byte for byte. No general antialias parity or standards violation
is asserted.

The DPR 2 addendum independently decodes the existing PNGs and checks 9,632
straight-edge pixels. Their fractional coverage supports the scaled translation;
inclusive bounds alone would not. See `dpr2-addendum.md` and its JSON receipt.
This physical-paint conclusion is limited to the recorded fixture capture path
and does not cover cached-document DPR transitions without style mutation.

The subsequent repaired-candidate audit is in `candidate-addendum.md` and JSON.
It verifies the four changed covered-blue captures, 12 unchanged captures,
observed Chrome/candidate 0/8 pair classification, the remaining CSSOM/corner
differences, and all 190 unchanged prior reports and PNGs. This supersedes the
baseline classification only for the separately pinned candidate binary.
