#!/usr/bin/env python3
"""
cc-haha CLI Injected Runner

三阶段注入：探索 → advisor → 实现 → advisor → 验证
Usage:
  source ../../scripts/set-env-ds.sh && python3 cc_haha_injected.py \
    --instance-json '{...}' --model deepseek --advisor-model deepseek-chat
"""

import argparse
import json
import os
import subprocess
import sys
import time
from openai import OpenAI

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))  # cc-haha project root
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prompt_templates import (
    build_exploration_prompt, build_implementation_prompt,
    build_verification_prompt, build_advisor_prompt, extract_patch
)

# ─── Advisor API 配置 ────────────────────────────────────────────────

ADVISOR_API_CONFIG = {
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
    },
    "glm": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model": "glm-5.1",
    },
}


def get_advisor_client(advisor_model: str):
    """创建外部 advisor 的 OpenAI 客户端"""
    config = ADVISOR_API_CONFIG.get(advisor_model, ADVISOR_API_CONFIG["deepseek"])
    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
    # Read from auth.json if env not set
    if not key:
        try:
            with open(os.path.expanduser("~/.hermes/auth.json")) as f:
                auth = json.load(f)
            pool = auth.get("credential_pool", {})
            if advisor_model == "glm":
                key = pool.get("custom:glmcode", [{}])[0].get("access_token", "")
            else:
                key = pool.get("deepseek", [{}])[0].get("access_token", "")
        except Exception:
            pass
    return OpenAI(api_key=key, base_url=config["base_url"]), config["model"]


def call_advisor(client: OpenAI, model: str, phase: str, context: str) -> str:
    """调用外部 advisor API"""
    prompt = build_advisor_prompt(phase, context)
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are an expert code review advisor."},
                {"role": "user", "content": prompt},
            ],
            max_tokens=1024,
            temperature=0.1,
        )
        return resp.choices[0].message.content or ""
    except Exception as e:
        return f"[Advisor error: {str(e)[:100]}]"


# ─── cc-haha CLI 调用 ────────────────────────────────────────────────

def run_cc_haha(prompt: str, workdir: str, timeout: int = 600) -> tuple:
    """Run cc-haha CLI with a prompt. Returns (stdout, wall_seconds, error)"""
    cmd = [os.path.join(_ROOT, "bin", "claude-haha"), "--bare", "-p", prompt]
    env = os.environ.copy()
    start = time.time()
    try:
        result = subprocess.run(
            cmd, input="", capture_output=True, text=True,
            timeout=timeout, cwd=workdir, env=env,
        )
        elapsed = time.time() - start
        return result.stdout or "", elapsed, None
    except subprocess.TimeoutExpired:
        return "", time.time() - start, "timeout"
    except Exception as e:
        return "", time.time() - start, str(e)[:200]


# ─── 三阶段注入 ──────────────────────────────────────────────────────

def run_injected(instance: dict, advisor_model: str = "deepseek",
                 timeout: int = 600, workdir: str = "/tmp/cc-haha-swe") -> dict:
    """Run a single SWE-bench task with 3-phase advisor injection."""
    iid = instance["instance_id"]
    repo = instance.get("repo", "")
    base_commit = instance.get("base_commit", "")

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

    # Setup advisor
    client, advisor_api_model = get_advisor_client(advisor_model)

    results = {"instance_id": iid, "repo": repo, "mode": "injected",
               "phases": [], "total_wall_seconds": 0}

    # ── Phase 1: 探索 ──
    print(f"  Phase 1/3: 探索...")
    p1_prompt = build_exploration_prompt(instance)
    p1_out, p1_time, p1_err = run_cc_haha(p1_prompt, repo_dir, timeout // 3)
    results["phases"].append({
        "phase": "exploration", "time": round(p1_time, 1),
        "stdout_preview": p1_out[-500:], "error": p1_err,
    })
    results["total_wall_seconds"] += p1_time
    print(f"    done in {p1_time:.0f}s")

    if p1_err:
        print(f"    ⚠️  Phase 1 error: {p1_err}")

    # ── Advisor 1 ──
    print(f"  Advisor 1/2: 审查探索结果...")
    a1_feedback = call_advisor(client, advisor_api_model, "exploration", p1_out[-4000:])
    print(f"    feedback: {a1_feedback[:100]}...")

    # ── Phase 2: 实现 ──
    print(f"  Phase 2/3: 实现...")
    p2_prompt = build_implementation_prompt(instance, p1_out[-4000:], a1_feedback)
    p2_out, p2_time, p2_err = run_cc_haha(p2_prompt, repo_dir, timeout // 3)
    results["phases"].append({
        "phase": "implementation", "time": round(p2_time, 1),
        "stdout_preview": p2_out[-500:], "error": p2_err,
    })
    results["total_wall_seconds"] += p2_time
    print(f"    done in {p2_time:.0f}s")

    if p2_err:
        print(f"    ⚠️  Phase 2 error: {p2_err}")

    # ── Advisor 2 ──
    print(f"  Advisor 2/2: 审查实现...")
    a2_feedback = call_advisor(client, advisor_api_model, "implementation", p2_out[-4000:])
    print(f"    feedback: {a2_feedback[:100]}...")

    # ── Phase 3: 验证 ──
    print(f"  Phase 3/3: 验证...")
    p3_prompt = build_verification_prompt(instance, p2_out[-3000:], a2_feedback)
    p3_out, p3_time, p3_err = run_cc_haha(p3_prompt, repo_dir, timeout // 3)
    results["phases"].append({
        "phase": "verification", "time": round(p3_time, 1),
        "stdout_preview": p3_out[-500:], "error": p3_err,
    })
    results["total_wall_seconds"] += p3_time
    print(f"    done in {p3_time:.0f}s")

    # ── 提取最终 patch ──
    # 取所有 phase 的 stdout 中最可能的 patch
    all_output = p1_out + "\n" + p2_out + "\n" + p3_out
    patch = extract_patch(all_output)
    results["has_patch"] = bool(patch and len(patch.strip()) > 10)
    results["patch"] = patch
    results["patch_len"] = len(patch)
    results["total_wall_seconds"] = round(results["total_wall_seconds"], 1)
    results["advisor_feedback_1"] = a1_feedback[:500]
    results["advisor_feedback_2"] = a2_feedback[:500]

    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance-json", type=str, default=None)
    parser.add_argument("--instance-json-file", type=str, default=None)
    parser.add_argument("--advisor-model", choices=["deepseek", "glm"], default="deepseek")
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

    result = run_injected(instance, advisor_model=args.advisor_model, timeout=args.timeout)
    print(json.dumps(result, indent=2))
