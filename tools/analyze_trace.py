#!/usr/bin/env python3
"""Chrome trace analyzer — focused window + merged cpuProfile."""
import gzip
import json
import sys
from collections import defaultdict

path = sys.argv[1] if len(sys.argv) > 1 else r"c:\Users\Aleksandr\Downloads\Trace-20260702T043726.json.gz"

with gzip.open(path, "rt", encoding="utf-8") as f:
    data = json.load(f)

events = data["traceEvents"]
meta = data.get("metadata", {})

win = meta.get("modifications", {}).get("initialBreadcrumb", {}).get("window")
if win:
    t0, t1 = win["min"], win["max"]
    print(f"=== WINDOW: {(t1 - t0) / 1e6:.2f}s ===")
else:
    ts_vals = [e["ts"] for e in events if "ts" in e]
    t0, t1 = min(ts_vals), max(ts_vals)
    print(f"=== FULL TRACE: {(t1 - t0) / 1e6:.2f}s ===")

window_us = t1 - t0

def in_window(e):
    ts = e.get("ts")
    return ts is not None and t0 <= ts <= t1

filtered = [e for e in events if in_window(e)]

# --- GC ---
minor = major = 0
minor_n = major_n = 0
for e in filtered:
    if e.get("ph") != "X":
        continue
    n, d = e.get("name"), e.get("dur", 0)
    if n == "MinorGC":
        minor_n += 1
        minor += d
    elif n == "MajorGC":
        major_n += 1
        major += d

print(f"\n=== GC ===")
print(f"  MinorGC: {minor_n}x, {minor / 1000:.1f}ms ({100 * minor / window_us:.2f}%)")
print(f"  MajorGC: {major_n}x, {major / 1000:.1f}ms ({100 * major / window_us:.2f}%)")
print(f"  => ~{minor_n / (window_us / 1e6):.1f} minor collections/sec")

# --- FunctionCall (args.data) ---
fc = defaultdict(lambda: {"count": 0, "dur": 0})
for e in filtered:
    if e.get("name") != "FunctionCall" or e.get("ph") != "X":
        continue
    d = e.get("args", {}).get("data", {})
    if not isinstance(d, dict):
        continue
    fn = d.get("functionName") or "?"
    url = (d.get("url") or "").split("/")[-1]
    line = d.get("lineNumber", "?")
    key = f"{fn} @ {url}:{line}"
    fc[key]["count"] += 1
    fc[key]["dur"] += e.get("dur", 0)

print(f"\n=== JS HOT (FunctionCall wall time) ===")
for k, s in sorted(fc.items(), key=lambda x: -x[1]["dur"])[:30]:
    print(f"  {s['dur'] / 1000:8.1f}ms ({100 * s['dur'] / window_us:5.1f}%)  {s['count']:5d}x  {k}")

# --- Merge cpuProfile from ProfileChunk ---
nodes = {}
parent = {}
samples = []
time_deltas = []

for e in filtered:
    if e.get("name") != "ProfileChunk":
        continue
    chunk = e.get("args", {}).get("data", {})
    if not isinstance(chunk, dict):
        continue
    cp = chunk.get("cpuProfile") or chunk
    if not isinstance(cp, dict):
        continue
    for node in cp.get("nodes", []) or []:
        nid = node.get("id")
        if nid is None:
            continue
        cf = node.get("callFrame") or {}
        nodes[nid] = {
            "fn": cf.get("functionName", "(anonymous)"),
            "url": cf.get("url", ""),
            "line": cf.get("lineNumber", 0),
        }
        pid = node.get("parent")
        if pid is not None:
            parent[nid] = pid
    ids = cp.get("samples") or []
    td = chunk.get("timeDeltas") or cp.get("timeDeltas") or []
    if ids:
        if not td:
            td = [1000] * len(ids)  # 1ms default tick
        elif len(td) < len(ids):
            td = td + [td[-1]] * (len(ids) - len(td))
        samples.extend(ids)
        time_deltas.extend(td[: len(ids)])

print(f"\n=== CPU PROFILE (sampled) ===")
print(f"  nodes: {len(nodes)}, samples: {len(samples)}")

if samples:
    total_sample_us = sum(time_deltas)
    leaf_self = defaultdict(int)
    inclusive = defaultdict(int)

    for sid, dt in zip(samples, time_deltas):
        leaf_self[sid] += dt
        cur = sid
        seen = set()
        while cur is not None and cur not in seen:
            inclusive[cur] += dt
            seen.add(cur)
            cur = parent.get(cur)

    def label(nid):
        n = nodes.get(nid, {})
        url = n.get("url", "")
        short = url.split("/")[-1] if url else ""
        fn = n.get("fn", "?")
        if short:
            return f"{fn} @ {short}:{n.get('line', 0)}"
        return fn

    print(f"  sampled: {total_sample_us / 1000:.1f}ms")

    print(f"\n  TOP SELF:")
    for nid, t in sorted(leaf_self.items(), key=lambda x: -x[1])[:45]:
        if label(nid) == "(root)":
            continue
        print(f"    {t / 1000:7.1f}ms ({100 * t / total_sample_us:4.1f}%)  {label(nid)}")

    print(f"\n  TOP INCLUSIVE:")
    for nid, t in sorted(inclusive.items(), key=lambda x: -x[1])[:25]:
        if label(nid) == "(root)":
            continue
        print(f"    {t / 1000:7.1f}ms ({100 * t / total_sample_us:4.1f}%)  {label(nid)}")

    emu = []
    for nid, t in leaf_self.items():
        lab = label(nid).lower()
        url = nodes.get(nid, {}).get("url", "").lower()
        if any(k in lab or k in url for k in (
            "gpu", "psx", "gte", "cdrom", "compiler", "block", "triangle",
            "render", "blend", "texel", "joypad", "dma", "spu", "memory", "tick", "frame",
        )):
            emu.append((t, label(nid)))
    if emu:
        print(f"\n  EMULATOR (self):")
        for t, lab in sorted(emu, key=lambda x: -x[0])[:35]:
            print(f"    {t / 1000:7.1f}ms  {lab}")

# --- rAF ---
af = [e["dur"] for e in filtered if e.get("name") == "FireAnimationFrame" and e.get("ph") == "X"]
if af:
    print(f"\n=== FRAMES ===")
    print(f"  rAF: {len(af)} frames, avg {sum(af) / len(af) / 1000:.2f}ms, max {max(af) / 1000:.2f}ms")
    print(f"  >16ms: {sum(1 for d in af if d > 16000)} ({100 * sum(1 for d in af if d > 16000) / len(af):.1f}%)")
    print(f"  >8ms:  {sum(1 for d in af if d > 8000)} ({100 * sum(1 for d in af if d > 8000) / len(af):.1f}%)")

# --- MinorGC vs rAF correlation ---
gc_ts = sorted(e["ts"] for e in filtered if e.get("name") == "MinorGC" and e.get("ph") == "X")
raf_ts = sorted(e["ts"] for e in filtered if e.get("name") == "FireAnimationFrame" and e.get("ph") == "X")
if gc_ts and raf_ts:
    near = 0
    for g in gc_ts:
        # GC within 2ms after a frame start
        for r in raf_ts:
            if 0 <= g - r <= 2000:
                near += 1
                break
    print(f"\n=== GC TIMING ===")
    print(f"  MinorGC within 2ms after rAF: {near}/{minor_n} ({100 * near / minor_n:.0f}%)")
