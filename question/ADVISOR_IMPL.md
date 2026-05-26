# Claude Code — 本地 Advisor 实现

## 背景

Claude Code 的 advisor 是**服务端工具**：

```
客户端发送 tool schema: { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-7' }
       ↓
Anthropic API 在服务端自动调用 advisor model
       ↓
返回 server_tool_use + advisor_tool_result blocks（在同一个 stream 里）
```

我们无法使用原生 advisor（需要 first-party API + beta header），但可以**在客户端模拟**。

## 原生流程（3 个关键文件）

### 1. 注册 advisor tool — `src/services/api/claude.ts:1386-1393`

```typescript
if (advisorModel) {
  extraToolSchemas.push({
    type: 'advisor_20260301',
    name: 'advisor',
    model: advisorModel,  // e.g. 'claude-opus-4-7'
  })
}
```

### 2. 处理流式响应 — `src/services/api/claude.ts:2003-2050`

当 API stream 里出现 `server_tool_use` block 且 `name === 'advisor'` 时：
- 设 `isAdvisorInProgress = true`
- 等 `advisor_tool_result` block 回来
- 设 `isAdvisorInProgress = false`

### 3. 注入 advisor 指令 — `src/utils/advisor.ts:130-145`

```typescript
export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool
You have access to an advisor tool backed by a stronger reviewer model...
Call advisor BEFORE substantive work...
`
```

这段文字被加到 system prompt 里。

## 本地实现方案

### 方案 A：修改 Claude Code 源码（TypeScript patch）

**思路**：把 `advisor_20260301` 替换成普通的 `tool_use`，拦截到 tool call 后客户端自己调 API。

**改动点**：

1. **`src/services/api/claude.ts`** — 把 server tool 改成普通 tool
2. **`src/utils/advisor.ts`** — 去掉 first-party 检查，允许任意 provider
3. **新增 `src/tools/AdvisorTool.ts`** — 客户端 advisor tool 实现

### 方案 B：API 代理层（不改源码）

**思路**：在 Claude Code 和 API 之间加一个代理，拦截 `advisor_20260301` tool schema，收到 stream 里的 `server_tool_use` 后，代理自己调 advisor model 并注入 `advisor_tool_result`。

**优点**：不改 Claude Code 源码，兼容原生 CLI
**缺点**：需要写代理服务

### 方案 C：改编译后的 JS（最快）

**思路**：直接 patch dist/ 里编译好的 JS，把 advisor 从 server tool 改成 client tool。

## 推荐路径

**方案 B（API 代理）** 最干净：
- Claude Code 原封不动
- 代理是一个 Python/Node 服务
- 支持 Claude/GPT/DeepSeek/GLM 作为 advisor model
- 可以加 caching、rate limiting、logging

实现工作量约 200-300 行代码。

## 文件索引

| 文件 | 作用 | 改动 |
|------|------|------|
| `src/utils/advisor.ts` | 类型定义 + 启用检查 + 指令 | 放宽 first-party 限制 |
| `src/commands/advisor.ts` | `/advisor` slash 命令 | 保持不变 |
| `src/services/api/claude.ts` | 发送 tool schema + 处理 stream | 拦截 server_tool_use |
| `src/components/messages/AdvisorMessage.tsx` | UI 渲染 | 保持不变 |
| `src/constants/betas.ts` | `ADVISOR_BETA_HEADER` | 方案 B 不需要改 |

## 下一步

1. 选方案（A/B/C）
2. 实现
3. 用 hard6 数据集跑 benchmark 对比
