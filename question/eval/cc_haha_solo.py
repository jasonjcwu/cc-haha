#!/usr/bin/env python3
"""
cc-haha CLI Solo Runner

Runs a single SWE-bench task through cc-haha CLI.
Usage: python3 cc_haha_solo.py --instance-json '{"instance_id":"...","repo":"...",...}'
       python3 cc_haha_solo.py --instance-json-file /path/to/instance.json
"""

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Optional

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))  # cc-haha project root
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prompt_templates import build_task_prompt, extract_patch


EMPTY_USAGE = {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
}


def parse_cli_json(stdout: str) -> dict:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return {
            "text": stdout,
            "usage": EMPTY_USAGE.copy(),
            "total_cost_usd": 0,
        }
    return {
        "text": data.get("result") or data.get("message") or stdout,
        "usage": data.get("usage") or EMPTY_USAGE.copy(),
        "total_cost_usd": data.get("total_cost_usd") or 0,
        "raw": data,
    }


def classify_cli_error(stdout: str, stderr: str, returncode: int) -> Optional[str]:
    if returncode == 0:
        return None
    combined = f"{stdout}\n{stderr}"
    if "rate_limit_error" in combined or "API Error: 429" in combined:
        return "rate_limit"
    return f"exit {returncode}"


def read_git_diff(repo_dir: str) -> str:
    """Return the current worktree diff when the CLI does not print one."""
    try:
        result = subprocess.run(
            ["git", "diff", "--no-ext-diff"],
            capture_output=True, text=True, cwd=repo_dir, timeout=30,
        )
    except Exception:
        return ""
    return result.stdout or ""


def run_solo(
    instance: dict,
    timeout: int = 600,
    workdir: str = "/tmp/cc-haha-swe",
    executor_model: Optional[str] = None,
) -> dict:
    """Run a single SWE-bench task through cc-haha CLI."""
    iid = instance["instance_id"]
    repo = instance.get("repo", "")
    base_commit = instance.get("base_commit", "")

    prompt = build_task_prompt(instance)

    # Prepare workdir
    repo_dir = os.path.join(workdir, iid.replace("/", "__"))
    os.makedirs(repo_dir, exist_ok=True)

    # Clone repo if needed
    setup_error = None
    if repo and base_commit and not os.path.exists(os.path.join(repo_dir, ".git")):
        cache_candidates = [
            os.path.join(os.path.dirname(workdir), iid.replace("/", "__")),
            os.path.join("/tmp", "cc-haha-swe", iid.replace("/", "__")),
        ]
        clone_url = f"https://github.com/{repo}.git"
        for cache_dir in cache_candidates:
            if cache_dir != repo_dir and os.path.exists(os.path.join(cache_dir, ".git")):
                clone_url = cache_dir
                break
        try:
            clone_result = subprocess.run(
                ["git", "clone", clone_url, repo_dir],
                capture_output=True, text=True, timeout=120,
            )
            if clone_result.returncode != 0:
                setup_error = f"git clone failed: {(clone_result.stderr or clone_result.stdout)[-300:]}"
            else:
                checkout_result = subprocess.run(
                    ["git", "checkout", base_commit],
                    capture_output=True, text=True, cwd=repo_dir, timeout=30,
                )
                if checkout_result.returncode != 0:
                    setup_error = f"git checkout failed: {(checkout_result.stderr or checkout_result.stdout)[-300:]}"
        except Exception as e:
            setup_error = f"repo setup failed: {e}"

    if repo and base_commit and not os.path.exists(os.path.join(repo_dir, ".git")):
        setup_error = setup_error or "repo setup failed: missing .git directory"

    if repo and base_commit and os.path.exists(os.path.join(repo_dir, ".git")):
        checkout_result = subprocess.run(
            ["git", "checkout", base_commit],
            capture_output=True, text=True, cwd=repo_dir, timeout=30,
        )
        if checkout_result.returncode != 0:
            setup_error = f"git checkout failed: {(checkout_result.stderr or checkout_result.stdout)[-300:]}"

    if setup_error:
        return {
            "instance_id": iid,
            "repo": repo,
            "mode": "solo",
            "executor_model": executor_model,
            "has_patch": False,
            "patch": "",
            "patch_len": 0,
            "wall_seconds": 0,
            "exit_code": -1,
            "stdout_preview": "",
            "stderr_preview": "",
            "error": setup_error,
        }

    # Build command
    cmd = [
        os.path.join(_ROOT, "bin", "claude-haha"),
        "--bare",
        "--output-format", "json",
    ]
    if executor_model:
        cmd.extend(["--model", executor_model])
    cmd.extend(["-p", prompt])

    env = os.environ.copy()
    # Must have ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY set

    start = time.time()
    try:
        result = subprocess.run(
            cmd, input="", capture_output=True, text=True,
            timeout=timeout, cwd=repo_dir, env=env,
        )
        elapsed = time.time() - start
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        parsed = parse_cli_json(stdout)
        output_text = parsed["text"]

        patch = read_git_diff(repo_dir) or extract_patch(output_text)
        has_patch = bool(patch and len(patch.strip()) > 10)
        error = classify_cli_error(output_text, stderr, result.returncode)
        if not error and not output_text.strip() and not patch.strip():
            error = "empty CLI output"

        return {
            "instance_id": iid,
            "repo": repo,
            "mode": "solo",
            "executor_model": executor_model,
            "has_patch": has_patch,
            "patch": patch,
            "patch_len": len(patch),
            "wall_seconds": round(elapsed, 1),
            "exit_code": result.returncode,
            "stdout_preview": output_text[-500:],
            "stderr_preview": stderr[-500:],
            "usage": parsed["usage"],
            "total_cost_usd": parsed["total_cost_usd"],
            "error": error,
        }

    except subprocess.TimeoutExpired:
        elapsed = time.time() - start
        return {
            "instance_id": iid,
            "repo": repo,
            "mode": "solo",
            "executor_model": executor_model,
            "has_patch": False,
            "patch": "",
            "patch_len": 0,
            "wall_seconds": round(elapsed, 1),
            "exit_code": -1,
            "usage": EMPTY_USAGE.copy(),
            "total_cost_usd": 0,
            "error": "timeout",
        }
    except Exception as e:
        elapsed = time.time() - start
        return {
            "instance_id": iid,
            "repo": repo,
            "mode": "solo",
            "executor_model": executor_model,
            "has_patch": False,
            "patch": "",
            "patch_len": 0,
            "wall_seconds": round(elapsed, 1),
            "exit_code": -1,
            "usage": EMPTY_USAGE.copy(),
            "total_cost_usd": 0,
            "error": str(e)[:200],
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance-json", type=str, default=None,
                        help="JSON string of the instance")
    parser.add_argument("--instance-json-file", type=str, default=None,
                        help="Path to JSON file with instance")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--workdir", type=str, default="/tmp/cc-haha-swe")
    parser.add_argument("--executor-model", type=str, default=None)
    args = parser.parse_args()

    if args.instance_json:
        instance = json.loads(args.instance_json)
    elif args.instance_json_file:
        with open(args.instance_json_file) as f:
            instance = json.load(f)
    else:
        print("Error: need --instance-json or --instance-json-file")
        sys.exit(1)

    result = run_solo(
        instance,
        timeout=args.timeout,
        workdir=args.workdir,
        executor_model=args.executor_model,
    )
    print(json.dumps(result, indent=2))
