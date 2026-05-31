# Advisor 题目拆解与当前状态

`question/question.md` 只保存领导给出的题目原文，不再承载实验进展。本文档记录基于题目的拆解、已经完成的工作、下一步计划和最终可交付的数据形态。

## 目标拆解

### 1. 增加 advisor 能力

目标不是只复刻文案，而是在 cc-haha/Claude Code 风格 agent loop 中加入一个可评测的 advisor 能力：

- executor 负责读代码、改代码、跑验证。
- advisor 只做战略判断、方案纠偏、停止信号。
- advisor 不直接读文件、不跑命令、不生成 patch。
- executor 在需要判断时调用 advisor，而不是每一步强制调用。
- advisor 上下文尽量接近官方机制：任务描述、executor transcript、tool calls/results、当前 diff。

官方 `advisor_20260301` 是 Anthropic server-side tool。DeepSeek/GLM 等 Anthropic-compatible endpoint 不支持这个 server tool，所以当前评测主线采用 official-like injected runner：用 pseudo advisor request + 外部 advisor HTTP 调用模拟官方流程。

### 2. 评测 advisor 能力

评测要回答的问题：

- advisor 是否提升 resolved rate，而不只是 patch rate。
- advisor 是否减少耗时、token、成本。
- advisor 是否提高测试意识、patch minimality、正确性。
- 哪些模型组合受益，哪些组合不受益。
- official-like 默认调用策略与 `--force-pre-final-review` 实验策略哪个更稳。

模型组合不限定于 Haiku 4.5 + Opus 4.7。当前本地可跑组合以 provider 可用性为准：

| Executor | Advisor | 作用 |
|---|---|---|
| GLM-4.5-Air | GLM-5.1 | 主实验：弱模型 + 强 advisor |
| GLM-5-Turbo | GLM-5.1 | 主实验：中模型 + 强 advisor |
| DeepSeek v4 Flash | DeepSeek v4 Pro | 辅助对照 |
| LongCat 或其他可用 executor | 可用强模型 advisor | 扩展实验，先确认 CLI/provider mapping |
| Claude Haiku/Sonnet | Claude Opus | 官方基线，取决于可用 API 权限 |

## 已完成

- 最小 cc-haha CLI 评测闭环已跑通。
- official-like dynamic injected runner 已实现。
- GLM advisor 已能走 settings 中可用的 Anthropic-compatible endpoint。
- `stream-json` 上下文采集已实现：公开 tool calls/results 进入 advisor prompt，thinking/system noise 被过滤，常见 credential 被脱敏，gold tests 不泄漏。
- Turbo hard6 已跑完 solo/injected 六题。
- 已做结构化 judge 和部分真实 gold/focused test 验证。
- `--force-pre-final-review` 已保留为实验开关，不作为默认策略。

## 当前数据结论

### GLM Turbo hard6

结果文件：

```text
question/eval/results/hard6_turbo_report_20260531.json
question/eval/results/judge_turbo_hard6_batch2_20260531_111903.json
```

| Group | Patch Rate | Advisor Call Rate | Avg Time | Known Tokens | Known Cost |
|---|---:|---:|---:|---:|---:|
| GLM-Turbo-Solo | 6/6 | 0/6 | 141.9s | 9,171,733 | $6.947173 |
| GLM-Turbo-5.1-Injected | 6/6 | 4/6 | 94.7s | 2,519,497* | $2.332601* |

`*` injected 的 xarray run timeout 后留下 patch，但 usage 缺失，所以 token/cost 只能作为方向性证据。

| Group | Correctness | Minimality | Test Awareness | Pass / Partial / Fail |
|---|---:|---:|---:|---:|
| GLM-Turbo-Solo | 8.5 | 7.5 | 7.0 | 3 / 3 / 0 |
| GLM-Turbo-5.1-Injected | 7.7 | 6.2 | 7.3 | 2 / 4 / 0 |

当前结论：advisor 带来速度和已记录 token/cost 优势，并略微提高 test awareness，但没有提升 patch 质量。不能把 `has_patch` 当成 resolved。

### Prompt / 调用时机实验

强制 pre-final review 对 SymPy 曾修到 `2/2 passed`，但 Sphinx 两轮仍为 `0/2 passed`。说明单题 prompt 加强不能证明泛化收益。默认策略应继续保持 executor 自主调用 advisor，强制 review 只做 A/B 实验。

## 下一步

1. 先做数据整理，而不是继续扩平台能力。
2. 跑多题、多 seed 小样本：

```bash
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3 --repeats 2
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3 --repeats 2 --force-pre-final-review
```

3. 补一个 report/dashboard，把已有 JSONL/JSON 统一成同一张证据表。
4. 再决定是否扩 LongCat、Claude 官方组合或更多 benchmark。

## 最终可抛出的数据

面向汇报时，建议给出一张主表和三张辅助图：

| Dimension | 必须展示 |
|---|---|
| Quality | resolved / judge pass-partial-fail / correctness / minimality / test awareness |
| Efficiency | avg wall time / timeout rate / executor turns / advisor calls |
| Cost | total tokens / executor tokens / advisor tokens / known cost |
| Behavior | advisor call timing / 是否 forced review / 是否 correction turn |
| Coverage | benchmark、题目数量、seed 数、模型组合 |

结论口径要分清：

- `has_patch` 是中间指标。
- judge score 是质量 proxy。
- focused/gold tests 才能支撑 resolved。
- token/cost 缺失时只能说 directional，不能说精确节省比例。
