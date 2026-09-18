#!/usr/bin/env python3
"""Inspect completed parser-runtime builds; never invoke a build or executable."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


PARSERS = ("blitz_html", "html5ever", "xml5ever")
TARGET = "aarch64-apple-darwin"
ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "experiments/compiled-ui-runtime/Cargo.toml"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def identity(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def parser_hits(lines, symbols=False):
    hits = {}
    for parser in PARSERS:
        # Inspect only symbol records or object/archive paths, never arbitrary
        # warnings. Raw Rust mangling embeds identifiers after their lengths.
        pattern = (r"(?:\b" + parser + r"::|[0-9]+" + parser + r"(?:[0-9_]|\b))") if symbols else (
            r"(?<![A-Za-z0-9_])(?:lib)?" + parser + r"(?=[\-.:/(\s]|$)")
        matches = [line for line in lines if re.search(pattern, line)]
        hits[parser] = {"count": len(matches), "excerpts": matches[:8]}
    return hits


def build_records(text):
    records = []
    # Cargo environment values may contain literal newlines. A Running record
    # ends at its closing backtick, not at the first physical log line.
    commands = re.findall(r"^[ \t]*Running `.*?`[ \t]*$", ANSI.sub("", text), re.MULTILINE | re.DOTALL)
    for command in commands:
        if not re.search(r"(?:[/\s`])rustc(?:\s|`)", command):
            continue
        match = re.search(r"--crate-name\s+([A-Za-z0-9_]+)", command)
        if match:
            records.append({"crate": match.group(1), "command": command.strip()})
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for variant in ("enabled", "disabled"):
        for name in ("exe", "target-dir", "link-map"):
            parser.add_argument("--" + variant + "-" + name, type=Path, required=True)
        parser.add_argument("--" + variant + "-build-log", type=Path, required=True, action="append",
                            help="Repeat in chronological order for an initial attempt and resumed build.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    require(sys.platform == "darwin", "This proof harness requires Darwin Mach-O tools.")
    output = args.out.resolve()
    output.mkdir()
    report = {"status": "running", "target": TARGET, "manifest": identity(MANIFEST), "tools": [], "variants": {},
              "methodology": [
                  "Read-only inspection of completed artifacts; this script does not build or execute either runtime.",
                  "Cargo normal edges describe selected runtime dependencies; normal,build also includes host build dependencies. Neither is Cargo.lock or a dev/test closure.",
                  "Verbose Running rustc records count actual crate compilation invocations, not warnings, Compiling summaries or lockfile mentions.",
                  "Repeat build-log options to include every attempt when a fresh build was resumed. Missing earlier logs weaken provenance and must not be hidden.",
                  "Link-map object records and final nm symbol records supplement the resolved graphs and compilation logs. Symbol absence alone is not sufficient.",
                  "Link maps and nm output decode UTF-8 with surrogateescape to retain arbitrary symbol bytes losslessly; raw bytes/hashes remain authoritative. Other tool outputs and build logs use strict UTF-8.",
                  "Enabled positive controls require both parser crates in graph/compile records and linkage evidence for blitz_html and html5ever; xml5ever may be dead-stripped.",
                  "This report establishes no behavior, GPU compatibility or performance improvement; separate runtime and measurement evidence is required."]}

    def save():
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    def tool(label, command, env=None, decoding_errors="strict"):
        stdout = output / (label + "-stdout.txt")
        stderr = output / (label + "-stderr.txt")
        record = {"label": label, "command": command, "decoding": "utf-8/" + decoding_errors}
        report["tools"].append(record)
        with stdout.open("xb") as out, stderr.open("xb") as err:
            try:
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=out, stderr=err, timeout=120)
                record["exitCode"] = result.returncode
            finally:
                record["stdout"] = identity(stdout)
                record["stderr"] = identity(stderr)
                save()
        require(result.returncode == 0, "Tool failed: {}; see {}".format(label, stderr))
        return stdout.read_bytes().decode("utf-8", errors=decoding_errors)

    try:
        tool("rustc-version", ["rustc", "-Vv"])
        tool("cargo-version", ["cargo", "-V"])
        tool("clang-version", ["xcrun", "clang", "--version"])
        for name in ("nm", "otool", "size", "ld"):
            tool("tool-path-" + name, ["xcrun", "--find", name])
        for variant in ("enabled", "disabled"):
            exe = getattr(args, variant + "_exe").resolve()
            target_dir = getattr(args, variant + "_target_dir").resolve()
            link_map = getattr(args, variant + "_link_map").resolve()
            logs = [path.resolve() for path in getattr(args, variant + "_build_log")]
            require(target_dir.is_dir(), "Missing target directory: {}".format(target_dir))
            require(all(path.is_file() for path in [exe, link_map] + logs), "Missing artifact for " + variant)
            data = {"executable": identity(exe), "targetDirectory": str(target_dir), "linkMap": identity(link_map),
                    "buildLogs": [identity(path) for path in logs]}
            report["variants"][variant] = data
            build_text = "\n".join(path.read_text(encoding="utf-8", errors="strict") for path in logs)
            records = build_records(build_text)
            compiled = sorted({record["crate"] for record in records})
            require("threejs_compiled_ui_runtime" in compiled, "Missing actual final-runtime rustc invocation in supplied " + variant + " logs")
            require(re.search(r"Finished `release` profile", ANSI.sub("", build_text)), "No successful release completion in " + variant + " logs")
            rustc_records = output / (variant + "-rustc-records.json")
            rustc_records.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
            data["rustcRecords"] = identity(rustc_records)
            data["compiledCrates"] = compiled
            data["parserCompilationRecords"] = {name: {"count": sum(record["crate"] == name for record in records),
                "excerpts": [record["command"][:500] for record in records if record["crate"] == name][:3]} for name in PARSERS}
            feature_args = [] if variant == "enabled" else ["--no-default-features"]
            env = dict(os.environ, CARGO_TARGET_DIR=str(target_dir))
            selected = {}
            for edge in ("normal", "normal,build"):
                graph = tool(variant + "-tree-" + edge.replace(",", "-"), ["cargo", "tree", "--offline", "--locked", "--manifest-path", str(MANIFEST),
                    "--target", TARGET, "-e", edge, "--prefix", "none", "--format", "{p}"] + feature_args, env)
                packages = sorted({match.group(1).replace("-", "_") for line in graph.splitlines()
                                   if (match := re.match(r"^([A-Za-z0-9_-]+) v[0-9]", line))})
                require("threejs_compiled_ui_runtime_experiment" in packages, "Graph did not include the selected runtime")
                selected[edge] = packages
            data["selectedPackageClosure"] = selected
            map_text = link_map.read_bytes().decode("utf-8", errors="surrogateescape")
            path_match = re.search(r"^# Path:\s*(.+)$", map_text, re.MULTILINE)
            require(path_match, "Missing link-map output identity")
            mapped_exe = Path(path_match.group(1)).resolve()
            require(mapped_exe.is_relative_to(target_dir), "Link map belongs to a different target directory")
            require(mapped_exe.is_file() and identity(mapped_exe)["sha256"] == data["executable"]["sha256"], "Link-map output does not match supplied executable")
            require(re.search(r"^# Arch:\s*arm64\s*$", map_text, re.MULTILINE), "Link map is not arm64")
            object_match = re.search(r"^# Object files:\s*\n(.*?)(?=^#|\Z)", map_text, re.MULTILINE | re.DOTALL)
            require(object_match, "Missing linker object-file records")
            objects = [line for line in object_match.group(1).splitlines() if re.match(r"^\[\s*\d+\]", line)]
            require(objects, "Empty link-map object list")
            data["linkObjects"] = {"count": len(objects), "parserHits": parser_hits(objects)}
            nm_text = tool(variant + "-nm", ["xcrun", "nm", "--defined-only", str(exe)], decoding_errors="surrogateescape")
            symbol_lines = [line for line in nm_text.splitlines() if re.match(r"^[0-9a-fA-F]+\s+[A-Za-z]\s+\S", line)]
            require(symbol_lines, "No defined symbols; provide unstripped proof artifact")
            data["definedSymbols"] = {"count": len(symbol_lines), "parserHits": parser_hits(symbol_lines, symbols=True)}
            tool(variant + "-otool-libraries", ["xcrun", "otool", "-L", str(exe)])
            tool(variant + "-size", ["xcrun", "size", "-m", str(exe)])
            file_text = tool(variant + "-file", ["/usr/bin/file", str(exe)])
            require("Mach-O 64-bit executable arm64" in file_text, "Unexpected executable architecture/type")
            for name in PARSERS:
                graph_present = name in selected["normal"] or name in selected["normal,build"]
                compiled_present = name in compiled
                linked_present = data["linkObjects"]["parserHits"][name]["count"] > 0 or data["definedSymbols"]["parserHits"][name]["count"] > 0
                if variant == "disabled":
                    require(not (graph_present or compiled_present or linked_present), "Disabled variant retains parser evidence: " + name)
                elif name != "xml5ever":
                    require(name in selected["normal"] and compiled_present and linked_present, "Missing enabled positive control for " + name)
            for entry in [data["executable"], data["linkMap"]] + data["buildLogs"]:
                require(identity(Path(entry["path"])) == entry, "Input changed during proof collection: " + entry["path"])
            save()
        require(report["variants"]["enabled"]["targetDirectory"] != report["variants"]["disabled"]["targetDirectory"], "Proof requires separate target directories")
        report["status"] = "passed"
        save()
        print(json.dumps({"status": "passed", "report": str(output / "report.json")}))
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = str(error)
        save()
        raise


if __name__ == "__main__":
    main()
