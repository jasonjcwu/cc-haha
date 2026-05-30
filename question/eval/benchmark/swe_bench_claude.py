#!/usr/bin/env python3
"""
SWE-bench Hard6 Benchmark — Claude Code CLI as executor, simulated advisor.

Based on Anthropic's advisor-tool spec and Claude Code's leaked source:
- Uses Claude Code CLI (claude -p) as the executor
- Simulates advisor by calling a stronger model between execution phases
- Compares solo vs advisor on the hard6 SWE-bench subset

Usage:
  python swe_bench_claude.py --mode solo --output results/solo.jsonl
  python swe_bench_claude.py --mode advisor --output results/advisor.jsonl
  python swe_bench_claude.py --mode both --output results/
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

# ─── Config ───────────────────────────────────────────────────────────────────

CLAUDE_CMD = "claude"

# Use Claude Code's actual advisor instructions (from leaked src/utils/advisor.ts)
ADVISOR_TOOL_INSTRUCTIONS = """# Advisor Tool

You have access to an `advisor` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt.
"""

ADVISOR_SYSTEM_PROMPT = """You are an expert code review advisor for a software engineering agent. You see the full conversation history.

Your job:
1. Review what the agent has done so far
2. Identify potential issues, dead ends, or missed approaches
3. Give specific, actionable guidance for the next steps

Rules:
- Be concise — max 400 words (~700 tokens, matching Anthropic's advisor spec)
- Focus on concrete next steps, not abstract principles
- If the agent is on the right track, say so briefly and suggest verification
- If the agent is going wrong, explain why and redirect
- Point out tests to run or edge cases to check
"""

BASE_MODEL = os.environ.get("BASE_MODEL", "claude-haiku-4-5-20251001")
ADVISOR_MODEL = os.environ.get("ADVISOR_MODEL", "claude-opus-4-7")

# Proxy settings for advisor injection
PROXY_URL = os.environ.get("PROXY_URL", "http://localhost:8081")
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# Build settings JSON for Claude Code CLI
def _build_settings(use_proxy: bool = False, proxy_url: str = None,
                    api_key: str = None) -> str:
    _proxy = proxy_url or PROXY_URL
    _key = api_key or API_KEY
    if use_proxy and _proxy and _key:
        return json.dumps({
            "env": {
                "ANTHROPIC_BASE_URL": _proxy,
                "ANTHROPIC_API_KEY": _key,
            }
        })
    return json.dumps({
        "env": {
            "ANTHROPIC_API_KEY": _key,
        }
    }) if _key else ""


# ─── Task Loading ─────────────────────────────────────────────────────────────

def load_hard6() -> list[dict]:
    """Load the hard6 SWE-bench subset."""
    # Try local files first
    candidates = [
        os.path.join(os.path.dirname(__file__), "hard6.json"),
        "/root/advisor-eval/eval_set_swe_hard6.json",
    ]
    for path in candidates:
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)

    # Try HuggingFace datasets
    try:
        from datasets import load_dataset
        ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")

        # Hard6 task IDs
        hard6_ids = [
            "psf__requests-2931",
            "sympy__sympy-11618",
            "pydata__xarray-2905",
            "scikit-learn__scikit-learn-25102",
            "django__django-10554",
            "sphinx-doc__sphinx-11510",
        ]
        tasks = [row for row in ds if row["instance_id"] in hard6_ids]
        if tasks:
            # Cache locally
            cache_path = os.path.join(os.path.dirname(__file__), "hard6.json")
            with open(cache_path, "w") as f:
                json.dump(tasks, f, ensure_ascii=False, indent=2)
            return tasks
    except ImportError:
        pass

    print("ERROR: No hard6 data found. Install datasets: pip install datasets")
    sys.exit(1)


def build_task_prompt(task: dict) -> str:
    """Build a SWE-bench task prompt."""
    hints = task.get("hints_text", "")
    hints_section = f"\n## Hints\n{hints}\n" if hints else ""
    
    return f"""I need you to solve a bug in the repository {task['repo']}.

## Problem
{task['problem_statement']}
{hints_section}
## Task
1. Clone the repo: git clone https://github.com/{task['repo']}.git /tmp/swe-{task['instance_id']}
2. Checkout the base commit: cd /tmp/swe-{task['instance_id']} && git checkout {task['base_commit']}
3. Understand the problem from the description above
4. Write the minimal fix
5. Run any relevant tests to verify

## Expected Test Behavior
Tests that should PASS after fix: {task['FAIL_TO_PASS']}

## Output Format
When done, output the patch in unified diff format between <<<PATCH>>> and <<<ENDPATCH>>> markers.
"""


# ─── Claude Code Execution ───────────────────────────────────────────────────

def run_claude(prompt: str, model: str = None, timeout: int = 300,
               max_budget: float = None, use_proxy: bool = False,
               allowed_tools: str = None, proxy_url: str = None,
               api_key: str = None) -> dict:
    """Run Claude Code in print mode."""
    cmd = [CLAUDE_CMD, "-p", prompt, "--model", model or BASE_MODEL]
    if max_budget:
        cmd.extend(["--max-budget-usd", str(max_budget)])
    settings_json = _build_settings(use_proxy=use_proxy, proxy_url=proxy_url,
                                    api_key=api_key)
    if settings_json:
        cmd.extend(["--settings", settings_json])
    if allowed_tools:
        cmd.extend(["--allowedTools", allowed_tools])
    
    start = time.time()
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return {
            "output": proc.stdout,
            "stderr": proc.stderr,
            "exit_code": proc.returncode,
            "duration": round(time.time() - start, 1),
            "success": proc.returncode == 0,
        }
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if e.stdout else ""
        return {
            "output": out,
            "stderr": f"Timeout after {timeout}s",
            "exit_code": -1,
            "duration": timeout,
            "success": False,
        }


def call_advisor(task_prompt: str, conversation_text: str, phase: str) -> str:
    """Simulate advisor tool — call stronger model to review."""
    advisor_prompt = f"""{ADVISOR_SYSTEM_PROMPT}

## Original Task
{task_prompt[:3000]}

## Current Phase: {phase}

## Agent's Conversation So Far
{conversation_text[-6000:]}

Provide specific, actionable guidance for the next steps."""
    
    result = run_claude(
        advisor_prompt,
        model=ADVISOR_MODEL,
        timeout=120,
        max_budget=0.50
    )
    return result["output"] if result["success"] else "[Advisor unavailable]"


# ─── Patch Extraction ─────────────────────────────────────────────────────────

def extract_patch(output: str) -> Optional[str]:
    if not output:
        return None
    m = re.search(r'<<<PATCH>>>(.*?)<<<ENDPATCH>>>', output, re.DOTALL)
    if m:
        return m.group(1).strip()
    m = re.search(r'```diff\n(.*?)```', output, re.DOTALL)
    if m:
        return m.group(1).strip()
    # Standard unified diff
    m = re.search(r'(diff --git[\s\S]*?)(?:\n\n(?!\+|\-|\@\@)|$)', output)
    if m:
        return m.group(1).strip()
    return None


# ─── Run Modes ────────────────────────────────────────────────────────────────

def run_solo(task: dict, timeout: int = 600, use_proxy: bool = False,
             proxy_url: str = None, api_key: str = None) -> dict:
    """Solo: single Claude Code run."""
    prompt = build_task_prompt(task)

    start = time.time()
    run = run_claude(prompt, timeout=timeout, use_proxy=use_proxy,
                     allowed_tools="Edit,Write,Bash,Read,Glob,Grep",
                     proxy_url=proxy_url, api_key=api_key)
    
    return {
        "instance_id": task["instance_id"],
        "repo": task["repo"],
        "mode": "solo",
        "model": BASE_MODEL,
        "started_at": datetime.now().isoformat(),
        "output": run["output"],
        "exit_code": run["exit_code"],
        "error": run["stderr"] if not run["success"] else None,
        "duration_seconds": run["duration"],
        "completed_at": datetime.now().isoformat(),
        "patch": extract_patch(run["output"]),
        "patch_extracted": extract_patch(run["output"]) is not None,
    }


def run_advisor(task: dict, timeout: int = 900, mode: str = "proxy",
                proxy_url: str = None, api_key: str = None) -> dict:
    """
    Advisor mode. Two strategies:
    - "proxy": Use advisor proxy v3 — advisor feedback injected via system prompt on every API call.
      Single claude -p run, no multi-phase orchestration needed.
    - "multiphase": Original multi-phase approach — separate explore/implement/verify calls with
      advisor between phases.
    """
    if mode == "proxy":
        return _run_advisor_proxy(task, timeout=timeout, proxy_url=proxy_url, api_key=api_key)
    else:
        return _run_advisor_multiphase(task, timeout=timeout)


def _run_advisor_proxy(task: dict, timeout: int = 900,
                       proxy_url: str = None, api_key: str = None) -> dict:
    """Advisor via proxy — single run with automatic advisor injection."""
    prompt = build_task_prompt(task)

    start = time.time()
    run = run_claude(
        prompt,
        timeout=timeout,
        use_proxy=True,
        allowed_tools="Edit,Write,Bash,Read,Glob,Grep",
        proxy_url=proxy_url,
        api_key=api_key,
    )

    return {
        "instance_id": task["instance_id"],
        "repo": task["repo"],
        "mode": "advisor-proxy",
        "model": BASE_MODEL,
        "advisor_model": ADVISOR_MODEL,
        "started_at": datetime.now().isoformat(),
        "output": run["output"],
        "exit_code": run["exit_code"],
        "error": run["stderr"] if not run["success"] else None,
        "duration_seconds": run["duration"],
        "completed_at": datetime.now().isoformat(),
        "patch": extract_patch(run["output"]),
        "patch_extracted": extract_patch(run["output"]) is not None,
    }


def _run_advisor_multiphase(task: dict, timeout: int = 900) -> dict:
    """
    Advisor: multi-phase with simulated advisor between phases.
    
    Phase 1: Exploration → Advisor #1
    Phase 2: Implementation → Advisor #2
    Phase 3: Verification + Final patch
    """
    task_prompt = build_task_prompt(task)
    
    result = {
        "instance_id": task["instance_id"],
        "repo": task["repo"],
        "mode": "advisor",
        "model": BASE_MODEL,
        "advisor_model": ADVISOR_MODEL,
        "started_at": datetime.now().isoformat(),
        "advisor_calls": 0,
        "phases": [],
    }
    
    total_start = time.time()
    
    # Phase 1: Exploration
    p1_prompt = task_prompt + f"\n\n{ADVISOR_TOOL_INSTRUCTIONS}\n\n" + \
        "Start by EXPLORING the codebase. Read files, understand the bug. Do NOT write any fix yet.\n" + \
        "Report your findings. End with: <<<CHECKPOINT:exploration>>>"
    
    p1 = run_claude(p1_prompt, timeout=300)
    result["phases"].append({"phase": "exploration", "duration": p1["duration"]})
    
    # Advisor #1
    advice1 = call_advisor(task_prompt, p1["output"], "after_exploration")
    result["advisor_calls"] += 1
    
    # Phase 2: Implementation
    p2_prompt = task_prompt + f"""

## Previous Exploration
{p1['output'][-3000:]}

## Advisor Guidance (from {ADVISOR_MODEL})
{advice1}

Now IMPLEMENT the fix based on your exploration and the advisor's guidance.
Write the actual code changes. End with: <<<CHECKPOINT:implementation>>>"""
    
    p2 = run_claude(p2_prompt, timeout=300)
    result["phases"].append({"phase": "implementation", "duration": p2["duration"]})
    
    # Advisor #2
    advice2 = call_advisor(
        task_prompt,
        p1["output"][-2000:] + "\n\n" + p2["output"][-3000:],
        "after_implementation"
    )
    result["advisor_calls"] += 1
    
    # Phase 3: Verification
    p3_prompt = task_prompt + f"""

## Your Implementation
{p2['output'][-2000:]}

## Advisor Review (from {ADVISOR_MODEL})
{advice2}

Now VERIFY your fix. Output the final patch between <<<PATCH>>> and <<<ENDPATCH>>>.
End with: <<<CHECKPOINT:final>>>"""
    
    p3 = run_claude(p3_prompt, timeout=300)
    result["phases"].append({"phase": "verification", "duration": p3["duration"]})
    
    final = p3["output"]
    result.update({
        "output": final,
        "exit_code": 0,
        "duration_seconds": round(time.time() - total_start, 1),
        "completed_at": datetime.now().isoformat(),
        "patch": extract_patch(final),
        "patch_extracted": extract_patch(final) is not None,
        "advisor_advice": [advice1, advice2],
    })
    
    return result


# ─── Output ───────────────────────────────────────────────────────────────────

def save_result(result: dict, path: str):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a") as f:
        # Don't save full output to keep file size manageable
        r = {k: v for k, v in result.items() 
             if k not in ("output", "advisor_advice")}
        r["output_preview"] = result.get("output", "")[:500]
        f.write(json.dumps(r, ensure_ascii=False) + "\n")


def print_comparison(solo_results: list[dict], advisor_results: list[dict]):
    """Print side-by-side comparison."""
    print(f"\n{'='*70}")
    print(f"  BENCHMARK COMPARISON — SWE-bench Hard6")
    print(f"{'='*70}")
    print(f"  Executor: {BASE_MODEL}")
    print(f"  Advisor:  {ADVISOR_MODEL}")
    print(f"{'─'*70}")
    print(f"  {'Instance':<35} {'Solo':>10} {'Advisor':>10} {'Δ':>8}")
    print(f"  {'─'*35} {'─'*10} {'─'*10} {'─'*8}")
    
    for s, a in zip(solo_results, advisor_results):
        s_patch = "✓" if s.get("patch_extracted") else "✗"
        a_patch = "✓" if a.get("patch_extracted") else "✗"
        delta = ""
        if s.get("patch_extracted") != a.get("patch_extracted"):
            delta = "↑" if a.get("patch_extracted") else "↓"
        print(f"  {s['instance_id']:<35} {s_patch:>10} {a_patch:>10} {delta:>8}")
    
    s_count = sum(1 for r in solo_results if r.get("patch_extracted"))
    a_count = sum(1 for r in advisor_results if r.get("patch_extracted"))
    
    print(f"  {'─'*35} {'─'*10} {'─'*10} {'─'*8}")
    print(f"  {'TOTAL':<35} {s_count:>10} {a_count:>10}")
    
    s_dur = sum(r["duration_seconds"] for r in solo_results)
    a_dur = sum(r["duration_seconds"] for r in advisor_results)
    print(f"  {'Duration (s)':<35} {s_dur:>10.1f} {a_dur:>10.1f}")
    
    a_calls = sum(r.get("advisor_calls", 0) for r in advisor_results)
    print(f"  {'Advisor calls':<35} {'N/A':>10} {a_calls:>10}")
    print(f"{'='*70}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="SWE-bench Hard6: Claude Code Solo vs Advisor")
    p.add_argument("--mode", choices=["solo", "advisor", "both"], default="both")
    p.add_argument("--output", default="results/")
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--tasks", type=int, default=6, help="Max tasks to run (default: all 6)")
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--base-model", default=BASE_MODEL)
    p.add_argument("--advisor-model", default=ADVISOR_MODEL)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--advisor-mode", choices=["proxy", "multiphase"], default="proxy",
                   help="Advisor strategy: proxy (auto-inject) or multiphase (3-phase)")
    p.add_argument("--proxy-url", default=PROXY_URL)
    p.add_argument("--api-key", default=API_KEY)
    args = p.parse_args()
    
    base_model = args.base_model or BASE_MODEL
    advisor_model = args.advisor_model or ADVISOR_MODEL
    
    print(f"Loading hard6 tasks...")
    tasks = load_hard6()
    tasks = tasks[args.offset:args.offset + args.tasks]
    print(f"Loaded {len(tasks)} tasks: {[t['instance_id'] for t in tasks]}")
    
    if args.dry_run:
        for t in tasks:
            print(f"  {t['instance_id']}: {t['repo']}")
        return
    
    modes = ["solo", "advisor"] if args.mode == "both" else [args.mode]
    all_results = {"solo": [], "advisor": []}
    
    for mode in modes:
        print(f"\n{'═'*60}")
        print(f"  {mode.upper()} — {base_model}" + 
              (f" + {advisor_model} advisor" if mode == "advisor" else ""))
        print(f"{'═'*60}")
        
        out = args.output
        if args.mode == "both":
            out = os.path.join(args.output, f"{mode}.jsonl")
        
        for i, task in enumerate(tasks):
            print(f"\n[{i+1}/{len(tasks)}] {task['instance_id']}...")
            
            if mode == "solo":
                r = run_solo(task, timeout=args.timeout, use_proxy=False,
                             api_key=args.api_key)
            else:
                r = run_advisor(task, timeout=int(args.timeout * 1.5),
                                mode=args.advisor_mode,
                                proxy_url=args.proxy_url, api_key=args.api_key)
            
            save_result(r, out)
            all_results[mode].append(r)
            
            patch = "✓ patch" if r.get("patch_extracted") else "✗ no patch"
            calls = f", {r.get('advisor_calls', 0)} advisor calls" if mode == "advisor" else ""
            print(f"  → {r['duration_seconds']}s, {patch}{calls}")
    
    # Comparison table
    if args.mode == "both" and all_results["solo"] and all_results["advisor"]:
        print_comparison(all_results["solo"], all_results["advisor"])


if __name__ == "__main__":
    main()
