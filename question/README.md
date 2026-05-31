# Advisor Strategy Workspace

This folder is now scoped to one project: evaluating an official-like advisor strategy in `cc-haha`.

## Active Goal

Implement and evaluate a dynamic advisor loop that approximates Claude's advisor tool:

- executor drives the coding task end-to-end
- executor requests advisor only when strategic guidance is useful
- advisor receives issue + executor transcript + current diff
- advisor returns guidance only, not tool calls or final patches

## Active Files

| File | Purpose |
|---|---|
| `question.md` | Current assignment goal and experiment scope |
| `test.md` | Research/report outline and experiment matrix |
| `eval/PLAN.md` | Implementation and run plan |
| `DEBUG.md` | How to run local smoke/eval commands |
| `runner_cc_haha.py` | Matrix runner |
| `eval/cc_haha_solo.py` | Solo runner |
| `eval/cc_haha_injected.py` | official-like dynamic advisor runner |
| `eval/prompt_templates.py` | Solo + pseudo advisor tool prompts |
| `eval/summarize_results.py` | Deterministic quality/token/cost summary |
| `eval/judge_results.py` | GLM-5.1 patch judge against issue + gold patch |
| `eval/terminal_bench_mini.py` | Local Terminal-Bench-style smoke harness |
| `eval/benchmark/hard6.json` | Current 6-task benchmark set |
| `advisor_tool.md` | Local copy/reference for official advisor tool behavior |

## Legacy / Background

| File or Folder | Status |
|---|---|
| `ADVISOR_IMPL.md` | Background design notes; superseded by `eval/PLAN.md` for current runs |
| `plan.md` | Historical implementation notes for client-side advisor tool |
| `bench/` | Earlier synthetic/bench experiments; not the current main path |
| `eval/benchmark/` | Older benchmark runner experiments; keep only as reference |

## Latest Signal

Latest comparable GLM runs:

```bash
python3 question/runner_cc_haha.py --mode solo --model glm --limit 3
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3
```

Result files:

```text
question/eval/results/all_20260531_010941.json
question/eval/results/all_20260531_013811.json
question/eval/results/summary_solo_injected_20260531_010941_vs_013811.json
```

Summary:

| Group | Patch Rate | Advisor Call Rate | Total Time | Known Tokens | Known Cost | Note |
|---|---:|---:|---:|---:|---:|---|
| GLM-Air-Solo | 2/3 | 0/3 | 860s | partial | partial | first task ran before usage patch; xarray timed out |
| GLM-Air-5.1-Injected | 3/3 | 3/3 | 730s | 4,387,564 | $3.553208 | stable; one advisor call per task |
| GLM-Turbo-Solo | 3/3 | 0/3 | 686s | 7,227,016 | $5.343612 | baseline complete |
| GLM-Turbo-5.1-Injected | 3/3 | 2/3 | 410s | partial | partial | rerun after quota reset; xarray left patch then timed out |

Interpretation: GLM-Air shows a useful advisor signal: patch rate improved from 2/3 to 3/3 and wall time dropped slightly, but token/cost went up on the measured injected run. After the quota reset, GLM-Turbo injected also reached 3/3 patches and reduced average wall time from 228.8s to 136.5s. Its gold file recall proxy improved from 0.56 to 0.72. Token reduction is directional only because the xarray timeout left a patch but no usage record. Run judge/validation before hard6 full.

## Judge And Verification

Turbo solo vs injected judge:

```text
question/eval/results/judge_turbo_solo_vs_injected_20260531_refreshed.json
```

| Group | Avg Correctness | Avg Minimality | Avg Test Awareness | Pass / Partial / Fail |
|---|---:|---:|---:|---:|
| GLM-Turbo-Solo | 8.3 | 6.3 | 6.3 | 1 / 2 / 0 |
| GLM-Turbo-5.1-Injected | 8.7 | 5.7 | 8.0 | 1 / 2 / 0 |

Target verification:

| Task | Injected verification |
|---|---|
| django__django-10914 | 3 focused tests passed |
| psf__requests-3362 | focused regression test passed |
| pydata__xarray-3364 | gold tests: 1 passed, 1 failed (`MergeError`) |

Decision: expand only the remaining 3 hard6 tasks as a second Turbo solo/injected batch. Do not run every GLM group at once, and do not treat patch rate as resolved rate.

## hard6 Turbo Result

The second Turbo batch is complete. Consolidated report:

```text
question/eval/results/hard6_turbo_report_20260531.json
```

| Group | Patch Rate | Advisor Call Rate | Avg Time | Known Tokens | Known Cost |
|---|---:|---:|---:|---:|---:|
| GLM-Turbo-Solo | 6/6 | 0/6 | 141.9s | 9,171,733 | $6.947173 |
| GLM-Turbo-5.1-Injected | 6/6 | 4/6 | 94.7s | 2,519,497* | $2.332601* |

`*` One injected xarray run timed out after leaving a patch, so usage is missing. Token/cost improvement is directional, not an exact percentage.

| Group | Correctness | Minimality | Test Awareness | Pass / Partial / Fail |
|---|---:|---:|---:|---:|
| GLM-Turbo-Solo | 8.5 | 7.5 | 7.0 | 3 / 3 / 0 |
| GLM-Turbo-5.1-Injected | 7.7 | 6.2 | 7.3 | 2 / 4 / 0 |

Current conclusion: advisor improves speed, recorded token use, and slightly improves test awareness, but it does not yet improve patch quality. Stop expanding the dataset for now; optimize advisor prompts, call timing, and verification behavior first.

## Prompt Iteration Feedback

The first targeted optimization pass added:

- a mandatory pre-final advisor review whenever a patch exists and budget remains
- downstream helper tracing
- test-oracle checks derived from externally observable issue behavior
- an executor checklist that requires repository evidence or a correction for each review item

Real gold-test feedback:

| Task | Result | Time | Advisor Calls | Known Tokens | Known Cost |
|---|---:|---:|---:|---:|---:|
| SymPy `sinc` / relational regression | 2/2 passed | 122.6s | 2 | 1,495,920 | $1.197920 |
| Sphinx autosummary imported members | 0/2 passed | 95.6s | 2 | 875,626 | $0.768829 |
| Sphinx behavior-pipeline prompt revision | 0/2 passed | 81.1s | 2 | 647,049 | $0.599265 |

Interpretation: forced pre-final review fixed the SymPy hidden dependency, but it did not generalize to Sphinx. The Sphinx review found the imported-member filter but missed the full behavior pipeline: skip-member hooks, downstream consumers, and missing-attribute fallbacks. An explicit `source -> filtering -> hooks/callbacks -> downstream consumers -> error fallbacks` checklist still produced the same incorrect patch.

The default runner now follows Anthropic's documented behavior more closely: the executor decides when to consult the advisor. Anthropic recommends an early call after orientation and, for difficult coding tasks, a final call after file writes and test outputs are in the transcript. Runner-level mandatory review is retained only as the experimental `--force-pre-final-review` A/B flag. Public focused-test failure injection remains a proposed experiment, not a default behavior.

The next fidelity improvement is context capture. Anthropic's server-side advisor receives the complete transcript, including tool calls and tool results. The current pseudo runner forwards executor summaries and `git diff`. `eval/benchmark/runner_v2.py` already demonstrates a `stream-json` capture path, but it must not be used as-is for evaluation because it exposes `FAIL_TO_PASS` / `PASS_TO_PASS` to the executor. Reuse the capture path, remove gold leakage, then evaluate public focused-test correction turns.

## Stream JSON Fidelity Pass

`eval/cc_haha_injected.py` now runs the executor with `--verbose --output-format stream-json`. It forwards a bounded, credential-redacted public transcript to the advisor: assistant text, tool calls, tool results, and final result metadata. Thinking blocks and system noise are excluded. Gold tests remain external-only.

SymPy smoke feedback:

| Mode | Gold Tests | Time | Advisor Calls | Outcome |
|---|---:|---:|---:|---|
| Default official-like | 0/2 | 68.5s | 1 | Captured 124 stream events; missed relational printer |
| Forced review, transient endpoint errors | not scored | 57.2s | 2 | Polluted by advisor HTTP 500 responses |
| Forced review after retry support | 0/2 | 84.9s | 2 | Advisor found relational gap; executor did not apply correction |
| Forced review with mandatory correction prompt | 0/2 | 40.2s | 1 | Advisor variance: incorrectly approved the incomplete patch |

Conclusion: keep stream-json fidelity and transient retry support. Keep `--force-pre-final-review` experimental. Do not make forced review or correction turns the default until a multi-task, multi-seed sample demonstrates a stable resolved-rate gain.

Recommended next A/B:

```bash
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3 --repeats 2
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3 --repeats 2 --force-pre-final-review
```
