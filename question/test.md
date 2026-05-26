
 

  ┌─────────────────────┬───────────┬────────────┬────────────┬────────────────┐
  │        方法         │   成本    │    速度    │  信号质量  │    适合场景    │
  ├─────────────────────┼───────────┼────────────┼────────────┼────────────────┤
  │ Patch Similarity    │ ~$0.35/题 │ 30s/题     │ 中（近似） │ 快速迭代，调参 │
  ├─────────────────────┼───────────┼────────────┼────────────┼────────────────┤
  │ LLM-as-Judge        │ ~$0.10/题 │ 5s/题      │ 中（主观） │ 大量题目的筛选 │
  ├─────────────────────┼───────────┼────────────┼────────────┼────────────────┤
  │ 自建 Bug 注入       │ ~$0.35/题 │ 30s/题     │ 高（精确） │ 验证特定能力   │
  ├─────────────────────┼───────────┼────────────┼────────────┼────────────────┤
  │ 真实 SWE-bench      │ ~$3-10/题 │ 5-15min/题 │ 最高       │ 最终验证       │
  │ Docker              │           │            │            │                │
  └─────────────────────┴───────────┴────────────┴────────────┴────────────────┘

Phase 2：正式评测（5-7 天）
2.1 评测规模
级别	题目数	单配置成本（估）	总配置数	总成本（估）
快速验证	6 (hard6)	~$0.5	11	~$6
标准	30-50	~$5	11	~$55
完整	300 (Lite)	~$30	11	~$330
建议从 hard6 验证 → 30 题标准 → 视结果决定是否跑完整。

2.2 评测指标
每个配置跑完后记录：

解决率 (% Resolved) — SWE-bench 标准
Advisor 调用次数 — 平均每题调几次
总 token 消耗 — executor tokens + advisor tokens
单题成本 — $/task
耗时 — wall-clock time per task
2.3 关键实验设计
实验 1：复现 Anthropic 结果（Baseline）

Claude Haiku solo vs Haiku + Opus advisor
Claude Sonnet solo vs Sonnet + Opus advisor
预期：advisor 加分 2-5%（复现 Anthropic 的 2.7pp 提升）

实验 2：跨模型 Advisor（创新点 ⭐）
DeepSeek-Flash + Claude-Opus advisor（便宜 executor + 强 advisor）
DeepSeek-Flash + DeepSeek-Chat advisor（全 DeepSeek 栈）
GLM-5.1 + Claude-Opus advisor（国产 executor + 海外 advisor）
GLM-5.1 + GLM-5.1 advisor（自配合，参照组）
Claude-Haiku + DeepSeek-Chat advisor（Claude executor + 国产 advisor）

实验 3：Advisor 强度 vs Executor 强度的交互效应
弱 executor (Haiku/Flash) + 强 advisor (Opus/DS-Chat) 的提升幅度
vs 强 executor (Sonnet/DS-Chat) + 强 advisor 的提升幅度
假设：弱 executor 提升更大（因为更多决策点需要 advisor）

实验 4：Advisor 调用频率与质量分析
统计每题 advisor 被调几次
分析 advisor 建议被采纳后的成功率
区分"advisor 没被调" vs "advisor 被调了但建议没用"

2.4 输出数据格式
json
{
  "config_id": "ds-flash_opus-advisor",
  "executor": "deepseek-v4-flash",
  "advisor": "claude-opus-4-7",
  "eval_set": "swe-hard6",
  "results": [
    {
      "instance_id": "django__django-12345",
      "resolved": true,
      "advisor_calls": 3,
      "executor_tokens": 15000,
      "advisor_tokens": 2000,
      "cost_usd": 0.03,
      "wall_time_s": 120
    }
  ],
  "summary": {
    "resolve_rate": 0.5,
    "avg_advisor_calls": 2.8,
    "avg_cost_usd": 0.025,
    "total_cost_usd": 0.15
  }
}
Phase 3：分析与输出（3-5 天）
3.1 数据分析
生成对比表格和图表：

热力图：Executor × Advisor 矩阵，颜色 = 解决率
性价比图：X=成本，Y=解决率，每个配置一个点
提升幅度图：Solo 基线 vs + Advisor 的 delta
Advisor 调用分析：频率分布、成功关联
3.2 可能的输出形态
最小可行输出：GitHub repo + README 表格 + 一条推文

完整输出（如果有意思的发现）：

博客文章（中英双语）→ obsidian → jiachen.lol
包含数据对比图、发现、结论
可能的话题：
"跨模型 Advisor：DeepSeek executor + Claude advisor 比 Sonnet solo 更好更便宜？"
"Advisor Strategy 不只是 Claude 的专利——通用 pattern 的实验验证"
"当国产模型做 executor，Claude 做 advisor：成本效率的帕累托前沿"

3.3 发表判断标准
数据值得发表的条件（至少满足一个）：

跨模型 advisor 显著优于同栈 advisor（发现新的 cost-performance Pareto 前沿）
弱 executor + 强 advisor 接近或超过强 executor solo（验证 Anthropic 的声称在跨模型场景也成立）
发现某个模型做 advisor 特别好（或特别差），且原因可分析
Advisor 调用模式有非直觉发现

如果以上都不满足——数据仍然有价值，写成技术报告即可，不必硬凑文章。

给 cc HAHA 提 pr advisor 功能