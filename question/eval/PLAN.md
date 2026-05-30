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

模型映射（需实测确认）：
| claude-haiku → glm-4.5-air |
| claude-sonnet → glm-5.1 |
| claude-opus → glm-5.1 |

## 2. 评测架构

### 2.1 6 组 × hard6 题

| 组 | Executor | 模式 | Advisor | Runner | 调用次数 |
|---|---|---|---|---|---|
| A | DS Flash | Solo | — | cc-haha CLI | 6 |
| B | DS Flash | Tool | DS Chat | cc-haha CLI（=Solo） | 6 |
| C | DS Flash | Injected | DS Chat | cc-haha CLI 多轮 + 外部 advisor | 6 × 3轮 = 18 |
| D | GLM Air | Solo | — | cc-haha CLI | 6 |
| E | GLM Air | Tool | GLM-5.1 | cc-haha CLI（=Solo） | 6 |
| F | GLM Air | Injected | GLM-5.1 | cc-haha CLI 多轮 + 外部 advisor | 6 × 3轮 = 18 |
| **总计** | | | | | **60 次 CLI 调用** |

### 2.2 Solo 模式（组 A、D）

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

### 2.3 Tool 模式（组 B、E）

= Solo。DeepSeek/GLM Anthropic 端点都不支持 `advisor_20260301`。
但可以在 prompt 末尾加 "Before writing code, think step by step" 作为思考代偿。

### 2.4 Injected 模式（组 C、F）— 核心差异化

三阶段多轮 cc-haha CLI 调用 + 外部 advisor。

```
题目 → [Phase 1: 探索]
            ↓
         cc-haha CLI 探索代码
            ↓
         提取探索结果（stdout + 文件修改）
            ↓
         → 外部 advisor API（OpenAI 格式，直接调）→ 建议1
            ↓
 [Phase 2: 实现] → 把问题 + 探索结果 + advisor建议1 打包成 prompt
            ↓
         cc-haha CLI 实现修复
            ↓
         提取中间结果
            ↓
         → 外部 advisor API → 建议2
            ↓
 [Phase 3: 验证] → 问题 + 实现 + advisor建议2
            ↓
         cc-haha CLI 验证/完善
            ↓
         提取最终 patch
```

**关键设计点**：

a) **每次调 cc-haha CLI 要传上下文**：前一轮的探索结果、advisor 建议都拼进下一轮的 user prompt。

b) **外部 advisor API 直接调 OpenAI SDK**（不走 cc-haha：
   - 用 DeepSeek Chat (deepseek-chat) 作为 DS 组的 advisor
   - 用 GLM-5.1 (通过 OpenAI 格式 API) 作为 GLM 组的 advisor

c) **Phase 1 的 prompt 设计**：只探索不改代码。
   ```
   "Read the repository and understand the issue.
    DO NOT write any code. Just explore and report what you find.
    Issue: {problem_statement}
    Focus on: root cause, relevant files, test locations."
   ```

d) **Phase 2 的 prompt 设计**：带 advisor 建议。
   ```
   "Your previous exploration found: {exploration_summary}
    Your advisor suggests: {advisor_feedback_1}
    Now implement the fix. Make minimal changes."
   ```

e) **Phase 3 的 prompt 设计**：检查和完善。
   ```
   "Review and verify your implementation.
    Your advisor has reviewed your changes: {advisor_feedback_2}
    Run tests and ensure everything works."
   ```

### 2.5 cc-haha CLI 启动开销

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
| `question/eval/runner_cc_haha.py` | 评测入口（Python，管理所有 6 组） |
| `question/eval/cc_haha_solo.py` | Solo 模式：调 cc-haha CLI |
| `question/eval/cc_haha_injected.py` | Injected 模式：多轮 + advisor |
| `question/eval/prompt_templates.py` | 各阶段的 prompt 模板 |

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
- `build_exploration_prompt(instance)` — Phase 1 只探索
- `build_implementation_prompt(instance, exploration, advisor_feedback)` — Phase 2
- `build_verification_prompt(instance, implementation, advisor_feedback)` — Phase 3
- `build_advisor_prompt(phase, context)` — 调外部 advisor 的 prompt

### Step 3: cc_haha_solo.py
- 调 cc-haha CLI subprocess
- 从 stdout 提取 patch（```diff 块）
- 计时、计费（从 CLI 输出估算）

### Step 4: cc_haha_injected.py
- Phase 1: 调 cc-haha CLI → 提取输出
- Advisor: 调外部 API（openai SDK）
- Phase 2: 拼 prompt → 调 cc-haha CLI → 提取
- Advisor 2: 再次调外部 API
- Phase 3: 拼 prompt → 调 cc-haha CLI → 提取 patch

### Step 5: runner_cc_haha.py
- 加载 hard6.json
- 遍历 6 组配置
- 对每组调 solo/injected
- 输出结果 JSONL + 汇总

## 5. 预估成本

| 模型 | 单价 | 预估用量 | 成本 |
|------|------|---------|------|
| DS Flash (executor) | $0.15/M in, $0.60/M out | ~3K in, ~8K out × 42 runs | ~$0.23 |
| DS Chat (advisor) | $0.27/M in, $1.10/M out | ~5K in, ~1K out × 12 runs | ~$0.03 |
| GLM Air (executor) | 免费额度 | ~3K in, ~8K out × 24 runs | ~$0 |
| GLM-5.1 (advisor) | 编码套餐 | ~5K in, ~1K out × 12 runs | ~$0 |
| **总计** | | | **~$0.26** |

## 6. 验证方法

每题生成 patch 后：
1. 存为 `predictions/{group}/{instance_id}.diff`
2. 用 AI judge（DS Flash 免费）打分：正确性 + 最小性
3. 对比 solo vs injected 的 patch 率和分数
4. 如需精确评测 → SWE-bench Docker 环境

## 7. 风险点

| 风险 | 缓解 |
|------|------|
| cc-haha CLI 启动慢 | 用 --bare 最小化；单题 timeout 设为 10min |
| cc-haha CLI 输出格式不稳定 | parse stdout 用多模式 fallback |
| Phase 1 输出太长塞不下下一轮 prompt | 截断到 4000 chars |
| DeepSeek/GLM Anthropic 端点 thinking mode | 如果启用了 thinking，输出中 content 可能为空 |
| GLM 模型映射不明确 | 先在 1 题上实测 claude-sonnet→? |
| cc-haha CLI 子进程泄漏 | 每个 subprocess 加 timeout + 清理 |
