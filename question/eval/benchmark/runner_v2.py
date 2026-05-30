#!/usr/bin/env python3
"""
SWE-bench Lite Benchmark Runner v2 — Faithful Advisor Simulation

Faithfully simulates Claude Code's advisor pattern based on leaked source analysis:
1. Uses Claude Code CLI in stream-json mode to capture full tool call history
2. Advisor (stronger model) sees the same context the real advisor sees:
   - Full conversation including all tool calls and results
3. Advisor instructions match the original ADVISOR_TOOL_INSTRUCTIONS from Claude Code

Modes:
  solo    — Single Claude Code run, no advisor
  advisor — Claude Code with advisor intervention at key decision points

Usage:
  python runner_v2.py --mode solo --tasks 5 --output results/solo.jsonl
  python runner_v2.py --mode advisor --tasks 5 --output results/advisor.jsonl
  python runner_v2.py --mode both --tasks 5 --output results/
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

from datasets import load_dataset


# ─── Config ───────────────────────────────────────────────────────────────────

BASE_MODEL = os.environ.get("BASE_MODEL", "sonnet")
ADVISOR_MODEL = os.environ.get("ADVISOR_MODEL", "opus")
CLAUDE_CMD = "claude"

# The actual advisor instructions from Claude Code source (src/utils/advisor.ts)
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

ADVISOR_SYSTEM_PROMPT = """You are an expert code review advisor. You see the full conversation history of an AI coding agent working on a software engineering task.

Your job:
1. Review what the agent has done so far
2. Identify potential issues, dead ends, or missed approaches
3. Give specific, actionable guidance for the next steps

Rules:
- Be concise — max 400 words
- Focus on concrete next steps, not abstract principles
- If the agent is on the right track, say so briefly and suggest what to verify
- If the agent is going wrong, explain why and redirect
- Point out any tests that should be run or edge cases to check
- If the task appears complete, list what to verify before declaring done
"""


# ─── Task Loading ─────────────────────────────────────────────────────────────

def load_swebench_tasks(limit: int = 5, offset: int = 0) -> list[dict]:
    ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
    return [ds[i] for i in range(offset, min(offset + limit, len(ds)))]


# ─── Prompt Building ──────────────────────────────────────────────────────────

def build_task_prompt(task: dict) -> str:
    return f"""I need you to solve a bug in the repository {task['repo']}.

## Problem
{task['problem_statement']}

## Task
1. Clone the repo: git clone https://github.com/{task['repo']}.git
2. Checkout the base commit: git checkout {task['base_commit']}
3. Understand the problem from the description above
4. Write the minimal fix
5. Make sure the fix is correct by reading the relevant code

## Expected Test Behavior
Tests that should PASS after your fix:
{task['FAIL_TO_PASS']}

Tests that should still PASS (regression):
{task['PASS_TO_PASS']}

## Output Format
When done, output the patch in unified diff format between <<<PATCH>>> and <<<ENDPATCH>>> markers.
"""


def build_advisor_injection_prompt(task_prompt: str, advisor_instructions: str) -> str:
    """Build prompt that injects advisor instructions into the base agent's system."""
    return task_prompt + f"""

---

{advisor_instructions}

IMPORTANT: At key decision points (after exploring the code, before implementing, after implementing), 
you should pause and describe your current state. This allows the advisor to review your progress.

End each checkpoint with: <<<CHECKPOINT:{phase_name}>>>
Where phase_name is one of: exploration, pre_implementation, post_implementation, final
"""


# ─── Claude Code Execution ───────────────────────────────────────────────────

def run_claude_stream(prompt: str, model: str = None, timeout: int = 300,
                      max_budget: float = None) -> dict:
    """Run Claude Code in --print mode, capture output."""
    cmd = [CLAUDE_CMD, "-p", prompt, "--model", model or BASE_MODEL,
           "--dangerously-skip-permissions"]
    if max_budget:
        cmd.extend(["--max-budget-usd", str(max_budget)])
    
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
    except subprocess.TimeoutExpired:
        return {
            "output": "",
            "stderr": f"Timeout after {timeout}s",
            "exit_code": -1,
            "duration": timeout,
            "success": False,
        }


def call_advisor(task_prompt: str, conversation_log: str, phase: str) -> str:
    """Call the advisor model — simulates the server-side advisor tool."""
    advisor_prompt = f"""{ADVISOR_SYSTEM_PROMPT}

## Original Task
{task_prompt[:3000]}

## Current Phase: {phase}

## Agent's Full Conversation History
{conversation_log[-6000:]}

## Your Task
Review the agent's work and provide specific, actionable guidance.
"""
    
    result = run_claude_stream(
        advisor_prompt, 
        model=ADVISOR_MODEL, 
        timeout=120,
        max_budget=0.50
    )
    return result["output"] if result["success"] else "[Advisor unavailable - proceed with your best judgment]"


# ─── Solo Mode ────────────────────────────────────────────────────────────────

def run_solo(task: dict, timeout: int = 600) -> dict:
    """Solo mode: single Claude Code run, no advisor."""
    prompt = build_task_prompt(task)
    
    result = {
        "instance_id": task["instance_id"],
        "repo": task["repo"],
        "mode": "solo",
        "model": BASE_MODEL,
        "started_at": datetime.now().isoformat(),
    }
    
    start = time.time()
    run = run_claude_stream(prompt, timeout=timeout)
    
    result.update({
        "output": run["output"],
        "exit_code": run["exit_code"],
        "error": run["stderr"] if not run["success"] else None,
        "duration_seconds": run["duration"],
        "completed_at": datetime.now().isoformat(),
        "patch": extract_patch(run["output"]),
        "patch_extracted": extract_patch(run["output"]) is not None,
    })
    
    return result


# ─── Advisor Mode ─────────────────────────────────────────────────────────────

def run_advisor(task: dict, timeout: int = 900) -> dict:
    """
    Advisor mode: multi-phase execution with advisor review between phases.
    
    Phase 1: Exploration — agent reads code, understands the bug
    → Advisor call #1: reviews exploration, guides implementation approach
    
    Phase 2: Implementation — agent writes the fix
    → Advisor call #2: reviews implementation, suggests verification
    
    Phase 3: Final — agent verifies and outputs patch
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
        "advisor_advice": [],
        "phases": [],
    }
    
    total_start = time.time()
    
    # ── Phase 1: Exploration ──
    phase1_prompt = task_prompt + """

---
""" + ADVISOR_TOOL_INSTRUCTIONS + """

Start by EXPLORING the codebase. Read relevant files, understand the bug. 
Do NOT write any fix yet. Just report what you found.
End with: <<<CHECKPOINT:exploration>>>
"""
    
    phase1 = run_claude_stream(phase1_prompt, timeout=300)
    result["phases"].append({
        "phase": "exploration",
        "duration": phase1["duration"],
        "output_len": len(phase1["output"]),
    })
    
    # ── Advisor Call #1 ──
    advice1 = call_advisor(task_prompt, phase1["output"], "after_exploration")
    result["advisor_calls"] += 1
    result["advisor_advice"].append(advice1)
    
    # ── Phase 2: Implementation ──
    phase2_prompt = task_prompt + f"""

---
## Previous Exploration
{phase1['output'][-3000:]}

## Advisor Guidance
{advice1}

---
""" + ADVISOR_TOOL_INSTRUCTIONS + """

Now IMPLEMENT the fix based on your exploration and the advisor's guidance.
Write the actual code changes. End with: <<<CHECKPOINT:implementation>>>
"""
    
    phase2 = run_claude_stream(phase2_prompt, timeout=300)
    result["phases"].append({
        "phase": "implementation",
        "duration": phase2["duration"],
        "output_len": len(phase2["output"]),
    })
    
    # ── Advisor Call #2 ──
    advice2 = call_advisor(
        task_prompt, 
        phase1["output"][-2000:] + "\n\n" + phase2["output"][-3000:],
        "after_implementation"
    )
    result["advisor_calls"] += 1
    result["advisor_advice"].append(advice2)
    
    # ── Phase 3: Verification & Final Patch ──
    phase3_prompt = task_prompt + f"""

---
## Your Implementation
{phase2['output'][-2000:]}

## Advisor's Review
{advice2}

---
Now VERIFY your fix is correct and output the final patch.
Output the patch in unified diff format between <<<PATCH>>> and <<<ENDPATCH>>> markers.
End with: <<<CHECKPOINT:final>>>
"""
    
    phase3 = run_claude_stream(phase3_prompt, timeout=300)
    result["phases"].append({
        "phase": "verification",
        "duration": phase3["duration"],
        "output_len": len(phase3["output"]),
    })
    
    # ── Finalize ──
    final_output = phase3["output"]
    result.update({
        "output": final_output,
        "exit_code": 0,
        "duration_seconds": round(time.time() - total_start, 1),
        "completed_at": datetime.now().isoformat(),
        "patch": extract_patch(final_output),
        "patch_extracted": extract_patch(final_output) is not None,
    })
    
    return result


# ─── Patch Extraction ─────────────────────────────────────────────────────────

def extract_patch(output: str) -> Optional[str]:
    if not output:
        return None
    # <<<PATCH>>> ... <<<ENDPATCH>>>
    m = re.search(r'<<<PATCH>>>(.*?)<<<ENDPATCH>>>', output, re.DOTALL)
    if m:
        return m.group(1).strip()
    # ```diff ... ```
    m = re.search(r'```diff\n(.*?)```', output, re.DOTALL)
    if m:
        return m.group(1).strip()
    # diff --git ...
    m = re.search(r'(diff --git[\s\S]*?)(?:\n\n(?!\+\+\+)|$)', output)
    if m:
        return m.group(1).strip()
    return None


# ─── Output ───────────────────────────────────────────────────────────────────

def save_result(result: dict, path: str):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(result, ensure_ascii=False) + "\n")


def print_summary(results: list[dict]):
    mode = results[0]["mode"]
    print(f"\n{'='*60}")
    print(f"  BENCHMARK SUMMARY — {mode.upper()}")
    print(f"{'='*60}")
    print(f"  Model: {results[0]['model']}")
    if mode == "advisor":
        print(f"  Advisor: {results[0].get('advisor_model', 'N/A')}")
    print(f"  Tasks: {len(results)}")
    
    patches = sum(1 for r in results if r.get("patch_extracted"))
    print(f"  Patches extracted: {patches}/{len(results)}")
    
    durations = [r["duration_seconds"] for r in results]
    print(f"  Avg duration: {sum(durations)/len(durations):.1f}s")
    print(f"  Total: {sum(durations):.1f}s")
    
    if mode == "advisor":
        calls = [r.get("advisor_calls", 0) for r in results]
        print(f"  Avg advisor calls: {sum(calls)/len(calls):.1f}")
    print(f"{'='*60}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="SWE-bench Lite Benchmark: Solo vs Advisor v2")
    p.add_argument("--mode", choices=["solo", "advisor", "both"], default="both")
    p.add_argument("--tasks", type=int, default=5)
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--output", default="results/")
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    
    print(f"Loading SWE-bench Lite ({args.tasks} tasks, offset={args.offset})...")
    tasks = load_swebench_tasks(args.tasks, args.offset)
    print(f"Loaded {len(tasks)} tasks: {[t['instance_id'] for t in tasks]}")
    
    if args.dry_run:
        for t in tasks:
            print(f"\n  {t['instance_id']}: {t['repo']} — {t['problem_statement'][:100]}...")
        return
    
    modes = ["solo", "advisor"] if args.mode == "both" else [args.mode]
    
    for mode in modes:
        print(f"\n{'═'*60}")
        print(f"  {mode.upper()} mode — {len(tasks)} tasks")
        print(f"{'═'*60}")
        
        out = args.output
        if args.mode == "both":
            out = os.path.join(args.output, f"{mode}.jsonl")
        
        results = []
        for i, task in enumerate(tasks):
            print(f"\n[{i+1}/{len(tasks)}] {task['instance_id']}...")
            
            if mode == "solo":
                r = run_solo(task, timeout=args.timeout)
            else:
                r = run_advisor(task, timeout=int(args.timeout * 1.5))
            
            save_result(r, out)
            results.append(r)
            
            status = "✓" if r.get("patch_extracted") else "✗"
            print(f"  → {r['duration_seconds']}s, patch: {status}")
        
        print_summary(results)


if __name__ == "__main__":
    main()
