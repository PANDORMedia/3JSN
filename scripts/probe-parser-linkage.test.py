import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "linkage", Path(__file__).with_name("probe-parser-linkage.py")
)
linkage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(linkage)


class LinkageEvidenceTests(unittest.TestCase):
    def test_multiline_cargo_commands_are_not_lost(self):
        log = """   Compiling html5ever v0.39.0
     Running `CARGO_PKG_DESCRIPTION='Line one
Line two' /toolchain/bin/rustc --crate-name html5ever --crate-type lib`
     Running `/build/build-script-build`
warning: blitz_html is mentioned without being compiled
     Running `/toolchain/bin/rustc --crate-name runtime --crate-type bin`
"""
        records = linkage.build_records(log)
        self.assertEqual([record["crate"] for record in records], ["html5ever", "runtime"])
        self.assertIn("Line one\nLine two", records[0]["command"])

    def test_object_matching_requires_a_crate_path_boundary(self):
        hits = linkage.parser_hits([
            "[ 1] /deps/libhtml5ever-abc.rlib[7](html5ever.obj)",
            "[ 2] /deps/libmy_html5ever_wrapper-abc.rlib[8](other.obj)",
            "[ 3] /deps/libblitz_html-abc.rlib[1](blitz_html.obj)",
        ])
        self.assertEqual(hits["html5ever"]["count"], 1)
        self.assertEqual(hits["blitz_html"]["count"], 1)
        self.assertEqual(hits["xml5ever"]["count"], 0)

    def test_non_utf8_symbol_bytes_are_preserved(self):
        raw = b"00001234 T __ZN10blitz_html6parser17h1234E\r\n00001235 T name\xff\r\n"
        decoded = raw.decode("utf-8", errors="surrogateescape")
        self.assertEqual(decoded.encode("utf-8", errors="surrogateescape"), raw)
        hits = linkage.parser_hits(decoded.splitlines(), symbols=True)
        self.assertEqual(hits["blitz_html"]["count"], 1)
        self.assertEqual(hits["html5ever"]["count"], 0)


if __name__ == "__main__":
    unittest.main()
