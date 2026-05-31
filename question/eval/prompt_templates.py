"""cc-haha CLI 评测 - Prompt 模板

所有 prompt 设计为从 stdin 传给 `./bin/claude-haha --bare -p "..."`。
"""

import re

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


# ─── Injected 模式：官方 advisor tool 近似复刻 ───────────────────────

ADVISOR_REQUEST_OPEN = "<advisor_request>"
ADVISOR_REQUEST_CLOSE = "</advisor_request>"

ADVISOR_TOOL_SIMULATION = f"""## Advisor Tool
You have access to an advisor tool backed by a stronger model. The advisor only provides strategic guidance; it cannot read files, run commands, edit code, or produce user-facing output.

Use the advisor when a strategic decision would materially affect the solution, for example:
- after identifying the likely root cause and before substantive edits
- when choosing between competing fixes
- when the current diff may be risky, broad, or inconsistent with the issue
- before declaring a multi-step task complete, after file writes and test outputs are in the transcript
- when tests fail and the next move is unclear

To call the advisor, output exactly:
{ADVISOR_REQUEST_OPEN}
Your concise question and the relevant evidence you want reviewed.
{ADVISOR_REQUEST_CLOSE}

Then stop. The runner will return advisor guidance and you will continue the task.

Do not call the advisor for routine file reads, mechanical edits, or obvious syntax fixes. Give advice serious weight, but adapt when a step fails empirically or primary-source evidence contradicts it. If repository evidence and advisor guidance conflict, ask one concise reconcile question instead of silently switching approaches. The issue statement is authoritative."""


def build_official_like_initial_prompt(instance: dict, max_advisor_calls: int = 3) -> str:
    """Initial prompt for the dynamic advisor loop.

    This approximates the official advisor tool: the executor drives the task
    and decides when to consult the advisor, capped by max_advisor_calls.
    """
    return f"""I need you to solve a bug in the repository {instance['repo']}.

## Issue
{instance.get('problem_statement', '')[:3000]}

{ADVISOR_TOOL_SIMULATION}

## Instructions
1. Drive the task end-to-end: explore, diagnose, edit, and verify.
2. You may call the advisor up to {max_advisor_calls} times using the exact advisor_request tag.
3. Prefer consulting once after root-cause analysis and before substantial edits.
4. Keep changes minimal and targeted to the issue.
5. Before finishing, inspect the diff and run focused tests. Report the exact tests and results.
6. On a multi-step fix, ask the advisor for a final review after file writes and
   test outputs are in the transcript and before declaring the task complete.
7. Derive regression-test expectations from the issue's externally observable
   behavior, not from the current implementation output. Never bless a suspicious
   intermediate representation merely because the new code emits it.
8. When finished, output the final patch between ```diff and ``` markers.

Start by exploring the repository structure and relevant files."""


def build_official_like_continue_prompt(
    instance: dict,
    transcript: str,
    advisor_feedback: str,
    remaining_advisor_calls: int,
    current_diff: str = "",
) -> str:
    """Continue the executor after an advisor response."""
    return f"""Continue solving the bug in {instance['repo']}.

## Issue
{instance.get('problem_statement', '')[:1800]}

## Conversation So Far
{transcript[-8000:]}

## Current Diff
```diff
{current_diff[-5000:]}
```

## Advisor Guidance
{advisor_feedback[:2500]}

## Instructions
Use the advisor guidance as strategic input, but the issue statement and repository evidence are authoritative.
You have {remaining_advisor_calls} advisor call(s) remaining.
Treat advisor review items as a checklist: inspect each item, either implement
the correction or state the repository evidence that makes it unnecessary.
Run focused tests after corrections. Do not claim tests passed unless you
actually ran the command and saw a passing result.
Derive test expectations from the issue's requested external behavior. If a
new test merely records the current output, challenge whether it is masking the bug.
If another strategic decision genuinely needs advisor input, use:
{ADVISOR_REQUEST_OPEN}
question
{ADVISOR_REQUEST_CLOSE}

Otherwise continue implementation and verification. When finished, output the final patch between ```diff and ``` markers."""


def build_official_like_correction_prompt(
    instance: dict,
    transcript: str,
    advisor_feedback: str,
    remaining_advisor_calls: int,
    current_diff: str = "",
) -> str:
    """Require an executor correction pass after an experimental forced review."""
    return build_official_like_continue_prompt(
        instance,
        transcript,
        advisor_feedback,
        remaining_advisor_calls,
        current_diff=current_diff,
    ) + """

## Mandatory Correction Checkpoint
Do not finalize yet. Work through every advisor checklist item against the
repository. Apply required corrections, then inspect the updated diff and run
the most focused available tests. If you intentionally leave the diff
unchanged, cite concrete repository evidence for each rejected checklist item."""


def build_official_like_advisor_prompt(
    instance: dict,
    transcript: str,
    advisor_request: str,
    current_diff: str = "",
) -> str:
    """Prompt sent to the advisor model.

    Mirrors the official role: short strategic plan/correction/stop signal,
    no tool use, no user-facing answer.
    """
    return f"""You are a stronger advisor model supporting a lower-cost coding executor on a SWE-bench style bugfix.

The executor drives the task and owns all file reads, commands, edits, and user-facing output. You do not call tools. Provide only strategic guidance for the executor.

The issue statement is authoritative. Do not reject requested behavior merely because it changes defaults or public behavior. If the requested behavior appears risky, explain the risk and still identify the minimal path that satisfies the issue.

## Issue
{instance.get('problem_statement', '')[:3000]}

## Executor's Advisor Request
{advisor_request[:2000]}

## Conversation / Evidence So Far
{transcript[-9000:]}

## Current Diff
```diff
{current_diff[-6000:]}
```

Keep the response under 100 words. Prioritize:
1. Root-cause assessment
2. The smallest behaviorally complete plan or correction
3. Missing adjacent behavior: guards, hooks, branches, or related functions the executor may have overlooked
4. Behavior-pipeline trace: for every helper, hook, callback, or printer path
   newly relied on by the diff, follow the data one layer downstream and compare
   against adjacent established paths. Check source, filtering, hooks/callbacks,
   downstream consumers, and error fallbacks; challenge assumptions about behavior
5. Tests to add/update/run, including exact expected output where relevant and the most focused regression command
6. Test-oracle check: verify that proposed assertions encode the issue's external
   behavior rather than copying a possibly wrong implementation result
7. Diff reduction: identify edits that are unnecessary or too broad
8. A stop signal only if the executor is clearly going in the wrong direction

Be concrete and file/function specific. Do not produce a final patch."""


def extract_advisor_request(text: str) -> str:
    """Extract a pseudo advisor tool request from executor output."""
    if not text:
        return ""
    pattern = rf"{ADVISOR_REQUEST_OPEN}\s*(.*?)\s*{ADVISOR_REQUEST_CLOSE}"
    matches = re.findall(pattern, text, re.DOTALL)
    if not matches:
        return ""
    return matches[-1].strip()


# ─── Patch extraction ──────────────────────────────────────────────────

def extract_patch(text: str) -> str:
    """从 cc-haha CLI stdout 中提取 git diff patch"""
    if not text:
        return ""
    patterns = [
        r'```diff\n(.*?)```',
        r'(?:^|\n)(diff --git.*?)(?:\n\n|\Z)',
    ]
    for pat in patterns:
        matches = re.findall(pat, text, re.DOTALL)
        if matches:
            # Return longest match (most likely the real patch)
            diff_matches = [m.strip() for m in matches if "diff --git" in m]
            if not diff_matches:
                continue
            best = max(diff_matches, key=len).strip()
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
