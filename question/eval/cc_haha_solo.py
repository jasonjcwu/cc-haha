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

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))  # cc-haha project root
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prompt_templates import build_task_prompt, extract_patch


def run_solo(instance: dict, timeout: int = 600, workdir: str = "/tmp/cc-haha-swe") -> dict:
    """Run a single SWE-bench task through cc-haha CLI."""
    iid = instance["instance_id"]
    repo = instance.get("repo", "")
    base_commit = instance.get("base_commit", "")

    prompt = build_task_prompt(instance)

    # Prepare workdir
    repo_dir = os.path.join(workdir, iid.replace("/", "__"))
    os.makedirs(repo_dir, exist_ok=True)

    # Clone repo if needed
    if repo and base_commit and not os.path.exists(os.path.join(repo_dir, ".git")):
        clone_url = f"https://github.com/{repo}.git"
        try:
            subprocess.run(["git", "clone", clone_url, repo_dir],
                         capture_output=True, timeout=120)
            subprocess.run(["git", "checkout", base_commit],
                         capture_output=True, cwd=repo_dir, timeout=30)
        except Exception as e:
            print(f"      ⚠️  git clone failed: {e}")

    # Build command
    cmd = [
        os.path.join(_ROOT, "bin", "claude-haha"), "--bare", "-p", prompt,
    ]

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

        patch = extract_patch(stdout)
        has_patch = bool(patch and len(patch.strip()) > 10)

        return {
            "instance_id": iid,
            "repo": repo,
            "mode": "solo",
            "has_patch": has_patch,
            "patch": patch,
            "patch_len": len(patch),
            "wall_seconds": round(elapsed, 1),
            "exit_code": result.returncode,
            "stdout_preview": stdout[-500:],
            "error": None,
        }

    except subprocess.TimeoutExpired:
        elapsed = time.time() - start
        return {
            "instance_id": iid,
            "repo": repo,
            "mode": "solo",
            "has_patch": False,
            "patch": "",
            "patch_len": 0,
            "wall_seconds": round(elapsed, 1),
            "exit_code": -1,
            "error": "timeout",
        }
    except Exception as e:
        elapsed = time.time() - start
        return {
            "instance_id": iid,
            "repo": repo,
            "mode": "solo",
            "has_patch": False,
            "patch": "",
            "patch_len": 0,
            "wall_seconds": round(elapsed, 1),
            "exit_code": -1,
            "error": str(e)[:200],
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance-json", type=str, default=None,
                        help="JSON string of the instance")
    parser.add_argument("--instance-json-file", type=str, default=None,
                        help="Path to JSON file with instance")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()

    if args.instance_json:
        instance = json.loads(args.instance_json)
    elif args.instance_json_file:
        with open(args.instance_json_file) as f:
            instance = json.load(f)
    else:
        print("Error: need --instance-json or --instance-json-file")
        sys.exit(1)

    result = run_solo(instance, timeout=args.timeout)
    print(json.dumps(result, indent=2))
