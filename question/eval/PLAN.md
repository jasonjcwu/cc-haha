# cc-haha CLI 评测实施规划

## 1. 环境配置

### 1.1 DeepSeek

```bash
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_API_KEY="sk-..."  # 来自 auth.json → deepseek
unset ANTHROPIC_AUTH_TOKEN
```

模型映射（DeepSeek 服务端自动做）：
| claude-haiku/sonnet → deepseek-v4-flash |
| claude-opus → deepseek-v4-pro |

**配置存储**：写一个 `scripts/set-env-ds.sh` 和 `scripts/set-env-glm.sh`

### 1.2 GLM

```bash
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
export ANTHROPIC_API_KEY="5e3490..."  # 来自 auth.json → custom:glmcode
unset ANTHROPIC_AUTH_TOKEN
```

模型映射（来自 `/Users/jasonjcwu/.claude/settings.json`）：
| claude-haiku → glm-4.5-air |
| claude-sonnet → glm-5-turbo |
| claude-opus → glm-5.1 |
| advisorModel → glm-5.1 |

## 2. 评测架构

### 2.1 主实验：GLM 闭环迭代

| 组 | Executor | 模式 | Advisor | Runner | 调用次数 |
|---|---|---|---|---|---|
| A | GLM-4.5-Air (`--model haiku`) | Solo | — | cc-haha CLI | 6 |
| B | GLM-4.5-Air (`--model haiku`) | Injected | GLM-5.1 | cc-haha CLI 多轮 + 外部 advisor | 6 × 3轮 = 18 |
| C | GLM-5-Turbo (`--model sonnet`) | Solo | — | cc-haha CLI | 6 |
| D | GLM-5-Turbo (`--model sonnet`) | Injected | GLM-5.1 | cc-haha CLI 多轮 + 外部 advisor | 6 × 3轮 = 18 |
| **总计** | | | | | **48 次 CLI 调用** |

### 2.2 DeepSeek 辅助实验

DeepSeek 当前只保留 `deepseek-v4-flash` 和 `deepseek-v4-pro` 两档模型，因此 DeepSeek 只做一组 sanity / 横向对照：

| 组 | Executor | 模式 | Advisor | Runner | 调用次数 |
|---|---|---|---|---|---|
| E | DeepSeek v4 Flash (`--model haiku`) | Solo | — | cc-haha CLI | 6 |
| F | DeepSeek v4 Flash (`--model haiku`) | Injected | DeepSeek v4 Pro | cc-haha CLI 多轮 + 外部 advisor | 6 × 3轮 = 18 |

### 2.3 Solo 模式

最简单的模式，一次调用：

```python
def run_solo(instance, env_config):
    prompt = build_task_prompt(instance)
    result = subprocess.run([
        "./bin/claude-haha", "--bare", "-p", prompt
    ], env=env_config, capture_output=True, text=True, timeout=600)
    patch = extract_patch(result.stdout)
    return {"patch": patch, "success": bool(patch), "time": ...}
```

### 2.4 Tool 模式（降级为说明，不作为主实验）

DeepSeek/GLM Anthropic 端点都不支持 `advisor_20260301` server-side advisor。因此 Tool 模式不作为主实验；如果保留运行，只能作为 Solo 等价对照，不能用于证明 advisor 效果。

### 2.5 Injected 模式 — 官方 advisor tool 近似复刻

官方 advisor strategy 的关键不是固定三阶段，而是：executor 端到端驱动任务，在遇到战略判断时调用 advisor；advisor 只读共享上下文、返回短计划/纠偏/停止信号，不调用工具、不产生用户可见输出。

本地复刻采用 pseudo-tool 协议：

```
题目 + Advisor Tool 指令
      ↓
Executor turn N：探索 / 编辑 / 验证
      ↓
如果需要战略指导，executor 输出 <advisor_request>...</advisor_request> 并停止
      ↓
Runner 将 issue + executor transcript + current git diff 发给 advisor
      ↓
Advisor 返回 400-700 token guidance
      ↓
Runner 把 guidance 作为 tool result 注入下一轮 executor prompt
      ↓
直到产出 patch / advisor 调用耗尽 / executor turn 耗尽
```

**关键设计点**：

a) **调用时机由 executor 决定**：runner 不再固定探索/实现/验证三段；executor 通过 `<advisor_request>` 伪 tool 请求 advisor。

b) **advisor 上下文尽量接近官方共享上下文**：包含 issue statement、executor transcript、当前 `git diff`。

c) **advisor 角色受限**：只给 plan/correction/stop signal，不读文件、不跑命令、不生成最终 patch。

d) **调用上限**：默认最多 3 次 advisor call，最多 4 个 executor turns，对齐官方 `max_uses` 的成本控制思路。

e) **外部 advisor API 直接调 provider HTTP API**（不走 cc-haha）：
   - DeepSeek 组：用 `deepseek-v4-pro` 作为 advisor
   - GLM 组：用 `glm-5.1` 作为 advisor，走 settings 中已验证可用的 Anthropic-compatible endpoint

### 2.6 cc-haha CLI 启动开销

实测 `--bare -p` 模式：
- 每次启动 ~15-30s（即使 prompt 很简单）
- 6 题 × 每模式 3 轮 = 18 次启动 ≈ 5-9 分钟纯启动开销

**优化**：--bare 模式不能跳过，但可以减小每次的 prompt 长度。

## 3. 文件清单

### 新建文件

| 文件 | 用途 |
|------|------|
| `scripts/set-env-ds.sh` | 设置 DeepSeek 环境变量 |
| `scripts/set-env-glm.sh` | 设置 GLM 环境变量 |
| `question/runner_cc_haha.py` | 评测入口（Python，管理 GLM 主实验 + DeepSeek 辅助实验） |
| `question/eval/cc_haha_solo.py` | Solo 模式：调 cc-haha CLI |
| `question/eval/cc_haha_injected.py` | Injected 模式：official-like dynamic advisor loop |
| `question/eval/prompt_templates.py` | Solo prompt + pseudo advisor tool prompt |
| `question/eval/summarize_results.py` | 汇总 patch/time/token/cost + gold file overlap |
| `question/eval/judge_results.py` | 用 GLM-5.1 对 issue + gold patch + candidate patch 做结构化 judge |
| `question/eval/terminal_bench_mini.py` | 本地 Terminal-Bench-style smoke harness |

### 修改文件

| 文件 | 改动 |
|------|------|
| `question/test.md` | 已更新 |

### 废弃文件

| 文件 | 原因 |
|------|------|
| `question/eval/agent_loop.py` | 替换为 cc-haha CLI |
| `question/eval/swe_runner.py` | 替换为 runner_cc_haha.py |
| `question/eval/runner_injected.py` | 替换为 cc_haha_injected.py |

## 4. 实现步骤

### Step 1: 环境脚本
- `set-env-ds.sh`: export ANTHROPIC_BASE_URL + key, unset AUTH_TOKEN
- `set-env-glm.sh`: 同上但用 GLM 端点
- 测试: `source set-env-ds.sh && ./bin/claude-haha --bare -p "hi"`

### Step 2: prompt_templates.py
- `build_task_prompt(instance)` — 通用 SWE-bench prompt
- `build_official_like_initial_prompt(instance)` — 初始任务 + pseudo advisor tool 指令
- `build_official_like_continue_prompt(...)` — 注入 advisor guidance 后继续
- `build_official_like_advisor_prompt(...)` — 调外部 advisor 的完整上下文 prompt
- `extract_advisor_request(text)` — 捕获 executor 的 pseudo tool call

### Step 3: cc_haha_solo.py
- 调 cc-haha CLI subprocess
- 从 stdout 提取 patch（```diff 块）
- 计时、计费（从 CLI 输出估算）

### Step 4: cc_haha_injected.py
- Executor turn: 调 cc-haha CLI
- 如输出 `<advisor_request>`：调外部 advisor API
- 将 advisor guidance 作为 tool result 注入下一轮 prompt
- 最多 3 次 advisor call / 4 个 executor turns
- 从 stdout 或 `git diff` 提取最终 patch

### Step 5: runner_cc_haha.py
- 加载 hard6.json
- 遍历 GLM 主实验和 DeepSeek 辅助实验配置
- 对每组调 solo/injected
- 输出结果 JSONL + 汇总

## 5. 预估成本

| 模型 | 单价 | 预估用量 | 成本 |
|------|------|---------|------|
| DS v4 Flash (executor) | 按 DeepSeek 当前套餐 | ~3K in, ~8K out × 24 runs | 待实测 |
| DS v4 Pro (advisor) | 按 DeepSeek 当前套餐 | ~5K in, ~1K out × 12 runs | 待实测 |
| GLM-4.5-Air / GLM-5-Turbo (executor) | 编码套餐 | ~3K in, ~8K out × 48 runs | 依套餐 |
| GLM-5.1 (advisor) | 编码套餐 | ~5K in, ~1K out × 24 runs | 依套餐 |
| **总计** | | | **待 full run 后回填** |

## 6. 验证方法

每题生成 patch 后：
1. 存为 `predictions/{group}/{instance_id}.diff`
2. 用 AI judge（DS Flash 免费）打分：正确性 + 最小性
3. 对比 solo vs injected 的 patch 率和分数
4. 如需精确评测 → SWE-bench Docker 环境

## 6.1 当前最新信号

已跑：

```bash
python3 question/runner_cc_haha.py --mode solo --model glm --limit 3
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3
python3 question/eval/summarize_results.py \
  question/eval/results/all_20260531_010941.json \
  question/eval/results/all_20260531_013811.json
```

结果文件：

```text
question/eval/results/all_20260531_010941.json
question/eval/results/all_20260531_013811.json
question/eval/results/summary_solo_injected_20260531_010941_vs_013811.json
```

| Group | Patch Rate | Advisor Call Rate | Total Time | Known Tokens | Known Cost | Notes |
|---|---:|---:|---:|---:|---:|---|
| GLM-Air-Solo | 2/3 | 0/3 | 860s | partial | partial | xarray timeout; first task predates usage patch |
| GLM-Air-5.1-Injected | 3/3 | 3/3 | 730s | 4,387,564 | $3.553208 | stable; one advisor call per task |
| GLM-Turbo-Solo | 3/3 | 0/3 | 686s | 7,227,016 | $5.343612 | complete baseline |
| GLM-Turbo-5.1-Injected | 3/3 | 2/3 | 410s | partial | partial | rerun after quota reset; xarray left patch then timed out |

结论：

1. **GLM-Air advisor 有正向信号**：patch rate 2/3 → 3/3，耗时 860s → 730s；但 injected token/cost 更高，不能说 token 减少。
2. **GLM-Turbo advisor 也有正向信号**：额度恢复后补跑达到 3/3 patch、2/3 advisor call；平均耗时 228.8s → 136.5s，gold file recall proxy 0.56 → 0.72。
3. **Turbo token 降幅只能作为方向性证据**：xarray 在留下 patch 后 timeout，usage 为 0，不能把汇总 token delta 当作精确节省比例。
4. **不建议立刻 hard6 全量**：先补 judge/验证；全量时按组分批跑，避免再次触发五小时额度上限。
5. **质量仍需 judge/验证**：当前 summary 只是 deterministic proxy（patch 文件、测试文件、gold overlap），不能替代 SWE-bench Docker 或 LLM judge。

## 6.2 Judge / Verification 结果

结构化 judge：

```text
question/eval/results/judge_turbo_solo_vs_injected_20260531_refreshed.json
```

| Group | Avg Correctness | Avg Minimality | Avg Test Awareness | Pass / Partial / Fail |
|---|---:|---:|---:|---:|
| GLM-Turbo-Solo | 8.3 | 6.3 | 6.3 | 1 / 2 / 0 |
| GLM-Turbo-5.1-Injected | 8.7 | 5.7 | 8.0 | 1 / 2 / 0 |

真实目标验证：

| Task | Injected 结果 |
|---|---|
| django__django-10914 | 3 个聚焦测试通过 |
| psf__requests-3362 | 聚焦回归测试通过 |
| pydata__xarray-3364 | SWE-bench gold tests：1 passed / 1 failed，失败为 `MergeError` |

结论：advisor 有方向性收益，但 patch rate 不能等同于 resolved rate。允许扩下一批，但只跑剩余 3 题的 Turbo solo/injected；不要一次把四组 hard6 全开。

## 6.3 hard6 Turbo 总结

```text
question/eval/results/hard6_turbo_report_20260531.json
```

| Group | Patch Rate | Advisor Call Rate | Avg Time | Known Tokens | Known Cost |
|---|---:|---:|---:|---:|---:|
| GLM-Turbo-Solo | 6/6 | 0/6 | 141.9s | 9,171,733 | $6.947173 |
| GLM-Turbo-5.1-Injected | 6/6 | 4/6 | 94.7s | 2,519,497* | $2.332601* |

`*` injected xarray timeout 后留下 patch，但 usage 缺失，因此 token/cost 优势只能作为方向性证据。

| Group | Correctness | Minimality | Test Awareness | Pass / Partial / Fail |
|---|---:|---:|---:|---:|
| GLM-Turbo-Solo | 8.5 | 7.5 | 7.0 | 3 / 3 / 0 |
| GLM-Turbo-5.1-Injected | 7.7 | 6.2 | 7.3 | 2 / 4 / 0 |

结论：advisor 当前明显提升速度、已记录 token 效率和少量测试意识，但没有提升 patch 质量。停止继续扩样本，优先优化：

1. advisor prompt：强调 minimal patch、gold-like behavior、先验证再结束。
2. 调用时机：复杂任务在 implementation 后增加一次 review 请求，不只在探索阶段请求。
3. 验证闭环：runner 在 patch 产出后执行聚焦测试；失败时允许一次 advisor correction turn。

## 6.3.1 Prompt / 流程迭代反馈

第一轮定向优化已实现：

1. patch 已存在且仍有预算时，runner 强制执行一次 pre-final advisor review。
2. advisor 检查新增下游 helper trace 和外部行为 test-oracle 检查。
3. executor 必须把 review item 当作 checklist：实现修正，或给出仓库证据说明无需修改。

真实 gold tests：

| Task | Result | Time | Advisor Calls | Known Tokens | Known Cost |
|---|---:|---:|---:|---:|---:|
| SymPy `sinc` / relational regression | 2/2 passed | 122.6s | 2 | 1,495,920 | $1.197920 |
| Sphinx autosummary imported members | 0/2 passed | 95.6s | 2 | 875,626 | $0.768829 |
| Sphinx behavior-pipeline prompt revision | 0/2 passed | 81.1s | 2 | 647,049 | $0.599265 |

结论：pre-final review 对 SymPy 有效，补到了 `_print_Relational` 隐藏依赖；但尚未泛化到 Sphinx。Sphinx review 只发现 imported-member filter，漏掉 `autodoc-skip-member` hook、下游 consumer 和 missing-attribute fallback。即使 prompt 收紧为完整行为管线追踪：`source -> filtering -> hooks/callbacks -> downstream consumers -> error fallbacks`，仍产出同一错误 patch。

对齐 Anthropic 官方文档后，默认策略恢复为 executor 自主决定 advisor 调用时机。官方 coding 建议是：orientation 后、实质修改前尽早调用；困难任务在文件写入和测试输出已进入 transcript 后、宣布完成前再调用。runner 级强制 review 不是官方机制，已保留为可选 `--force-pre-final-review` A/B flag。

下一步不要立即扩样本，也不要继续堆 prompt。“公开聚焦测试失败 -> advisor correction turn”属于待验证增强实验；gold tests 仅作为外部裁判，不能泄漏给 executor。先用小规模 A/B 验证它是否稳定提升 resolved rate，再决定是否启用。

上下文保真度是下一项优先工作。官方 advisor 自动看到 system prompt、完整 transcript、全部 tool calls 和 tool results；当前 `cc_haha_injected.py` 只传 executor 摘要和 `git diff`。仓库已有 `question/eval/benchmark/runner_v2.py` 使用 `stream-json` 捕获 tool history，可复用其采集路径，但不能直接作为正式 runner：它会把 `FAIL_TO_PASS` / `PASS_TO_PASS` 暴露给 executor，污染隐藏评测。正式改造应复用 `stream-json`，删除 gold 泄漏，仅把公开工具输出和测试输出放入 advisor 上下文。

## 6.3.2 Stream JSON 上下文保真度

已实现：

1. executor 改为 `--verbose --output-format stream-json`。
2. advisor 上下文包含长度受控的 assistant text、tool calls、tool results。
3. thinking blocks 和 system noise 不进入 advisor prompt。
4. 常见 key/token/password 文本脱敏。
5. advisor Anthropic-compatible endpoint 遇到临时 `429/5xx` 时重试一次。
6. gold tests 继续仅作为外部裁判，不泄漏给 executor。

SymPy smoke：

| Mode | Gold Tests | Time | Advisor Calls | Outcome |
|---|---:|---:|---:|---|
| Default official-like | 0/2 | 68.5s | 1 | 采集 124 个 stream events；漏掉 relational printer |
| Forced review，endpoint error | not scored | 57.2s | 2 | advisor HTTP 500 污染 |
| Forced review + retry | 0/2 | 84.9s | 2 | advisor 找到 relational 缺口，但 executor 未执行 |
| Forced review + mandatory correction | 0/2 | 40.2s | 1 | advisor 方差：错误批准不完整 patch |

结论：保留 stream-json 上下文采集和临时错误重试。`--force-pre-final-review` 继续作为实验开关，不默认启用。停止围绕单题堆 prompt；下一轮用多题、多 seed 小样本评估 resolved rate、调用率、token 和时延。

下一轮建议分开跑，避免混淆默认策略和实验增强：

```bash
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3 --repeats 2
python3 question/runner_cc_haha.py --mode injected --model glm --limit 3 --repeats 2 --force-pre-final-review
```

## 6.4 Terminal-Bench Mini

已新增：

```bash
python3 question/eval/terminal_bench_mini.py --limit 1 --model haiku --timeout 120
```

结果：

```text
question/eval/results/terminal_mini_20260531_023051.json
```

本轮 `0/1 passed`，原因是 GLM 额度窗口内 CLI 调用未完成并 timeout。该 harness 可在额度恢复后作为 Terminal-Bench-style smoke；它不是官方 Terminal-Bench 2.0 Docker harness。

## 7. 风险点

| 风险 | 缓解 |
|------|------|
| cc-haha CLI 启动慢 | 用 --bare 最小化；单题 timeout 设为 10min |
| cc-haha CLI 输出格式不稳定 | parse stdout 用多模式 fallback |
| transcript 太长塞不下下一轮 prompt | 保留最近 8K-9K chars + 当前 diff |
| DeepSeek/GLM Anthropic 端点 thinking mode | 如果启用了 thinking，输出中 content 可能为空 |
| GLM 模型映射变更 | 以 `/Users/jasonjcwu/.claude/settings.json` 为准；当前 haiku→Air，sonnet→Turbo，opus/advisor→5.1 |
| cc-haha CLI 子进程泄漏 | 每个 subprocess 加 timeout + 清理 |
