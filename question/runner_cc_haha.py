#!/usr/bin/env python3
"""
cc-haha CLI 评测入口

遍历 GLM 主实验 + DeepSeek 辅助实验配置 × hard6 题，输出结果 JSONL。
Usage:
  python3 question/runner_cc_haha.py --mode solo --model ds --limit 1
  python3 question/runner_cc_haha.py --mode all --model both --limit 6
"""

import argparse
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime

QUESTION_DIR = os.path.dirname(__file__)
REPO_ROOT = os.path.dirname(QUESTION_DIR)

sys.path.insert(0, os.path.join(QUESTION_DIR, "eval"))

HARD6_PATH = os.path.join(QUESTION_DIR, "eval", "benchmark", "hard6.json")
RESULTS_DIR = os.path.join(QUESTION_DIR, "eval", "results")
CC_HAHA_PATH = os.path.join(REPO_ROOT, "bin", "claude-haha")
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")


def load_instances(limit=None):
    with open(HARD6_PATH) as f:
        instances = json.load(f)
    return instances[:limit] if limit else instances


def run_with_env(env_script: str, cmd: list, instance: dict, timeout: int) -> dict:
    """Run a Python runner script under a specific env (DS or GLM)."""
    quoted_cmd = " ".join(shlex.quote(part) for part in cmd)
    full_cmd = [
        "bash", "-c",
        f"source {shlex.quote(env_script)} && python3 -u {quoted_cmd}"
    ]
    result = subprocess.run(
        full_cmd, capture_output=True, text=True, timeout=timeout,
    )
    stdout = result.stdout or ""
    stderr = result.stderr or ""

    # Parse JSON output. Child runners print progress before a final pretty JSON
    # object, so line-by-line parsing is too brittle.
    decoder = json.JSONDecoder()
    for idx, char in enumerate(stdout):
        if char != "{":
            continue
        try:
            parsed, end = decoder.raw_decode(stdout[idx:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and not stdout[idx + end:].strip():
            return parsed

    return {"instance_id": instance.get("instance_id", "?"),
            "error": f"no JSON output", "stdout_preview": stdout[-300:], "stderr_preview": stderr[-300:]}


def run_all(configs: list, limit: int = 6, repeats: int = 1,
            force_pre_final_review: bool = False, label_contains: str = ""):
    instances = load_instances(limit)
    os.makedirs(RESULTS_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    all_results = []

    for config in configs:
        model = config["model"]  # "ds" or "glm"
        mode = config["mode"]    # "solo" or "injected"
        label = config["label"]  # e.g. "A-DS-Solo", "C-DS-Injected"
        if label_contains and label_contains not in label:
            continue
        executor_model = config.get("executor_model")
        advisor_model = config.get("advisor_model")
        env_script = os.path.join(SCRIPTS_DIR, f"set-env-{model}.sh")
        group_workdir = os.path.join("/tmp", "cc-haha-swe", "runs", ts, label)

        if not os.path.exists(env_script):
            print(f"⚠️  Skipping {label}: {env_script} not found")
            continue

        print(f"\n{'='*60}")
        print(f"  [{label}] {model.upper()} {mode}")
        if executor_model or advisor_model:
            print(f"  executor={executor_model or 'settings default'} advisor={advisor_model or '-'}")
        print(f"{'='*60}")

        for repeat in range(1, repeats + 1):
            for i, inst in enumerate(instances):
                iid = inst["instance_id"]
                print(f"\n  [repeat {repeat}/{repeats}] [{i+1}/{len(instances)}] {iid}")

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
                    "--workdir", os.path.join(group_workdir, f"repeat-{repeat}"),
                ]
                if executor_model:
                    cmd.extend(["--executor-model", executor_model])
                if mode == "injected":
                    cmd.extend(["--advisor-model", advisor_model])
                    if force_pre_final_review:
                        cmd.append("--force-pre-final-review")

                result = run_with_env(env_script, cmd, inst, timeout=900)

                has_patch = result.get("has_patch", False)
                status = "✓ patch" if has_patch else "✗ no patch"
                time_s = result.get("total_wall_seconds", result.get("wall_seconds", 0))
                error = result.get("error", "")
                print(f"      {status} | {time_s}s" + (f" | err: {error}" if error else ""))

                result["group"] = label
                result["model"] = model
                result["executor_model"] = executor_model
                result["advisor_model"] = advisor_model
                result["mode"] = mode
                result["repeat"] = repeat
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

    print(f"\n{'组':<24} {'Patches':<10} {'Time':<10} {'Tokens':<10} {'Cost':<10}")
    print("-" * 68)
    for g, rs in sorted(groups.items()):
        patches = sum(1 for r in rs if r.get("has_patch"))
        total_t = sum(r.get("total_wall_seconds", r.get("wall_seconds", 0)) for r in rs)
        total_tokens = sum(
            sum((r.get("usage") or {}).get(k, 0) or 0 for k in (
                "input_tokens",
                "output_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            ))
            for r in rs
        )
        total_cost = sum(r.get("total_cost_usd", 0) or 0 for r in rs)
        print(f"{g:<24} {patches}/{len(rs):<5} {total_t:.0f}s      {total_tokens:<10} ${total_cost:.6f}")

    print(f"\n📁 结果已保存到: {RESULTS_DIR}/")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["solo", "injected", "all"], default="all")
    parser.add_argument("--model", choices=["ds", "glm", "both"], default="both")
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--force-pre-final-review", action="store_true")
    parser.add_argument("--label-contains", default="")
    args = parser.parse_args()

    configs = []

    # Solo modes
    if args.mode in ("solo", "all"):
        if args.model in ("ds", "both"):
            configs.append({
                "model": "ds",
                "mode": "solo",
                "label": "DS-Flash-Solo",
                "executor_model": "haiku",
                "advisor_model": None,
            })
        if args.model in ("glm", "both"):
            configs.append({
                "model": "glm",
                "mode": "solo",
                "label": "GLM-Air-Solo",
                "executor_model": "haiku",
                "advisor_model": None,
            })
            configs.append({
                "model": "glm",
                "mode": "solo",
                "label": "GLM-Turbo-Solo",
                "executor_model": "sonnet",
                "advisor_model": None,
            })

    # Injected modes
    if args.mode in ("injected", "all"):
        if args.model in ("ds", "both"):
            configs.append({
                "model": "ds",
                "mode": "injected",
                "label": "DS-Flash-Pro-Injected",
                "executor_model": "haiku",
                "advisor_model": "deepseek",
            })
        if args.model in ("glm", "both"):
            configs.append({
                "model": "glm",
                "mode": "injected",
                "label": "GLM-Air-5.1-Injected",
                "executor_model": "haiku",
                "advisor_model": "glm",
            })
            configs.append({
                "model": "glm",
                "mode": "injected",
                "label": "GLM-Turbo-5.1-Injected",
                "executor_model": "sonnet",
                "advisor_model": "glm",
            })

    run_all(
        configs,
        limit=args.limit,
        repeats=args.repeats,
        force_pre_final_review=args.force_pre_final_review,
        label_contains=args.label_contains,
    )


if __name__ == "__main__":
    main()
