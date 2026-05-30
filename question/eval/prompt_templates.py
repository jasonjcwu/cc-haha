"""cc-haha CLI 评测 - Prompt 模板

所有 prompt 设计为从 stdin 传给 `./bin/claude-haha --bare -p "..."`。
"""

import json
from pathlib import Path

# ─── 通用模板 ─────────────────────────────────────────────────────────

TASK_SYSTEM_PROMPT = """You are a skilled software engineer debugging and fixing open-source repositories.
You have access to shell commands (Bash), file reading (Read), file editing (Edit), and file writing (Write).
Be thorough: read the relevant code, understand the root cause, make minimal changes, and verify."""


def build_task_prompt(instance: dict) -> str:
    """通用 SWE-bench 任务 prompt（Solo 模式用）"""
    return f"""I need you to solve a bug in the repository {instance['repo']}.

## Issue
{instance.get('problem_statement', '')[:3000]}

## Instructions
1. Explore the codebase to understand the project structure
2. Find the root cause of the bug
3. Make minimal, targeted edits
4. Verify your fix doesn't break existing tests
5. Output the final patch between ```diff and ``` markers

Start by exploring the repository structure."""


# ─── Injected 模式 三阶段模板 ─────────────────────────────────────────

def build_exploration_prompt(instance: dict) -> str:
    """Phase 1: 只探索不改代码"""
    return f"""I need you to investigate a bug in the repository {instance['repo']}.

## Issue
{instance.get('problem_statement', '')[:2000]}

## Instructions
DO NOT write any code. Only explore and understand:
1. Read the repository structure
2. Find the relevant files related to the issue
3. Identify the root cause location
4. Note any existing tests for this area

Report your findings concisely. Focus on: root cause, affected files, and how to fix."""


def build_implementation_prompt(instance: dict, exploration: str, advisor_feedback: str) -> str:
    """Phase 2: 实现修复，带探索结果和 advisor 建议"""
    # Truncate long inputs
    exploration = exploration[:4000]
    advisor_feedback = advisor_feedback[:2000]

    return f"""I need you to fix a bug in the repository {instance['repo']}.

## Issue
{instance.get('problem_statement', '')[:1500]}

## Your Previous Exploration
{exploration}

## Advisor Feedback
Your advisor has reviewed your exploration and suggests:
{advisor_feedback}

## Instructions
1. Read the relevant files identified during exploration
2. Implement the fix based on the advisor's guidance
3. Make minimal, targeted changes
4. Verify your changes
5. Output the final patch between ```diff and ``` markers"""


def build_verification_prompt(instance: dict, implementation_summary: str, advisor_feedback: str) -> str:
    """Phase 3: 验证和完善"""
    implementation_summary = implementation_summary[:3000]
    advisor_feedback = advisor_feedback[:2000]

    return f"""Review and verify the fix for {instance['repo']}.

## Issue
{instance.get('problem_statement', '')[:1000]}

## Your Implementation So Far
{implementation_summary}

## Advisor Review
Your advisor has reviewed your changes and suggests:
{advisor_feedback}

## Instructions
1. Run any relevant tests
2. Fix any remaining issues
3. Ensure the fix is complete and correct
4. Output the final patch between ```diff and ``` markers"""


def build_advisor_prompt(phase: str, context: str) -> str:
    """外部 advisor 的 prompt"""
    phase_labels = {
        "exploration": "explored the codebase",
        "implementation": "implemented the fix",
        "verification": "verified the fix",
    }
    label = phase_labels.get(phase, phase)

    return f"""You are an expert code review advisor. An AI coding agent has {label} for a software engineering task.

Review what was done and provide specific, actionable feedback:

{context[:5000]}

Rules:
- Be concise — max 300 words
- Focus on concrete next steps
- If on the right track, say so and suggest what to verify
- If going wrong, explain why and redirect
- Point out edge cases or tests to check"""


# ─── Patch extraction ──────────────────────────────────────────────────

import re

def extract_patch(text: str) -> str:
    """从 cc-haha CLI stdout 中提取 git diff patch"""
    if not text:
        return ""
    patterns = [
        r'```diff\n(.*?)```',
        r'```\n(.*?)```',
        r'(?:^|\n)(diff --git.*?)(?:\n\n|\Z)',
    ]
    for pat in patterns:
        matches = re.findall(pat, text, re.DOTALL)
        if matches:
            # Return longest match (most likely the real patch)
            best = max(matches, key=len).strip()
            if len(best) > 20:
                return best
    # Fallback: find diff --git line by line
    lines = text.splitlines()
    diff_start = -1
    for i, l in enumerate(lines):
        if l.startswith("diff --git"):
            diff_start = i
            break
    if diff_start >= 0:
        return "\n".join(lines[diff_start:]).strip()
    return ""
