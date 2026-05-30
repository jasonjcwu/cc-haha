#!/usr/bin/env python3
"""
cc-haha CLI 评测入口

遍历 6 组配置 × hard6 题，输出结果 JSONL。
Usage:
  source scripts/set-env-ds.sh && python3 question/eval/runner_cc_haha.py --mode solo --limit 1
  source scripts/set-env-glm.sh && python3 question/eval/runner_cc_haha.py --mode all --limit 6
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "eval"))

HARD6_PATH = os.path.join(os.path.dirname(__file__), "eval", "benchmark", "hard6.json")
RESULTS_DIR = os.path.join(os.path.dirname(__file__), "eval", "results")
CC_HAHA_PATH = os.path.join(os.path.dirname(__file__), "bin", "claude-haha")
SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "scripts")


def load_instances(limit=None):
    with open(HARD6_PATH) as f:
        instances = json.load(f)
    return instances[:limit] if limit else instances


def run_with_env(env_script: str, cmd: list, instance: dict, timeout: int) -> dict:
    """Run a Python runner script under a specific env (DS or GLM)."""
    full_cmd = [
        "bash", "-c",
        f"source {env_script} && python3 {' '.join(cmd)}"
    ]
    result = subprocess.run(
        full_cmd, capture_output=True, text=True, timeout=timeout,
    )
    stdout = result.stdout or ""
    stderr = result.stderr or ""

    # Parse JSON output (last JSON block in stdout)
    for line in reversed(stdout.strip().split("\n")):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            # Try finding JSON starting from {
            if line.strip().startswith("{"):
                try:
                    return json.loads(line.strip())
                except json.JSONDecodeError:
                    pass
            continue

    return {"instance_id": instance.get("instance_id", "?"),
            "error": f"no JSON output", "stdout_preview": stdout[-300:], "stderr_preview": stderr[-300:]}


def run_all(configs: list, limit: int = 6):
    instances = load_instances(limit)
    os.makedirs(RESULTS_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    all_results = []

    for config in configs:
        model = config["model"]  # "ds" or "glm"
        mode = config["mode"]    # "solo" or "injected"
        label = config["label"]  # e.g. "A-DS-Solo", "C-DS-Injected"
        env_script = os.path.join(SCRIPTS_DIR, f"set-env-{model}.sh")

        if not os.path.exists(env_script):
            print(f"⚠️  Skipping {label}: {env_script} not found")
            continue

        print(f"\n{'='*60}")
        print(f"  [{label}] {model.upper()} {mode}")
        print(f"{'='*60}")

        for i, inst in enumerate(instances):
            iid = inst["instance_id"]
            print(f"\n  [{i+1}/{len(instances)}] {iid}")

            runner_script = os.path.join(
                os.path.dirname(__file__), "eval",
                f"cc_haha_{mode}.py"
            )
            if not os.path.exists(runner_script):
                print(f"    ❌ runner not found: {runner_script}")
                continue

            cmd = [
                runner_script,
                "--instance-json", json.dumps(inst),
                "--timeout", "600",
            ]
            if mode == "injected":
                cmd.extend(["--advisor-model", model])

            result = run_with_env(env_script, cmd, inst, timeout=900)

            has_patch = result.get("has_patch", False)
            status = "✓ patch" if has_patch else "✗ no patch"
            time_s = result.get("total_wall_seconds", result.get("wall_seconds", 0))
            error = result.get("error", "")
            print(f"      {status} | {time_s}s" + (f" | err: {error}" if error else ""))

            result["group"] = label
            result["model"] = model
            result["mode"] = mode
            all_results.append(result)

        # 保存当前组
        group_file = os.path.join(RESULTS_DIR, f"{label}_{ts}.jsonl")
        group_results = [r for r in all_results if r.get("group") == label]
        with open(group_file, "w") as f:
            for r in group_results:
                f.write(json.dumps(r) + "\n")

        # 汇总
        patches = sum(1 for r in group_results if r.get("has_patch"))
        total_time = sum(r.get("total_wall_seconds", r.get("wall_seconds", 0)) for r in group_results)
        print(f"\n  📊 {label}: {patches}/{len(group_results)} patches | {total_time:.0f}s total")

    # 保存全部结果
    all_file = os.path.join(RESULTS_DIR, f"all_{ts}.json")
    with open(all_file, "w") as f:
        json.dump(all_results, f, indent=2)

    # 打印汇总表
    print(f"\n\n{'='*60}")
    print("  汇总")
    print(f"{'='*60}")
    groups = {}
    for r in all_results:
        g = r.get("group", "?")
        groups.setdefault(g, []).append(r)

    print(f"\n{'组':<15} {'Patches':<10} {'Time':<10}")
    print("-" * 35)
    for g, rs in sorted(groups.items()):
        patches = sum(1 for r in rs if r.get("has_patch"))
        total_t = sum(r.get("total_wall_seconds", r.get("wall_seconds", 0)) for r in rs)
        print(f"{g:<15} {patches}/{len(rs):<5} {total_t:.0f}s")

    print(f"\n📁 结果已保存到: {RESULTS_DIR}/")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["solo", "injected", "all"], default="all")
    parser.add_argument("--model", choices=["ds", "glm", "both"], default="both")
    parser.add_argument("--limit", type=int, default=6)
    args = parser.parse_args()

    configs = []

    # Solo modes
    if args.mode in ("solo", "all"):
        if args.model in ("ds", "both"):
            configs.append({"model": "ds", "mode": "solo", "label": "A-DS-Solo"})
            configs.append({"model": "ds", "mode": "solo", "label": "B-DS-Tool"})  # =Solo
        if args.model in ("glm", "both"):
            configs.append({"model": "glm", "mode": "solo", "label": "D-GLM-Solo"})
            configs.append({"model": "glm", "mode": "solo", "label": "E-GLM-Tool"})  # =Solo

    # Injected modes
    if args.mode in ("injected", "all"):
        if args.model in ("ds", "both"):
            configs.append({"model": "ds", "mode": "injected", "label": "C-DS-Injected"})
        if args.model in ("glm", "both"):
            configs.append({"model": "glm", "mode": "injected", "label": "F-GLM-Injected"})

    run_all(configs, limit=args.limit)


if __name__ == "__main__":
    main()
