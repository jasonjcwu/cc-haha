# Advisor Strategy 评测方案

> 基于 cc-haha CLI (`bin/claude-haha`) + DeepSeek/GLM Anthropic 兼容端点

## 终点

**产出有数据支撑的博客/技术报告**，核心问题：

1. Advisor 模式对国产弱模型有效吗？
2. Solo vs Injected 模式，advisor 是否提升 patch 质量？
3. 用 cc-haha CLI 作为 runner 跑评测是否可行？

## Claude 官方 advisor 机制

**server-side tool**，executor 自己决定何时调用：

```json
{"type": "advisor_20260301", "name": "advisor", "model": "claude-opus-4-7"}
```

- 只支持 Claude 模型配对
- API server 端自动转发完整对话

## 两种 Advisor 模式（cc-haha CLI 下的实现）

### Tool 模式（降级为兼容性说明）

cc-haha CLI 原生支持 tool calling，但 DeepSeek/GLM Anthropic 端点**没有** `advisor_20260301`。
所以 Tool 模式 = **Solo 模式**（无 advisor）。它不再作为主实验，只作为限制说明。

### Injected 模式（official-like dynamic advisor）— 核心差异化

模拟官方 advisor tool：executor 端到端驱动任务，遇到战略判断时用 pseudo tool 请求 advisor；advisor 只读共享上下文并返回短计划/纠偏/停止信号。

```
题目 + Advisor Tool 指令
      → Executor turn N
      → 如需指导，输出 <advisor_request>...</advisor_request>
      → runner 将 issue + transcript + current diff 发给 advisor
      → advisor 返回 guidance
      → executor 继续，直到产出 patch
```

关键：调用时机由 executor 决定；advisor 不调用工具、不直接产出 patch、不面向用户输出。外部 advisor 直接调 provider HTTP API（不走 cc-haha CLI）。

## 测试集

hard6（6 题，快速验证集，以 `question/eval/benchmark/hard6.json` 为准）：

| 题号 | Instance | 仓库 | 难度 |
|------|----------|------|------|
| 1 | django__django-10914 | django | MED |
| 2 | psf__requests-3362 | requests | MED |
| 3 | pydata__xarray-3364 | xarray | MED |
| 4 | scikit-learn__scikit-learn-10508 | sklearn | HARD |
| 5 | sphinx-doc__sphinx-7686 | sphinx | HARD |
| 6 | sympy__sympy-11400 | sympy | MED |

## 主实验配置

| 组 | Executor | 模式 | Advisor | ~调用次数 |
|---|---|---|---|---|
| A | GLM-4.5-Air (`--model haiku`) | Solo | — | 6 |
| B | GLM-4.5-Air (`--model haiku`) | Injected | GLM-5.1 | 18（3轮×6） |
| C | GLM-5-Turbo (`--model sonnet`) | Solo | — | 6 |
| D | GLM-5-Turbo (`--model sonnet`) | Injected | GLM-5.1 | 18（3轮×6） |

## 辅助对照配置

| 组 | Executor | 模式 | Advisor | ~调用次数 |
|---|---|---|---|---|
| E | DeepSeek v4 Flash (`--model haiku`) | Solo | — | 6 |
| F | DeepSeek v4 Flash (`--model haiku`) | Injected | DeepSeek v4 Pro | 18（3轮×6） |

变量控制：thinking 关、温度尽量固定、1次运行、同厂配对。GLM 模型映射以 `/Users/jasonjcwu/.claude/settings.json` 为准：`haiku -> glm-4.5-air`，`sonnet -> glm-5-turbo`，`opus/advisor -> glm-5.1`。

## 评测指标

- **Patch Rate**：生成 patch 的比例（中间指标）
- **Advisor Call Rate**：Injected 模式 core 指标
- **Delta**：Solo vs Injected 的变化
- **Judge Correctness / Minimality / Test Awareness**：用于判断 patch 质量
- **Token / Cost**：经济性

## 当前最新结果

GLM solo baseline 和 official-like injected `limit=3` 已跑完：

```text
question/eval/results/all_20260531_010941.json
question/eval/results/all_20260531_013811.json
question/eval/results/summary_solo_injected_20260531_010941_vs_013811.json
```

| Group | Patch Rate | Advisor Call Rate | Time | Token/Cost |
|---|---:|---:|---:|---:|
| GLM-Air-Solo | 2/3 | 0/3 | 860s | partial |
| GLM-Air-5.1-Injected | 3/3 | 3/3 | 730s | 4,387,564 / $3.553208 |
| GLM-Turbo-Solo | 3/3 | 0/3 | 686s | 7,227,016 / $5.343612 |
| GLM-Turbo-5.1-Injected | 3/3 | 2/3 | 410s | partial: xarray timeout |

当前结论：GLM-Air 上 advisor 有正向闭环信号，但没有 token 节省；额度恢复后，GLM-Turbo injected 也达到 3/3 patch，平均时间从 solo 的 228.8s 降到 136.5s，gold file recall proxy 从 0.56 提升到 0.72。Turbo token 降幅只能作为方向性证据，因为 xarray timeout 后 usage 缺失。下一步先补 judge/验证，再决定是否扩 hard6。

## Judge / 验证结论

```text
question/eval/results/judge_turbo_solo_vs_injected_20260531_refreshed.json
```

| Group | Avg Correctness | Avg Minimality | Avg Test Awareness | Pass / Partial / Fail |
|---|---:|---:|---:|---:|
| GLM-Turbo-Solo | 8.3 | 6.3 | 6.3 | 1 / 2 / 0 |
| GLM-Turbo-5.1-Injected | 8.7 | 5.7 | 8.0 | 1 / 2 / 0 |

真实验证：Django 和 Requests 的 injected 聚焦测试通过；xarray injected 的 SWE-bench gold tests 为 1 passed / 1 failed，失败为 `MergeError`。

决定：可以扩下一批，但仅跑剩余 3 题的 Turbo solo/injected。patch rate 只作为中间指标，不等同于 resolved rate。

## hard6 Turbo 总结

```text
question/eval/results/hard6_turbo_report_20260531.json
```

| Group | Patch Rate | Advisor Call Rate | Avg Time | Known Tokens | Known Cost |
|---|---:|---:|---:|---:|---:|
| GLM-Turbo-Solo | 6/6 | 0/6 | 141.9s | 9,171,733 | $6.947173 |
| GLM-Turbo-5.1-Injected | 6/6 | 4/6 | 94.7s | 2,519,497* | $2.332601* |

`*` injected 的 xarray timeout 后 usage 缺失，因此 token/cost 只能作为方向性证据。

| Group | Correctness | Minimality | Test Awareness | Pass / Partial / Fail |
|---|---:|---:|---:|---:|
| GLM-Turbo-Solo | 8.5 | 7.5 | 7.0 | 3 / 3 / 0 |
| GLM-Turbo-5.1-Injected | 7.7 | 6.2 | 7.3 | 2 / 4 / 0 |

结论：advisor 当前带来明显速度/token 优势和轻微测试意识提升，但质量尚未优于 solo。下一步不继续扩样本，先优化 prompt、调用时机和验证闭环。

## Prompt / 流程迭代反馈

第一轮优化新增强制 pre-final review、下游 helper trace、外部行为 test-oracle 和 executor checklist。

| Task | Gold Tests | Time | Advisor Calls | Known Tokens | Known Cost |
|---|---:|---:|---:|---:|---:|
| SymPy `sinc` / relational regression | 2/2 passed | 122.6s | 2 | 1,495,920 | $1.197920 |
| Sphinx autosummary imported members | 0/2 passed | 95.6s | 2 | 875,626 | $0.768829 |
| Sphinx behavior-pipeline prompt revision | 0/2 passed | 81.1s | 2 | 647,049 | $0.599265 |

反馈：强制 pre-final review 可以修正隐藏 dependency，但 prompt-only 优化没有稳定追踪完整行为管线。Sphinx 失败后，即使 advisor prompt 收紧为 `source -> filtering -> hooks/callbacks -> downstream consumers -> error fallbacks`，仍生成相同错误 patch。

对齐 Anthropic 官方文档后，默认使用 executor 自主调用；runner 强制 review 仅保留为 `--force-pre-final-review` A/B 开关。下一步停止堆 prompt，小规模验证公开聚焦测试失败后的 advisor correction turn；确认 resolved rate 通用提升后再启用，暂不扩样本。

上下文仍需继续对齐：官方 advisor 自动获得完整 transcript、tool calls 和 tool results；当前 runner 只传 executor 摘要与 `git diff`。`question/eval/benchmark/runner_v2.py` 已有 `stream-json` 捕获路径，但它会把 `FAIL_TO_PASS` / `PASS_TO_PASS` 暴露给 executor，不能直接作为正式评测 runner。下一步复用其采集能力并移除 gold 泄漏。

## Stream JSON 上下文采集

已完成：executor 使用 `--verbose --output-format stream-json`；advisor 获得长度受控、credential-redacted 的公开 assistant/tool transcript。thinking blocks、system noise 和 gold tests 不进入 advisor prompt。Anthropic-compatible advisor endpoint 临时 `429/5xx` 会重试一次。

SymPy 小样本结果：

| Mode | Gold Tests | Time | Advisor Calls |
|---|---:|---:|---:|
| Default official-like | 0/2 | 68.5s | 1 |
| Forced review + retry | 0/2 | 84.9s | 2 |
| Forced review + mandatory correction | 0/2 | 40.2s | 1 |

反馈：stream-json fidelity 值得保留；forced review 有时发现关键缺口，但 advisor/executor 方差仍大。停止单题 prompt 优化，下一轮跑多题、多 seed 小样本后再决定默认策略。

## 实施规划

详见 `question/eval/PLAN.md`

## 最终产出

给 cc-haha 提 PR（advisor 功能）+ 博客文章（中英双语）→ obsidian → jiachen.lol
