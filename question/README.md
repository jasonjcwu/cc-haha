# Advisor Strategy Workspace

This folder is the workspace for the advisor assignment. Keep the original assignment separate from implementation notes, experiments, generated results, and final reporting.

## File Map

| Path | Purpose |
|---|---|
| `question.md` | Boss-provided assignment text. Treat as immutable. |
| `STATUS.md` | Current decomposition, findings, next steps, and reportable data shape. |
| `test.md` | Research/report outline and experiment narrative. |
| `eval/PLAN.md` | Detailed implementation and run plan for the current eval harness. |
| `eval/VISUAL_PLAN.md` | Focused evidence report/dashboard plan. |
| `DEBUG.md` | Local smoke/eval command notes. |
| `runner_cc_haha.py` | Matrix runner for cc-haha CLI experiments. |
| `eval/cc_haha_solo.py` | Solo runner. |
| `eval/cc_haha_injected.py` | official-like dynamic advisor runner. |
| `eval/prompt_templates.py` | Solo + pseudo advisor tool prompts. |
| `eval/summarize_results.py` | Deterministic quality/token/cost summary. |
| `eval/judge_results.py` | GLM-5.1 patch judge against issue + gold patch. |
| `eval/terminal_bench_mini.py` | Local Terminal-Bench-style smoke harness. |
| `eval/benchmark/hard6.json` | Current 6-task SWE-bench-style benchmark set. |
| `advisor_tool.md` | Local copy/reference for official advisor tool behavior. |

## Working Rules

- Do not put progress notes into `question.md`.
- Keep generated eval outputs under `question/eval/results/`; they are local artifacts and should not be committed.
- Use `STATUS.md` for current conclusions and next steps.
- Use `eval/PLAN.md` for runner implementation details.
- Use `eval/VISUAL_PLAN.md` only for the report/dashboard that turns eval artifacts into evidence.

## Current Direction

The current path is:

1. Preserve the original task.
2. Implement official-like advisor behavior in cc-haha/Claude Code style.
3. Evaluate model pairs with solo vs injected runs.
4. Report resolved rate, judge quality, advisor call rate, time, tokens, cost, and timeout behavior.

The key current warning is that `has_patch` is not `resolved`. Report patch rate as an intermediate metric only.
