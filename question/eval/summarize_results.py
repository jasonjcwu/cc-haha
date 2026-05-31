#!/usr/bin/env python3
"""Summarize advisor eval JSON results.

This is intentionally deterministic. It gives quick comparable signals before
running a slower LLM judge or full SWE-bench Docker validation.
"""

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HARD6_PATH = ROOT / "question" / "eval" / "benchmark" / "hard6.json"


def load_hard6_gold_files() -> dict:
    with open(HARD6_PATH) as f:
        tasks = json.load(f)
    gold = {}
    for task in tasks:
        files = set()
        for line in (task.get("patch") or "").splitlines():
            if line.startswith("diff --git "):
                files.add(line.split(" b/", 1)[-1])
        for line in (task.get("test_patch") or "").splitlines():
            if line.startswith("diff --git "):
                files.add(line.split(" b/", 1)[-1])
        gold[task["instance_id"]] = files
    return gold


def patch_files(patch: str) -> list[str]:
    files = []
    for line in (patch or "").splitlines():
        if line.startswith("diff --git "):
            files.append(line.split(" b/", 1)[-1])
    return files


def token_total(usage: dict) -> int:
    return sum(usage.get(k, 0) or 0 for k in (
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ))


def row_metrics(row: dict, gold_files: dict) -> dict:
    files = patch_files(row.get("patch") or "")
    file_set = set(files)
    gold_set = gold_files.get(row.get("instance_id"), set())
    overlap = len(file_set & gold_set)
    precision = overlap / len(file_set) if file_set else 0
    recall = overlap / len(gold_set) if gold_set else 0
    test_files = [f for f in files if "test" in f.lower()]
    usage = row.get("usage") or {}
    executor_usage = row.get("executor_usage") or usage
    advisor_usage = row.get("advisor_usage") or {}
    wall = row.get("total_wall_seconds", row.get("wall_seconds", 0)) or 0
    advisor_calls = len(row.get("advisor_calls", []))
    phases = row.get("phases", [])
    timeouts = sum(1 for phase in phases if phase.get("error") == "timeout")
    if row.get("error") == "timeout" and not phases:
        timeouts = 1
    return {
        "group": row.get("group"),
        "instance_id": row.get("instance_id"),
        "executor_model": row.get("executor_model"),
        "advisor_model": row.get("advisor_model"),
        "has_patch": bool(row.get("has_patch")),
        "wall_seconds": round(wall, 1),
        "total_cost_usd": row.get("total_cost_usd", 0) or 0,
        "total_tokens": token_total(usage),
        "executor_tokens": token_total(executor_usage),
        "advisor_tokens": token_total(advisor_usage),
        "advisor_calls": advisor_calls,
        "turns": len(phases),
        "timeouts": timeouts,
        "patch_len": row.get("patch_len", len(row.get("patch") or "")),
        "patch_files": len(files),
        "test_files": len(test_files),
        "gold_files": len(gold_set),
        "gold_overlap": overlap,
        "gold_precision": round(precision, 3),
        "gold_recall": round(recall, 3),
        "files": files,
    }


def load_results(paths: list[str]) -> list[dict]:
    rows = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            paths_in_dir = sorted(path.glob("all_*.json"))
        else:
            paths_in_dir = [path]
        for p in paths_in_dir:
            with open(p) as f:
                data = json.load(f)
            if isinstance(data, list):
                for row in data:
                    row = dict(row)
                    row["_source"] = str(p)
                    rows.append(row)
            else:
                data["_source"] = str(p)
                rows.append(data)
    return rows


def print_markdown(metrics: list[dict]) -> None:
    headers = [
        "Group", "Task", "Patch", "Time", "Tokens", "Cost",
        "Advisor", "Files", "Gold P/R", "Tests", "Timeouts",
    ]
    print("| " + " | ".join(headers) + " |")
    print("|" + "|".join(["---"] * len(headers)) + "|")
    for m in metrics:
        gold = f"{m['gold_precision']:.2f}/{m['gold_recall']:.2f}"
        advisor = f"{m['advisor_calls']} ({m['advisor_tokens']})"
        print(
            "| "
            + " | ".join([
                str(m["group"]),
                str(m["instance_id"]),
                "Y" if m["has_patch"] else "N",
                str(m["wall_seconds"]),
                str(m["total_tokens"]),
                f"{m['total_cost_usd']:.6f}",
                advisor,
                str(m["patch_files"]),
                gold,
                str(m["test_files"]),
                str(m["timeouts"]),
            ])
            + " |"
        )

    print("\n## Group Summary")
    groups = {}
    for m in metrics:
        groups.setdefault(m["group"], []).append(m)
    print("| Group | Patch Rate | Advisor Call Rate | Avg Time | Avg Tokens | Avg Files | Avg Gold Recall | Timeouts |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|")
    for group, rows in sorted(groups.items()):
        n = len(rows)
        patch_rate = sum(1 for r in rows if r["has_patch"])
        called = sum(1 for r in rows if r["advisor_calls"] > 0)
        print(
            f"| {group} | {patch_rate}/{n} | {called}/{n} | "
            f"{sum(r['wall_seconds'] for r in rows)/n:.1f} | "
            f"{sum(r['total_tokens'] for r in rows)/n:.0f} | "
            f"{sum(r['patch_files'] for r in rows)/n:.1f} | "
            f"{sum(r['gold_recall'] for r in rows)/n:.2f} | "
            f"{sum(r['timeouts'] for r in rows)} |"
        )

    families = {}
    for m in metrics:
        group = m["group"] or ""
        if group.startswith("GLM-Air"):
            families.setdefault("GLM-Air", {})[group] = groups[group]
        elif group.startswith("GLM-Turbo"):
            families.setdefault("GLM-Turbo", {})[group] = groups[group]

    comparisons = []
    for family, family_groups in sorted(families.items()):
        solo_group = next((g for g in family_groups if g.endswith("-Solo")), None)
        injected_group = next((g for g in family_groups if "Injected" in g), None)
        if not solo_group or not injected_group:
            continue
        solo_rows = family_groups[solo_group]
        injected_rows = family_groups[injected_group]
        shared = sorted(
            {r["instance_id"] for r in solo_rows}
            & {r["instance_id"] for r in injected_rows}
        )
        if not shared:
            continue
        solo_by_id = {r["instance_id"]: r for r in solo_rows}
        injected_by_id = {r["instance_id"]: r for r in injected_rows}
        solo_shared = [solo_by_id[i] for i in shared]
        injected_shared = [injected_by_id[i] for i in shared]
        comparisons.append((family, solo_shared, injected_shared))

    if comparisons:
        print("\n## Solo vs Injected")
        print("| Family | Tasks | Patch Delta | Time Delta | Token Delta | Gold Recall Delta |")
        print("|---|---:|---:|---:|---:|---:|")
        for family, solo_rows, injected_rows in comparisons:
            n = len(solo_rows)
            solo_patch = sum(1 for r in solo_rows if r["has_patch"])
            injected_patch = sum(1 for r in injected_rows if r["has_patch"])
            solo_time = sum(r["wall_seconds"] for r in solo_rows) / n
            injected_time = sum(r["wall_seconds"] for r in injected_rows) / n
            solo_tokens = sum(r["total_tokens"] for r in solo_rows) / n
            injected_tokens = sum(r["total_tokens"] for r in injected_rows) / n
            solo_recall = sum(r["gold_recall"] for r in solo_rows) / n
            injected_recall = sum(r["gold_recall"] for r in injected_rows) / n
            print(
                f"| {family} | {n} | {injected_patch - solo_patch:+d} | "
                f"{injected_time - solo_time:+.1f}s | "
                f"{injected_tokens - solo_tokens:+.0f} | "
                f"{injected_recall - solo_recall:+.2f} |"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", nargs="+", help="Result JSON files or directories")
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args()

    gold_files = load_hard6_gold_files()
    rows = load_results(args.results)
    metrics = [row_metrics(row, gold_files) for row in rows]
    print_markdown(metrics)

    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(metrics, f, indent=2)


if __name__ == "__main__":
    main()
