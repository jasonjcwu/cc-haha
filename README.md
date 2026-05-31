# cc-haha Advisor Research

这个仓库当前用于完成 advisor 题目：基于 Claude Code 开源/泄露源码路线，在 cc-haha 的 CLI/runtime 路径中增加 official-like advisor 能力，并评测 advisor 是否真的提升 agentic coding 质量。

原始题目保存在 [question/question.md](question/question.md)。题目原文不可修改；拆解、进展和结论记录在 [question/STATUS.md](question/STATUS.md)。

## 当前范围

本次任务只关注 Claude Code / cc-haha 的核心 agent 路径：

- `bin/claude-haha`
- `src/` CLI、agent loop、tool/runtime、provider 相关代码
- `question/` advisor 实验、runner、benchmark、报告

仓库里仍保留了桌面端、IM adapter、VitePress docs、release 等产品代码，但这些不是当前 advisor 题目的主线。

| 目录 | 当前处理方式 |
|---|---|
| `src/` | 主关注：advisor 能力应落在 CLI/runtime/agent loop 相关路径 |
| `bin/` | 主关注：本地 CLI 入口 |
| `question/` | 主关注：题目、实验设计、runner、结果分析 |
| `desktop/` | 暂不删除；本次不作为 advisor 评测依据 |
| `adapters/` | 暂不删除；本次不作为 advisor 评测依据 |
| `docs/` | 暂不删除；只在需要说明运行方式时更新 |
| release / packaging | 暂不触碰 |

如果最终只需要一个干净的 Claude Code advisor fork，建议后续单独开 slim 分支裁剪，而不是在评测阶段直接删除 GUI 等产品面。

## Advisor 目标

官方 advisor strategy 的关键不是固定阶段强制 review，而是让 executor 在合适时机向更强模型请求战略建议：

- executor 负责探索、编辑、验证。
- advisor 只给 strategy / course correction / stop signal。
- advisor 不直接读文件、不跑命令、不生成 patch。
- advisor 应看到任务描述、executor transcript、公开 tool calls/results 和当前 diff。

Anthropic 原生 `advisor_20260301` 是 server-side tool。DeepSeek/GLM 等 Anthropic-compatible endpoint 不支持这个工具，因此当前实验使用 official-like injected runner：executor 用 pseudo advisor request 请求外部 advisor，runner 再把 guidance 注入下一轮 executor。

## 评测问题

最终报告需要回答：

1. advisor 是否提升 resolved rate，而不仅是 patch rate。
2. advisor 是否减少 wall time、token 和成本。
3. advisor 是否提高 correctness、minimality、test awareness。
4. 哪些模型组合受益，哪些不受益。
5. 默认 official-like 策略和 `--force-pre-final-review` 实验策略哪个更稳。

可扩展模型组合不限于 Haiku 4.5 + Opus 4.7，也可以包括 GLM、DeepSeek、LongCat 或其他 provider。当前本地优先看 provider 可用性和 cc-haha 模型映射。

## 关键文件

| 文件 | 说明 |
|---|---|
| [question/question.md](question/question.md) | 题目原文 |
| [question/STATUS.md](question/STATUS.md) | 当前拆解、结论、下一步 |
| [question/test.md](question/test.md) | 研究/报告叙事和实验矩阵 |
| [question/eval/PLAN.md](question/eval/PLAN.md) | 评测 runner 实施计划 |
| [question/eval/VISUAL_PLAN.md](question/eval/VISUAL_PLAN.md) | evidence report/dashboard 计划 |
| [question/runner_cc_haha.py](question/runner_cc_haha.py) | 评测矩阵入口 |
| [question/eval/cc_haha_solo.py](question/eval/cc_haha_solo.py) | solo runner |
| [question/eval/cc_haha_injected.py](question/eval/cc_haha_injected.py) | official-like injected advisor runner |
| [question/eval/summarize_results.py](question/eval/summarize_results.py) | deterministic summary |
| [question/eval/judge_results.py](question/eval/judge_results.py) | patch judge |

## 运行方式

安装依赖：

```bash
bun install
```

启动 CLI：

```bash
./bin/claude-haha
```

运行 advisor 评测示例：

```bash
python3 question/runner_cc_haha.py --mode solo --model glm --limit 3
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3
python3 question/eval/summarize_results.py question/eval/results/all_*.json
```

下一轮建议的 A/B：

```bash
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3 --repeats 2
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3 --repeats 2 --force-pre-final-review
```

## 当前结论口径

已跑的小样本显示：advisor injected 在 GLM Turbo hard6 上明显降低平均耗时，并在已记录样本中降低 token/cost；但 judge 质量没有优于 solo。因此现在只能说 advisor 对效率有正向信号，不能说已证明 patch 质量提升。

汇报时要区分：

- `has_patch` 是中间指标，不等于 resolved。
- judge score 是质量 proxy。
- focused/gold tests 才能支撑 resolved。
- token/cost 有缺失时只能说 directional，不能说精确节省比例。

## 生成结果

本地评测输出放在：

```text
question/eval/results/
```

该目录是本地 artifact，不提交。需要汇报时用 report/dashboard 从这些 JSONL/JSON 中生成 evidence table。

## 后续裁剪建议

如果要从 cc-haha 中切出一个只保留 Claude Code advisor 能力的干净版本，建议按下面顺序做：

1. 先固定 advisor 方案和评测结论。
2. 新建 slim 分支。
3. 保留 `bin/`、`src/`、必要配置、`question/`、最小 docs。
4. 删除或迁出 `desktop/`、`adapters/`、release packaging、桌面截图和产品文档。
5. 重新跑 CLI/runtime 和 advisor eval smoke，确认裁剪没有破坏主路径。

这样可以避免在评测尚未定型时，把大量 GUI/adapter/release 删除混进 advisor 实验结果里。
