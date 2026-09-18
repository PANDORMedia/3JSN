#!/usr/bin/env python3
"""Paired warm-cache measurements of two prebuilt parser-runtime variants."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import statistics
import subprocess
import sys
import threading
import time


TIMEOUT_SECONDS = 30
WARMUPS = 3
ROUNDS = 20
METRICS = ("parentLifecycleNanoseconds", "initializationNanoseconds", "peakResidentBytes")


def identity(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def run_child(command, stdout_path, stderr_path, timeout=TIMEOUT_SECONDS):
    """Measure a Darwin child; its wait4 resident-set value is in bytes."""
    if sys.platform != "darwin":
        raise RuntimeError("Darwin only: child measurement requires macOS wait4 byte units")
    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        started = time.monotonic_ns()
        process = subprocess.Popen(command, stdout=stdout, stderr=stderr, start_new_session=True)
        state = {"reaped": False, "timedOut": False}
        lock = threading.Lock()

        def kill_group():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

        def expired():
            with lock:
                if not state["reaped"]:
                    state["timedOut"] = True
                    kill_group()

        watchdog = threading.Timer(timeout, expired)
        watchdog.daemon = True
        try:
            watchdog.start()
            _, status, usage = os.wait4(process.pid, 0)
            ended = time.monotonic_ns()
            with lock:
                state["reaped"] = True
            process.returncode = os.waitstatus_to_exitcode(status)
            if state["timedOut"]:
                raise RuntimeError("Child exceeded {:.3f}s timeout: {}".format(timeout, command[0]))
            if process.returncode != 0:
                raise RuntimeError("Child exited {}: {}; see {}".format(process.returncode, command[0], stderr_path))
            return {"parentLifecycleNanoseconds": ended - started, "peakResidentBytes": usage.ru_maxrss}
        finally:
            watchdog.cancel()
            with lock:
                if not state["reaped"]:
                    kill_group()
                    try:
                        _, status, _ = os.wait4(process.pid, 0)
                        process.returncode = os.waitstatus_to_exitcode(status)
                    except ChildProcessError:
                        pass
                    state["reaped"] = True
            if watchdog.ident is not None:
                watchdog.join()


def read_measurement(path, dynamic_html):
    records = []
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip().startswith("{"):
                continue
            value = json.loads(line)
            if isinstance(value, dict) and "layoutMeasurement" in value:
                records.append(value)
    if len(records) != 1:
        raise ValueError("Expected exactly one layoutMeasurement record in {}".format(path))
    record = records[0]
    if record.get("layoutMeasurement") is not True or record.get("dynamicHtml") is not dynamic_html:
        raise ValueError("Unexpected measurement variant in {}".format(path))
    if record.get("gpuDeviceRequested") is not False or record.get("verification") is not None:
        raise ValueError("Measurement must omit verification and GPU requests: {}".format(path))
    elapsed = record.get("initializationNanoseconds")
    if type(elapsed) is not int or elapsed < 0 or not isinstance(record.get("initial"), dict):
        raise ValueError("Missing or invalid initialization/snapshot fields in {}".format(path))
    return record


def spread(values):
    return {"count": len(values), "minimum": min(values), "median": statistics.median(values),
            "maximum": max(values), "mean": statistics.mean(values), "sampleStdDev": statistics.stdev(values)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("enabled", "disabled", "ir", "font", "behavior", "output"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Darwin only: wait4 ru_maxrss is recorded in macOS bytes.")
    paths = {key: getattr(args, key).resolve() for key in ("enabled", "disabled", "ir", "font", "behavior")}
    for path in paths.values():
        if not path.is_file():
            parser.error("Input must be a regular file: {}".format(path))
    if paths["enabled"] == paths["disabled"]:
        parser.error("Enabled and disabled executable paths must differ.")
    output = args.output.resolve()
    output.mkdir()
    inputs = {key: identity(path) for key, path in paths.items()}
    samples = []
    baseline = None
    baseline_set = False
    previous_handler = signal.getsignal(signal.SIGTERM)

    def interrupted(signum, frame):
        raise KeyboardInterrupt("Interrupted by signal {}".format(signum))

    signal.signal(signal.SIGTERM, interrupted)
    try:
        for phase, count in (("warmup", WARMUPS), ("measured", ROUNDS)):
            for round_index in range(count):
                variants = ("enabled", "disabled") if round_index % 2 == 0 else ("disabled", "enabled")
                for order, variant in enumerate(variants):
                    label = "{}-{:02d}-{}".format(phase, round_index + 1, variant)
                    stdout = output / (label + "-stdout.txt")
                    stderr = output / (label + "-stderr.txt")
                    command = [str(paths[variant]), "--measure-layout", str(paths["ir"]), str(paths["font"]), str(paths["behavior"])]
                    sample = {"phase": phase, "round": round_index + 1, "order": order + 1,
                              "variant": variant, "command": command, "stdout": stdout.name, "stderr": stderr.name}
                    samples.append(sample)
                    sample.update(run_child(command, stdout, stderr))
                    record = read_measurement(stdout, variant == "enabled")
                    sample["measurement"] = record
                    sample["initializationNanoseconds"] = record["initializationNanoseconds"]
                    if not baseline_set:
                        baseline, baseline_set = json.dumps(record["initial"], sort_keys=True, allow_nan=False), True
                    if json.dumps(record["initial"], sort_keys=True, allow_nan=False) != baseline:
                        raise ValueError("Initial snapshot mismatch: {}".format(label))
                    if sample["initializationNanoseconds"] > sample["parentLifecycleNanoseconds"] or sample["peakResidentBytes"] <= 0:
                        raise ValueError("Inconsistent timing/RSS measurement: {}".format(label))
                    sample["snapshotMatches"] = True
                    write_json(output / (label + ".json"), sample)
        final_inputs = {key: identity(path) for key, path in paths.items()}
        if inputs != final_inputs:
            raise ValueError("Executable or input identity changed during measurements.")
        measured = [sample for sample in samples if sample["phase"] == "measured"]
        summaries = {variant: {metric: spread([s[metric] for s in measured if s["variant"] == variant])
                               for metric in METRICS} for variant in ("enabled", "disabled")}
        pairs = []
        for round_index in range(1, ROUNDS + 1):
            pair = {sample["variant"]: sample for sample in measured if sample["round"] == round_index}
            pairs.append({"round": round_index, **{metric: pair["disabled"][metric] - pair["enabled"][metric] for metric in METRICS}})
        report = {"status": "completed", "host": {"platform": platform.platform(), "machine": platform.machine(),
                    "python": platform.python_version()}, "inputs": inputs, "samples": samples, "summary": summaries,
                  "pairedDifferencesDisabledMinusEnabled": pairs,
                  "pairedDifferenceSummary": {metric: spread([pair[metric] for pair in pairs]) for metric in METRICS},
                  "methodology": {
                      "warmupsPerVariant": WARMUPS, "measuredPairs": ROUNDS, "timeoutSeconds": TIMEOUT_SECONDS,
                      "order": "Sequential pairs, enabled/disabled on odd rounds and disabled/enabled on even rounds.",
                      "parentLifecycleNanoseconds": "Monotonic duration before Popen through wait4 child termination; includes launch, initialization, reporting and teardown.",
                      "initializationNanoseconds": "Child main entry through IR, font, realm initialization and first layout snapshot, as reported by the runtime.",
                      "peakResidentBytes": "Darwin wait4 per-child lifetime maximum resident set size in bytes; not steady-state heap or private footprint.",
                      "scope": "Warm-cache local DOM/layout subset, no verification workload or GPU device request; not a cold-start or GPU benchmark.",
                      "comparability": "Caller supplies binaries from identical source/build settings except dynamic-html; this harness records identities but cannot prove build provenance.",
                      "interpretation": "Raw observations and descriptive paired statistics only; no speedup or general performance claim."}}
        write_json(output / "report.json", report)
        print(json.dumps({"status": "completed", "report": str(output / "report.json")}))
    except BaseException as error:
        write_json(output / "failure.json", {"status": "failed", "error": str(error), "inputs": inputs, "samples": samples})
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_handler)


if __name__ == "__main__":
    main()
