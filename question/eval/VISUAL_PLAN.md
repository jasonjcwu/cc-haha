# Advisor Eval Evidence Dashboard Plan

目标不是先做通用题库平台，而是把现有 advisor eval 结果整理成可汇报的数据证据，回答 `question/question.md` 里的问题：advisor 能力到底带来了什么。

## 输出目标

生成一个本地 evidence report/dashboard，能直接回答：

1. 哪些 executor/advisor 组合有效。
2. Solo vs Injected 在质量、速度、token、成本上的变化。
3. official-like 默认策略 vs `--force-pre-final-review` 是否有稳定收益。
4. 当前结论能否支撑继续扩大到 LongCat、Claude 官方组合或更多 benchmark。

## 数据源

| Source | 用途 |
|---|---|
| `question/eval/results/*.jsonl` | 单次 run 原始结果 |
| `question/eval/results/all_*.json` | 同批次合并结果 |
| `question/eval/results/summary_*.json` | deterministic summary |
| `question/eval/results/judge_*.json` | LLM judge 质量评分 |
| `question/eval/results/*report*.json` | 人工/脚本汇总报告 |
| `question/eval/benchmark/hard6.json` | benchmark 题目元数据和 gold patch/test patch |

先只读现有文件，不触发 runner，不做题库导入，不新增 BrowseComp/TB2 抽题功能。

## 核心指标

| 指标 | 说明 | 优先级 |
|---|---|---|
| `resolved_status` | gold/focused tests > judge pass/partial/fail > patch-only > timeout/unknown | P0 |
| `patch_rate` | 只表示产出 patch，不等于解决问题 | P0 |
| `advisor_call_rate` | injected 是否真的调用 advisor | P0 |
| `avg_wall_seconds` | 平均耗时 | P0 |
| `total_tokens` | 已记录总 token；缺失要标 partial | P0 |
| `total_cost_usd` | 已记录成本；缺失要标 partial | P0 |
| `correctness` | judge 正确性分 | P1 |
| `minimality` | judge 最小改动分 | P1 |
| `test_awareness` | judge 测试意识分 | P1 |
| `timeouts` | timeout 次数和位置 | P1 |
| `advisor_timing` | advisor 在第几 turn 调用、是否 forced review | P2 |

## 主视图

### 1. Evidence Table

每行是一个 `run group x instance x repeat`：

| Instance | Group | Mode | Repeat | Status | Patch | Judge | Time | Tokens | Cost | Advisor Calls | Timeout |
|---|---|---|---:|---|---|---|---:|---:|---:|---:|---:|
| django__django-10914 | GLM-Turbo-Solo | solo | 1 | judged-pass | yes | pass | 138s | known | known | 0 | 0 |
| django__django-10914 | GLM-Turbo-5.1-Injected | injected | 1 | judged-pass | yes | pass | 95s | known | known | 1 | 0 |
| pydata__xarray-3364 | GLM-Turbo-5.1-Injected | injected | 1 | gold-fail | yes | partial | 600s | partial | partial | 1 | 1 |

Status 规则：

- `gold-pass`: gold/focused tests 全部通过。
- `gold-fail`: gold/focused tests 有失败。
- `judged-pass`: judge 给 pass，但没有 gold/focused tests。
- `judged-partial`: judge 给 partial。
- `judged-fail`: judge 给 fail。
- `patch-only`: 有 patch 但无 judge/test 证据。
- `no-patch`: 没有 patch。
- `timeout`: run 或 phase timeout。
- `unknown`: 数据不足。

### 2. Group Summary

| Group | N | Resolved | Judge Pass/Partial/Fail | Patch Rate | Advisor Call Rate | Avg Time | Known Tokens | Known Cost |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| GLM-Turbo-Solo | 6 | TBD | 3/3/0 | 6/6 | 0/6 | 141.9s | 9,171,733 | $6.947173 |
| GLM-Turbo-5.1-Injected | 6 | TBD | 2/4/0 | 6/6 | 4/6 | 94.7s | partial | partial |

这里的 `Resolved` 只能来自真实验证；没有真实验证时显示 `TBD`，不要用 patch rate 代替。

### 3. Delta View

按同一 instance 对齐 solo/injected：

| Instance | Family | Quality Delta | Time Delta | Token Delta | Advisor Calls | Note |
|---|---|---:|---:|---:|---:|---|
| django__django-10914 | GLM-Turbo | same/pass | faster | lower | 1 | clean win |
| pydata__xarray-3364 | GLM-Turbo | worse/gold-fail | timeout | partial | 1 | patch exists but not resolved |

### 4. Call Timeline

对 injected run 展示 phase/advisor sequence：

```text
executor_turn_1 14.6s -> advisor 1 -> executor_turn_2 25.4s -> patch
```

从 `phases[]`、`advisor_calls[]`、`usage`、`total_cost_usd` 读取，不再假设固定三阶段。

## 实现路线

### Step 1: Normalizer

新增一个只读脚本，例如 `question/eval/build_evidence_report.py`：

- 扫描 `results/*.jsonl` 和 `all_*.json`。
- 复用 `summarize_results.py` 的 patch/gold-file 解析逻辑。
- 合并 judge JSON 中的 pass/partial/fail 和分数。
- 输出 normalized JSON：`results/evidence_latest.json`。

### Step 2: Markdown Report

从 normalized JSON 生成：

```text
question/eval/results/advisor_evidence_report.md
```

报告包含：

- executive summary
- group summary
- solo vs injected delta
- default vs force-pre-final-review delta
- known evidence gaps
- next run recommendations

### Step 3: Optional Local Dashboard

如果 Markdown 不够，再做零构建本地页面：

```text
python3 -m http.server 8888 --directory question/eval/static
```

前端只读取 `evidence_latest.json`。不需要 FastAPI、SQLite、题库管理或在线触发 runner。

## 暂不做

- 不做通用题库管理。
- 不做随机抽题 UI。
- 不在 dashboard 里触发付费评测。
- 不把 BrowseComp/Terminal-Bench 2.0 纳入当前 MVP。
- 不用 `has_patch` 显示绿色成功。

## 最终汇报口径

当前已经可以抛出的结论形态：

```text
在 hard6 Turbo 小样本上，official-like advisor injected 相比 solo 明显降低平均耗时，并在已记录样本中降低 token/cost；但 judge 质量从 3 pass / 3 partial 降到 2 pass / 4 partial，尚不能证明 advisor 提升 patch 质量。下一步需要多题、多 seed，对比默认策略和 forced review，核心看 resolved rate，而不是 patch rate。
```

后续如果 LongCat 或 Claude 官方组合可跑，把它们作为新 family 加进同一张 evidence table，而不是另起一套指标。
