# Advisor Strategy 评测方案

> 基于 cc-haha CLI (`bin/claude-haha`) + DeepSeek/GLM Anthropic 兼容端点

## 终点

**产出有数据支撑的博客/技术报告**，核心问题：

1. Advisor 模式对国产弱模型有效吗？
2. Tool 模式 vs Injected 模式，哪种更好？
3. 用 cc-haha CLI 作为 runner 跑评测是否可行？

## Claude 官方 advisor 机制

**server-side tool**，executor 自己决定何时调用：

```json
{"type": "advisor_20260301", "name": "advisor", "model": "claude-opus-4-7"}
```

- 只支持 Claude 模型配对
- API server 端自动转发完整对话

## 两种 Advisor 模式（cc-haha CLI 下的实现）

### Tool 模式（executor 自主决定）

cc-haha CLI 原生支持 tool calling，但 DeepSeek/GLM Anthropic 端点**没有** `advisor_20260301`。
所以 Tool 模式 = **Solo 模式**（无 advisor）。

### Injected 模式（外部强制注入）— 核心差异化

三阶段多轮 cc-haha CLI 调用 + 外部 advisor API：

```
题目 → Phase 1: cc-haha CLI 探索代码
         → 外部 advisor API → 建议
      → Phase 2: cc-haha CLI 实现（带 advisor 建议）
         → 外部 advisor API → 建议
      → Phase 3: cc-haha CLI 验证（带 advisor 建议）
         → 提取最终 patch
```

关键：外部 advisor 直接调 OpenAI SDK（不走 cc-haha CLI），省启动开销。

## 测试集

hard6（6 题，快速验证集）：

| 题号 | Instance | 仓库 | 难度 |
|------|----------|------|------|
| 1 | psf__requests-2931 | requests | MED |
| 2 | sympy__sympy-11618 | sympy | MED |
| 3 | pydata__xarray-2905 | xarray | MED |
| 4 | scikit-learn__scikit-learn-25102 | sklearn | HARD |
| 5 | django__django-10554 | django | HARD |
| 6 | sphinx-doc__sphinx-11510 | sphinx | HARD |

## 6 组配置

| 组 | Executor | 模式 | Advisor | ~调用次数 |
|---|---|---|---|---|
| A | DS Flash | Solo | — | 6 |
| B | DS Flash | Tool | DS Chat | 6（=Solo） |
| C | DS Flash | Injected | DS Chat | 18（3轮×6） |
| D | GLM Air | Solo | — | 6 |
| E | GLM Air | Tool | GLM-5.1 | 6（=Solo） |
| F | GLM Air | Injected | GLM-5.1 | 18（3轮×6） |

变量控制：thinking 关、温度=0、1次运行、同厂配对。

## 评测指标

- **Patch Rate**：生成 patch 的比例（中间指标）
- **Advisor Call Rate**：Injected 模式 core 指标
- **Delta**：Solo vs Injected 的变化
- **Token / Cost**：经济性

## 实施规划

详见 `question/eval/PLAN.md`

## 最终产出

给 cc-haha 提 PR（advisor 功能）+ 博客文章（中英双语）→ obsidian → jiachen.lol
