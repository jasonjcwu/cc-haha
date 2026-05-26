# Advisor 实现计划

## 对 ADVISOR_IMPL.md 的审查结论

**方案 B（API 代理）推荐是错的。** 三个核心问题：

1. **SSE 流拦截过于复杂**。代理需要实时解析 `content_block_start`/`content_block_delta` 事件、检测 `server_tool_use`、阻塞流调 advisor API（可能数秒）、再注入 `advisor_tool_result`。远超 200-300 行的估计。

2. **Beta header 矛盾**。`advisor_20260301` 要求 `advisor-tool-2026-03-01` beta header。代理发这个 header → API 自己处理 server tool 跟代理冲突；不发 → API 不认识 tool type 直接报错。

3. **方案 A 更简单且直接**。不需要碰流式协议，只需要注册一个 client tool，在 `call()` 里调 API。跟 WebSearchTool 的模式完全一样。

**选择方案 A+（模块化源码扩展）**：新增文件而非大量修改已有文件，降低维护负担。

## 已实现

### 新增文件
1. **`src/services/advisorProvider.ts`** — 多 provider 抽象
   - `AnthropicAdvisorProvider`: 调 Claude 模型
   - `OpenAICompatAdvisorProvider`: 调 DeepSeek / GLM / 任何 OpenAI 兼容 API
   - `getAdvisorProviderConfig()`: 根据模型名自动选择 provider
   - 支持 `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GLM_API_KEY` 等

2. **`src/tools/AdvisorClientTool/AdvisorClientTool.ts`** — client tool 实现
   - `buildTool()` 注册，遵循项目统一 tool 模式
   - 从 `context.messages` 提取最近 20 条对话
   - 调 advisor model API 返回建议
   - 自动处理 provider 选择和错误

3. **`src/utils/advisorClient.ts`** — 客户端 advisor 配置
   - 放宽 `isValidAdvisorModel()` 和 `modelSupportsAdvisor()`，允许任何模型
   - 通过 `CLAUDE_CODE_ADVISOR_ENABLED` / `CLAUDE_CODE_ADVISOR_MODEL` 环境变量控制
   - 或通过 settings 的 `advisorModel` 字段控制

4. **`question/bench/`** — 评测框架
   - `tasks.ts`: 8 个 benchmark 任务（code-gen / bug-fix / refactor / analysis）
   - `runner.ts`: 自动跑 worker × advisor 矩阵，用 Haiku 做 judge 打分
   - `test-smoke.ts`: 离线验证测试

### 修改文件
5. **`src/tools.ts`** — 注册 `AdvisorClientTool`（条件性加载）
6. **`src/services/api/claude.ts`** — client advisor 启用时注入 `ADVISOR_TOOL_INSTRUCTIONS` 到 system prompt
7. **`src/commands/advisor.ts`** — `/advisor` 命令兼容客户端 advisor

## 如何使用

```bash
# 启用 client advisor（用 Opus 做 advisor）
export CLAUDE_CODE_ADVISOR_ENABLED=true
export CLAUDE_CODE_ADVISOR_MODEL=claude-opus-4-7
bun run ./bin/claude-haha

# 或者用 DeepSeek
export CLAUDE_CODE_ADVISOR_MODEL=deepseek-chat
export DEEPSEEK_API_KEY=xxx

# 或者在 REPL 里用 /advisor 命令
/advisor opus
/advisor deepseek-chat
```

## 跑评测

```bash
# 需要至少 ANTHROPIC_API_KEY
ANTHROPIC_API_KEY=xxx bun run question/bench/runner.ts

# 可选：加更多 provider key
DEEPSEEK_API_KEY=xxx GLM_API_KEY=xxx bun run question/bench/runner.ts
```

## 模型组合矩阵

| Worker (干活) | Advisor (审核) | 场景 |
|---|---|---|
| haiku-4.5 | (none) | 对照组：无 advisor |
| haiku-4.5 | opus-4.7 | 经典 advisor 组合 |
| haiku-4.5 | deepseek-v3 | 低成本组合 |
| haiku-4.5 | glm-4 | 国产模型测试 |
| sonnet-4.6 | (none) | 中端对照组 |
| sonnet-4.6 | opus-4.7 | 高质量组合 |

## Smoke Test 结果

```
✓ Tasks validated (8 tasks, 4 categories, 3 difficulty levels)
✓ Provider configs validated (Claude / DeepSeek / GLM / GPT)
✓ Advisor client config validated (any model accepted)
✓ Message extraction validated
```
