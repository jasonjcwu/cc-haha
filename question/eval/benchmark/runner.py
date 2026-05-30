#!/usr/bin/env python3
"""
SWE-bench Lite Benchmark Runner — Solo vs Simulated Advisor

Simulates the Claude Code advisor pattern:
- Solo mode: Claude Code executes the task normally
- Advisor mode: After key decision points, a stronger model reviews the conversation
  and injects guidance (mimicking Anthropic's server-side advisor tool)

Usage:
  python runner.py --mode solo --tasks 5 --output results/solo.jsonl
  python runner.py --mode advisor --tasks 5 --output results/advisor.jsonl
  python runner.py --mode both --tasks 5 --output results/
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

# SWE-bench dataset
from datasets import load_dataset


# ─── Config ───────────────────────────────────────────────────────────────────

CLAUDE_CMD = "claude"
CODEX_CMD = "codex"

# Advisor simulation config
ADVISOR_SYSTEM_PROMPT = """You are an expert code review advisor. You see the full conversation history of an AI coding agent working on a software engineering task.

Your job:
1. Review what the agent has done so far
2. Identify potential issues, dead ends, or missed approaches
3. Give specific, actionable guidance for the next steps

Rules:
- Be concise — max 300 words
- Focus on concrete next steps, not abstract principles
- If the agent is on the right track, say so briefly and suggest what to verify
- If the agent is going wrong, explain why and redirect
- Point out any tests that should be run or edge cases to check
- If the task appears complete, list what to verify before declaring done
"""

BASE_MODEL = os.environ.get("BASE_MODEL", "sonnet")       # Claude Code model for task execution
ADVISOR_MODEL = os.environ.get("ADVISOR_MODEL", "opus")   # Stronger model for advisor
MAX_TURNS_ADVISOR = 3  # Max advisor intervention points


# ─── Data Loading ─────────────────────────────────────────────────────────────

def load_swebench_tasks(limit: int = 5, offset: int = 0) -> list[dict]:
    """Load SWE-bench Lite tasks."""
    ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
    tasks = []
    for i in range(offset, min(offset + limit, len(ds))):
        tasks.append(ds[i])
    return tasks


# ─── Claude Code Runner ──────────────────────────────────────────────────────

def build_prompt(task: dict) -> str:
    """Build a SWE-bench task prompt for Claude Code."""
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
The following tests should PASS after your fix:
{task['FAIL_TO_PASS']}

The following tests should still PASS (regression check):
{task['PASS_TO_PASS']}

## Output Format
When done, output the patch in unified diff format between <<<PATCH>>> and <<<ENDPATCH>>> markers.
"""


def run_claude_solo(task: dict, timeout: int = 600) -> dict:
    """Run Claude Code on a single task without advisor (solo mode)."""
    prompt = build_prompt(task)
    
    result = {
        "instance_id": task["instance_id"],
        "repo": task["repo"],
        "mode": "solo",
        "model": BASE_MODEL,
        "started_at": datetime.now().isoformat(),
    }
    
    start = time.time()
    try:
        proc = subprocess.run(
            [CLAUDE_CMD, "-p", prompt, "--model", BASE_MODEL, 
             "--dangerously-skip-permissions", "--output-format", "json"],
            capture_output=True, text=True, timeout=timeout
        )
        result["output"] = proc.stdout
        result["exit_code"] = proc.returncode
        result["error"] = proc.stderr if proc.stderr else None
    except subprocess.TimeoutExpired:
        result["output"] = ""
        result["exit_code"] = -1
        result["error"] = f"Timeout after {timeout}s"
    
    result["duration_seconds"] = round(time.time() - start, 1)
    result["completed_at"] = datetime.now().isoformat()
    
    # Extract patch if present
    result["patch"] = extract_patch(result["output"])
    
    return result


def run_claude_with_advisor(task: dict, timeout: int = 900) -> dict:
    """
    Run Claude Code with simulated advisor.
    
    Strategy: Run in phases with advisor checkpoints:
    Phase 1: Agent explores codebase (understanding phase)
    Phase 2: Agent implements fix (implementation phase)  
    Phase 3: Agent verifies fix (verification phase)
    
    Advisor intervenes between phases.
    """
    prompt = build_prompt(task)
    
    # Phase 1: Initial exploration
    phase1_prompt = prompt + """

## Current Phase: EXPLORATION
Start by exploring the codebase. Read the relevant files. Understand the bug.
Do NOT write any fix yet. Just report what you found.
End your response with: <<<PHASE_COMPLETE:exploration>>>
"""
    
    result = {
        "instance_id": task["instance_id"],
        "repo": task["repo"],
        "mode": "advisor",
        "model": BASE_MODEL,
        "advisor_model": ADVISOR_MODEL,
        "advisor_calls": 0,
        "started_at": datetime.now().isoformat(),
    }
    
    start = time.time()
    conversation_log = []
    
    # Phase 1: Exploration
    phase1_output = _run_claude_phase(phase1_prompt, timeout=300)
    conversation_log.append({"phase": "exploration", "output": phase1_output})
    
    # Advisor call #1: Review exploration, guide implementation
    advisor_advice_1 = _call_advisor(
        task_prompt=prompt,
        conversation_so_far=conversation_log,
        phase="after_exploration"
    )
    result["advisor_calls"] += 1
    
    # Phase 2: Implementation (with advisor guidance)
    phase2_prompt = f"""{prompt}

## Advisor Guidance
The advisor reviewed your exploration and suggests:
{advisor_advice_1}

## Current Phase: IMPLEMENTATION
Based on your exploration and the advisor's guidance, implement the fix now.
End your response with: <<<PHASE_COMPLETE:implementation>>>
"""
    
    phase2_output = _run_claude_phase(phase2_prompt, timeout=300)
    conversation_log.append({"phase": "implementation", "output": phase2_output})
    
    # Advisor call #2: Review implementation
    advisor_advice_2 = _call_advisor(
        task_prompt=prompt,
        conversation_so_far=conversation_log,
        phase="after_implementation"
    )
    result["advisor_calls"] += 1
    
    # Phase 3: Verification (with advisor review)
    phase3_prompt = f"""{prompt}

## Advisor's Review of Your Implementation
{advisor_advice_2}

## Current Phase: VERIFICATION
Verify your fix is correct. Run any relevant tests or checks.
Output the final patch between <<<PATCH>>> and <<<ENDPATCH>>> markers.
End with: <<<PHASE_COMPLETE:verification>>>
"""
    
    phase3_output = _run_claude_phase(phase3_prompt, timeout=300)
    conversation_log.append({"phase": "verification", "output": phase3_output})
    
    result["output"] = phase3_output
    result["advisor_advice"] = [advisor_advice_1, advisor_advice_2]
    result["conversation_log"] = conversation_log
    result["duration_seconds"] = round(time.time() - start, 1)
    result["completed_at"] = datetime.now().isoformat()
    result["exit_code"] = 0
    
    # Extract patch from final output
    result["patch"] = extract_patch(phase3_output)
    
    return result


def _run_claude_phase(prompt: str, timeout: int = 300) -> str:
    """Run a single phase of Claude Code."""
    try:
        proc = subprocess.run(
            [CLAUDE_CMD, "-p", prompt, "--model", BASE_MODEL,
             "--dangerously-skip-permissions"],
            capture_output=True, text=True, timeout=timeout
        )
        return proc.stdout
    except subprocess.TimeoutExpired:
        return "[TIMEOUT]"


def _call_advisor(task_prompt: str, conversation_so_far: list[dict], phase: str) -> str:
    """
    Call the advisor model to review progress and provide guidance.
    Simulates the server-side advisor tool from Claude Code.
    """
    # Build conversation summary for advisor
    conversation_text = ""
    for entry in conversation_so_far:
        conversation_text += f"\n### Phase: {entry['phase']}\n{entry['output'][-2000:]}\n"
    
    advisor_prompt = f"""{ADVISOR_SYSTEM_PROMPT}

## Original Task
{task_prompt[:2000]}

## Current Phase: {phase}

## Agent's Work So Far
{conversation_text}

## Your Task
Review the agent's work and provide guidance for the next phase. Focus on:
1. What did the agent get right/wrong?
2. What should the agent do next?
3. Any pitfalls to avoid?
"""
    
    try:
        proc = subprocess.run(
            [CLAUDE_CMD, "-p", advisor_prompt, "--model", ADVISOR_MODEL,
             "--dangerously-skip-permissions", "--max-budget-usd", "0.50"],
            capture_output=True, text=True, timeout=120
        )
        return proc.stdout
    except subprocess.TimeoutExpired:
        return "[Advisor timeout - proceed with your best judgment]"


# ─── Patch Extraction ─────────────────────────────────────────────────────────

def extract_patch(output: str) -> Optional[str]:
    """Extract unified diff patch from Claude's output."""
    # Try <<<PATCH>>> ... <<<ENDPATCH>>> markers
    match = re.search(r'<<<PATCH>>>(.*?)<<<ENDPATCH>>>', output, re.DOTALL)
    if match:
        return match.group(1).strip()
    
    # Try standard unified diff format
    match = re.search(r'(diff --git.*?)(?:\n\n|\Z)', output, re.DOTALL)
    if match:
        return match.group(1).strip()
    
    # Try ```diff ... ``` blocks
    match = re.search(r'```diff\n(.*?)```', output, re.DOTALL)
    if match:
        return match.group(1).strip()
    
    return None


# ─── Output ───────────────────────────────────────────────────────────────────

def save_result(result: dict, output_path: str):
    """Append result to JSONL output file."""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "a") as f:
        f.write(json.dumps(result, ensure_ascii=False) + "\n")


def print_summary(results: list[dict]):
    """Print a summary of results."""
    print(f"\n{'='*60}")
    print(f"  BENCHMARK SUMMARY — {results[0]['mode'].upper()} MODE")
    print(f"{'='*60}")
    print(f"  Model: {results[0]['model']}")
    if results[0]['mode'] == 'advisor':
        print(f"  Advisor: {results[0].get('advisor_model', 'N/A')}")
    print(f"  Tasks: {len(results)}")
    print(f"  Patches extracted: {sum(1 for r in results if r.get('patch'))}")
    
    durations = [r['duration_seconds'] for r in results]
    print(f"  Avg duration: {sum(durations)/len(durations):.1f}s")
    print(f"  Total duration: {sum(durations):.1f}s")
    
    if results[0]['mode'] == 'advisor':
        advisor_calls = [r.get('advisor_calls', 0) for r in results]
        print(f"  Avg advisor calls: {sum(advisor_calls)/len(advisor_calls):.1f}")
    print(f"{'='*60}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="SWE-bench Lite Benchmark: Solo vs Advisor")
    parser.add_argument("--mode", choices=["solo", "advisor", "both"], default="both",
                        help="Run mode: solo, advisor, or both")
    parser.add_argument("--tasks", type=int, default=5,
                        help="Number of SWE-bench tasks to run")
    parser.add_argument("--offset", type=int, default=0,
                        help="Start offset in dataset")
    parser.add_argument("--output", type=str, default="results/",
                        help="Output directory or file path")
    parser.add_argument("--timeout", type=int, default=600,
                        help="Timeout per task in seconds")
    parser.add_argument("--dry-run", action="store_true",
                        help="Just load tasks and print prompts, don't run")
    args = parser.parse_args()
    
    print(f"Loading SWE-bench Lite tasks (limit={args.tasks}, offset={args.offset})...")
    tasks = load_swebench_tasks(limit=args.tasks, offset=args.offset)
    print(f"Loaded {len(tasks)} tasks")
    
    if args.dry_run:
        for t in tasks:
            print(f"\n{'─'*40}")
            print(f"Instance: {t['instance_id']}")
            print(f"Repo: {t['repo']}")
            print(f"Problem: {t['problem_statement'][:200]}...")
        return
    
    modes = ["solo", "advisor"] if args.mode == "both" else [args.mode]
    
    for mode in modes:
        print(f"\n{'═'*60}")
        print(f"  Running {mode.upper()} mode ({len(tasks)} tasks)")
        print(f"{'═'*60}")
        
        output_path = args.output
        if args.mode == "both":
            output_path = os.path.join(args.output, f"{mode}.jsonl")
        
        results = []
        for i, task in enumerate(tasks):
            print(f"\n[{i+1}/{len(tasks)}] {task['instance_id']} ({task['repo']})...")
            
            if mode == "solo":
                result = run_claude_solo(task, timeout=args.timeout)
            else:
                result = run_claude_with_advisor(task, timeout=int(args.timeout * 1.5))
            
            save_result(result, output_path)
            results.append(result)
            
            patch_status = "✓ patch extracted" if result.get("patch") else "✗ no patch"
            print(f"  → {result['duration_seconds']}s, {patch_status}")
        
        print_summary(results)


if __name__ == "__main__":
    main()
