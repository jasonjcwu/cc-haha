# Advisor Strategy 作业目标

参考 Claude 官方 advisor strategy：

https://claude.com/blog/the-advisor-strategy

## 当前收敛目标

复刻官方 advisor tool 的核心能力，并评测在 cc-haha CLI 上是否能提升 SWE-bench 风格 bugfix 质量。

核心复刻点：

1. **Executor 驱动任务**：弱/快模型负责探索、编辑、验证。
2. **Advisor 中途介入**：executor 在需要战略判断时请求 advisor，而不是固定每阶段强制调用。
3. **共享上下文**：advisor 看到 issue、executor transcript、当前 git diff。
4. **Advisor 角色受限**：只给战略 guidance / course correction / stop signal，不读文件、不跑命令、不直接产出 patch。

## 主实验

GLM 闭环迭代：

| Executor | Advisor | 模式 |
|---|---|---|
| GLM-4.5-Air (`--model haiku`) | — | Solo |
| GLM-4.5-Air (`--model haiku`) | GLM-5.1 | official-like Injected |
| GLM-5-Turbo (`--model sonnet`) | — | Solo |
| GLM-5-Turbo (`--model sonnet`) | GLM-5.1 | official-like Injected |

DeepSeek 只作为辅助对照：

| Executor | Advisor | 模式 |
|---|---|---|
| DeepSeek v4 Flash | — | Solo |
| DeepSeek v4 Flash | DeepSeek v4 Pro | official-like Injected |

## 当前阶段

- 最小闭环已跑通。
- GLM advisor 已改为走 settings 中可用的 Anthropic-compatible endpoint。
- official-like dynamic advisor loop 已实现。
- GLM solo baseline `limit=3` 已补齐：Air 2/3，Turbo 3/3。
- GLM Air injected `limit=3` 有正向信号：3/3 patch，3/3 advisor call，总耗时 730s，token/cost 4,387,564 / $3.553208。
- GLM Turbo injected 已在额度恢复后补跑 `limit=3`：3/3 patch，2/3 advisor call，平均耗时 136.5s；相比 Turbo solo 的 228.8s 更快。
- Turbo injected 已记录 token 明显更少，但 xarray 在留下 patch 后 timeout，usage 为 0；token 降幅只能作为方向性证据。
- Turbo judge 已完成：injected correctness 8.7 vs solo 8.3，test awareness 8.0 vs 6.3；两组都是 1 pass / 2 partial。
- 真实验证发现 xarray injected gold tests 为 1 passed / 1 failed，不能把 3/3 patch 当成 3/3 resolved。
- hard6 已分批跑完 Turbo solo/injected 六题。两组 patch rate 都是 6/6。
- hard6 judge 总表：injected 更快、更省已记录 token，但 correctness 7.7 < solo 8.5，minimality 6.2 < solo 7.5；test awareness 7.3 > solo 7.0。
- prompt / 调用时机第一轮迭代已完成：patch 存在时强制 pre-final review，并加入 dependency trace 与外部行为 test-oracle 检查。
- 定向 gold tests：SymPy 从失败修到 `2/2 passed`；Sphinx 两轮均为 `0/2 passed`，即使收紧行为管线 prompt 仍产出相同错误 patch。
- 对齐官方文档后，默认恢复为 executor 自主调用 advisor；runner 强制 review 仅保留为 `--force-pre-final-review` A/B 实验开关。
- 当前伪复刻仍有上下文差距：官方 advisor 自动看到完整 tool calls/results；当前 runner 只传 executor 摘要和 `git diff`。
- stream-json 上下文采集已实现：公开 tool calls/results 进入 advisor prompt，thinking/system noise 被过滤，常见 credential 被脱敏，gold tests 不泄漏。
- SymPy smoke 显示 forced review 有时能指出 relational 缺口，但 advisor 与 executor 都有方差；当前不能默认启用。
- 结论：停止围绕单题堆 prompt。下一步跑多题、多 seed 小样本，对比默认 official-like 与 `--force-pre-final-review` 的 resolved rate、调用率、token 和时延。
