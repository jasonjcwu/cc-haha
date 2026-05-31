#!/usr/bin/env python3
"""Judge hard6 candidate patches against issue context and gold patches."""

import argparse
import json
import os
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HARD6_PATH = ROOT / "question" / "eval" / "benchmark" / "hard6.json"
RESULTS_DIR = ROOT / "question" / "eval" / "results"

SYSTEM_PROMPT = """You are a strict SWE-bench patch judge.
Compare the candidate patch to the issue and gold reference. Judge behavior,
not textual similarity. Be conservative: a broad or risky patch is not fully
correct merely because it touches relevant files. Return JSON only."""


def extract_json(text: str) -> dict:
    decoder = json.JSONDecoder()
    for idx, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[idx:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return {}


def load_rows(paths: list[str]) -> list[dict]:
    rows = []
    for raw in paths:
        path = Path(raw)
        with path.open() as f:
            data = json.load(f)
        rows.extend(data if isinstance(data, list) else [data])
    return rows


def call_glm(prompt: str) -> dict:
    key = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY") or ""
    base_url = os.environ.get("ANTHROPIC_BASE_URL", "https://open.bigmodel.cn/api/anthropic")
    body = json.dumps({
        "model": "glm-5.1",
        "max_tokens": 900,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + "/v1/messages",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return {"error": f"HTTP {exc.code}: {detail[:300]}"}
    except Exception as exc:
        return {"error": str(exc)[:300]}
    text = "".join(block.get("text", "") for block in data.get("content", []))
    return {
        "judge": extract_json(text),
        "raw": text,
        "usage": data.get("usage") or {},
    }


def build_prompt(task: dict, row: dict) -> str:
    return f"""Evaluate this candidate patch.

INSTANCE: {task["instance_id"]}
ISSUE:
{task.get("problem_statement", "")}

CANDIDATE PATCH:
{row.get("patch", "")}

GOLD PRODUCTION PATCH:
{task.get("patch", "")}

GOLD TEST PATCH:
{task.get("test_patch", "")}

Return exactly this JSON shape:
{{
  "correctness": 0-10,
  "minimality": 0-10,
  "test_awareness": 0-10,
  "risk": "low" | "medium" | "high",
  "verdict": "pass" | "partial" | "fail",
  "reason": "one concise sentence"
}}"""


def print_summary(results: list[dict]) -> None:
    print("| Group | Task | Correct | Minimal | Tests | Risk | Verdict |")
    print("|---|---|---:|---:|---:|---|---|")
    for row in results:
        judge = row.get("judge") or {}
        print(
            f"| {row.get('group')} | {row.get('instance_id')} | "
            f"{judge.get('correctness', 0)} | {judge.get('minimality', 0)} | "
            f"{judge.get('test_awareness', 0)} | {judge.get('risk', '?')} | "
            f"{judge.get('verdict', 'error')} |"
        )

    groups = defaultdict(list)
    for row in results:
        groups[row.get("group")].append(row)
    print("\n## Group Summary")
    print("| Group | Tasks | Avg Correct | Avg Minimal | Avg Tests | Pass/Partial/Fail |")
    print("|---|---:|---:|---:|---:|---|")
    for group, rows in sorted(groups.items()):
        judged = [row.get("judge") or {} for row in rows]
        avg = lambda key: sum(float(j.get(key, 0) or 0) for j in judged) / len(judged)
        verdicts = [j.get("verdict", "error") for j in judged]
        counts = "/".join(str(verdicts.count(v)) for v in ("pass", "partial", "fail"))
        print(
            f"| {group} | {len(rows)} | {avg('correctness'):.1f} | "
            f"{avg('minimality'):.1f} | {avg('test_awareness'):.1f} | {counts} |"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", nargs="+", help="Result JSON files")
    parser.add_argument("--groups", nargs="*", default=None)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    tasks = {row["instance_id"]: row for row in json.loads(HARD6_PATH.read_text())}
    rows = load_rows(args.results)
    if args.groups:
        rows = [row for row in rows if row.get("group") in args.groups]

    results = []
    for index, row in enumerate(rows, 1):
        task = tasks.get(row.get("instance_id"))
        if not task:
            continue
        print(f"[{index}/{len(rows)}] {row.get('group')} {row.get('instance_id')}", flush=True)
        result = call_glm(build_prompt(task, row))
        results.append({
            "group": row.get("group"),
            "instance_id": row.get("instance_id"),
            "has_patch": bool(row.get("has_patch")),
            **result,
        })

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output = Path(args.output) if args.output else RESULTS_DIR / (
        "judge_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".json"
    )
    output.write_text(json.dumps(results, indent=2))
    print_summary(results)
    print(f"\nSaved: {output}")


if __name__ == "__main__":
    main()
