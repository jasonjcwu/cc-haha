# Advisor 评测可视化 + 题库 Dashboard

> 基于 FastAPI + 纯 HTML/JS + SQLite，零构建步骤

## 终点

一个 **自带动态结果查看 + 题库管理 + 随机抽题** 的 Web 页面，跑完评测立即可视化分析。

**操作流：**

```
题库 → 抽题 → 选配置 → 跑评测 → 自动展示结果
                                ├─ 热力表 ✓/✗ + 耗时
                                ├─ 调用链路图 + 费用明细
                                └─ 历史平均（跨 run 聚合）
```

---

## 架构

```
FastAPI  ←  python -m uvicorn server:app --port 8888
  │
  ├─ GET    /api/instances          ← hard6 / 题库抽题结果
  ├─ GET    /api/configs             ← 6组配置（A~F）
  ├─ GET    /api/results?instances=..&configs=..  ← 选中结果
  ├─ GET    /api/history?model=ds&instance=..     ← 跨 run 聚合
  ├─ POST   /api/run                 ← 触发评测
  │
  ├─ GET    /api/question-bank/stats    ← 题库统计
  ├─ GET    /api/question-bank/browse   ← 题库浏览/筛选
  ├─ POST   /api/question-bank/import   ← 导入题库（JSONL/JSON）
  ├─ POST   /api/question-bank/draw     ← 随机抽题
  │
  └─ Serve /static/index.html        ← 单页前端
```

**数据存储：**

| 存储 | 用途 | 位置 |
|------|------|------|
| `question/eval/results/*.jsonl` | 每 run 原始结果 | JSONL 文件（后向兼容） |
| `question/eval/results/aggregator.db` | 聚合统计 + 题库 | SQLite |

---

## 页面布局

```
┌──────────────────────────────────────────────────────────────┐
│  [Advisor Eval Dashboard]                                    │
├─────────────┬────────────────────────────────────────────────┤
│  题库 / 选题  │  选组合                                       │
│              │                                               │
│  ┌────────┐  │  [A] DS-Solo  [B] DS-Tool  [C] DS-Injected   │
│  │ 题库标签页 │  [D] GLM-Solo [E] GLM-Tool [F] GLM-Injected  │
│  │          │  ┌───────────────────────────────────────────┐ │
│  │ 题型筛选: │  │  结果热力表                               │ │
│  │ ■ SWE    │  │          A       B       C       D  ...  │ │
│  │ □ BC     │  │  django  ✓138s  ✓140s  ✓95s    ✗       │ │
│  │ □ TB2    │  │  requests ✗      ✗      ✓120s   ✗       │ │
│  │          │  │  xarray   ✓200s  ...     ✗      ✓...    │ │
│  │ 抽题:    │  └───────────────────────────────────────────┘ │
│  │ 抽 [6] 题│                                               │
│  │ [随机抽取]│  ┌───────────────────────────────────────────┐ │
│  │          │  │  选中 django × DS-Injected 的详情         │ │
│  │ 题库统计: │  │                                           │ │
│  │ 总: 300  │  │  调用链：                                  │ │
│  │ 已跑: 6  │  │   🟢 Expl. ─→ 🟡 Adv1 ─→ 🟢 Impl.       │ │
│  │          │  │   ─→ 🟡 Adv2 ─→ 🟢 Verif.                │ │
│  │ [刷新]   │  │   时间: 25s → 3s → 42s → 2s → 23s = 95s │ │
│  │ [运行选中]│  │   花费: ¥0.027 (exec) + ¥0.003 (adv)     │ │
│  │          │  └───────────────────────────────────────────┘ │
│  └────────┘                                                 │
│              ┌───────────────────────────────────────────┐  │
│  历史平均     │  DS-Solo 历史平均（2 runs）               │  │
│  DS-Solo:    │  ▓▓▓▓▓▓▓░░  solve: 67% (4/6→6/9)        │  │
│   4/6 67%    │  ▓▓▓▓▓▓░   time: 162s → 155s ↓          │  │
│   162s avg   └───────────────────────────────────────────┘  │
└─────────────┴───────────────────────────────────────────────┘
```

---

## 核心视图

### 1. 结果热力表

| 题 \ 组合 | A DS-Solo | B DS-Tool | C DS-Injected | D GLM-Solo | ... |
|---|---|---|---|---|---|
| django-10914 | ✅ 138s | ✅ 140s | ✅ 95s | ❌ | ... |
| requests-3362 | ❌ | ❌ | ✅ 120s | ❌ | ... |
| xarray-3364 | ✅ 200s | ... | ... | ... | ... |

- 每个单元格: ✓/✗ + 耗时
- 颜色: 绿色(有patch) / 红色(无patch) 梯度
- 点击单元格 → 展开详情面板

### 2. 调用链路图

```
Solo（单次 cc-haha CLI 调用）:
  ┌─────────────────────────────────┐
  │  cc-haha --bare -p 完整prompt   │
  │  └─ tool call 1: 读文件         │
  │  └─ tool call 2: grep 搜索      │
  │  └─ tool call 3: 编辑代码       │
  │  总耗时: 138s  花费: ¥0.03     │
  └─────────────────────────────────┘

Injected（3+2 次调用）:
  ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ Phase 1  │──→│ Advisor  │──→│ Phase 2  │
  │ 探索      │   │ ⚡审查     │   │ 实现      │
  │ 25s ¥0.01│   │ 3s ¥0.00 │   │ 42s ¥0.02│
  └──────────┘   └──────────┘   └────┬─────┘
                                     │
  ┌──────────┐   ┌──────────┐        │
  │ Phase 3  │←──│ Advisor  │←───────┘
  │ 验证      │   │ ⚡审查     │
  │ 23s ¥0.01│   │ 2s ¥0.00 │
  └──────────┘   └──────────┘

  总计: 95s  |  Exec: ¥0.04  |  Advisor: ¥0.003  |  合计: ¥0.043
```

### 3. 历史平均面板

跨多个 run 的聚合统计:

```
DS-Solo (3 runs, 18 instances):
  Solve Rate: ████████░░ 78% (14/18)
  Avg Time:  ██████░░░░ 155s
  Avg Cost:  ¥0.032/题

DS-Injected (2 runs, 12 instances):
  Solve Rate: ██████░░░░ 67% (8/12)
  Avg Time:  █████████░ 210s
  Avg Cost:  ¥0.061/题 (+advisor ¥0.008)
```

---

## 通用题库设计

### 核心思路

`benchmark_type` 作为第一分类键 + JSON `metadata` 兜住格式差异。

**支持三种 benchmark：**

| 类型 | 描述 | 评估方式 | 数量级 |
|------|------|---------|--------|
| SWE-bench | 代码仓库 bug fix | 生成 patch | 300+ |
| BrowseComp | 浏览器检索难题 | 返回正确答案 | ~100 |
| Terminal-Bench 2.0 | 终端环境任务 | Docker 内验证 | ~90 |

### 通用 Schema

```sql
CREATE TABLE question_bank (
    id              TEXT PRIMARY KEY,   -- "swe__django-10914" | "bc__q42" | "tb2__dna-assembly"
    benchmark_type  TEXT NOT NULL,      -- "swe-bench" | "browse-comp" | "terminal-bench-2.0"
    
    title           TEXT,               -- 短标题
    description     TEXT,               -- 完整问题描述
    source          TEXT,               -- "hard6" | "swe-bench-lite" | "openai/simple-evals" | ...
    difficulty      TEXT DEFAULT 'medium',  -- "easy" | "medium" | "hard"
    
    gold_answer     TEXT,               -- SWE gold patch / BC 答案 / TB2 oracle
    evaluation_hint TEXT,               -- 自动验证方法
    
    run_count       INTEGER DEFAULT 0,  -- 已评测次数
    last_result     TEXT,               -- "pass" | "fail" | null
    avg_time        REAL DEFAULT 0.0,
    
    metadata        TEXT,               -- JSON: benchmark 类型特定数据
    tags            TEXT,               -- JSON: 标签数组
    
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);
```

### benchmark 类型 metadata 示例

**SWE-bench：**
```json
{
  "repo": "django/django",
  "base_commit": "e7fd69d051eaa67cb17f172a39b57253e9cb831a",
  "test_patch": "diff --git a/tests/...",
  "version": "3.0",
  "FAIL_TO_PASS": ["test_override_file_upload_permissions"],
  "PASS_TO_PASS": ["test_allowed_database_queries"]
}
```

**BrowseComp：**
```json
{
  "expected_answer": "2015-04-18",
  "reference_urls": ["https://..."],
  "answer_type": "date",
  "needs_browsing": true
}
```

**Terminal-Bench 2.0：**
```json
{
  "docker_image": "ubuntu:22.04",
  "setup_script": "apt-get install ...",
  "verification_script": "python3 /app/verify.py",
  "timeout_seconds": 600,
  "oracle_command": "python3 /app/solve.py"
}
```

### 题库 → Runner 分发

```
题库（SQLite）
  │
  ├─ type="swe-bench"    → cc_haha_solo.py / cc_haha_injected.py (clone repo + cc-haha CLI)
  ├─ type="browse-comp"  → bc_runner.py (cc-haha + browser tool)
  └─ type="terminal-bench-2.0" → tb2_runner.py (cc-haha + Docker)
```

### 题库 UI 交互

```
┌───────────────────────────────┐
│  题库 Dashboard                │
│                                │
│  全部(300) │ SWE(250) │ BC(30) │ TB2(20) │
│                                │
│  筛选: [repo ▼] [difficulty ▼] │
│  [☑ 只显示未跑过的]            │
│                                │
│  ┌─────────────────────────┐  │
│  │  抽题                    │ │
│  │  数量: [6]  类型: [全部 ▼]│ │
│  │  [随机抽取]              │ │
│  └─────────────────────────┘  │
│                                │
│  题库统计:                     │
│  已跑: 6/300  通过率: 50%     │
│                                │
│  最近导入:                     │
│  • hard6.json → 6 题 (swe)   │
└───────────────────────────────┘
```

---

## API 端点清单

```python
# — 评测相关 —
GET  /api/instances                        # hard6 / 当前选中题目
GET  /api/configs                          # A~F 6组配置
GET  /api/results?instances=x,y&configs=A,C  # 查询结果
GET  /api/history?model=ds&instance=x      # 跨 run 聚合
POST /api/run  body: {instances, configs}  # 触发评测

# — 题库管理 —
GET  /api/question-bank/stats              # 题库统计
GET  /api/question-bank/browse?type=..&page=..&per_page=..   # 浏览
POST /api/question-bank/import             # 从 JSONL/JSON 导入
POST /api/question-bank/draw body: {count, types, unrun_only}  # 随机抽题
```

---

## 实现步骤

```
Step 0: 题库接入（~2h）
  feat 0.1: SQLite question_bank 建表 + 导入 hard6.json
  feat 0.2: 下载/导入脚本（SWE-bench lite, BrowseComp, TB2）
  feat 0.3: API: /stats, /browse, /import, /draw
  feat 0.4: 前端: 题库面板 + 抽题交互 + 类型筛选

Step 1: SQLite schema + 结果导入（~30min）
  feat 1.1: aggregator 建表（run_id, group, instance_id, has_patch, ...）
  feat 1.2: 扫描 results/*.jsonl → 自动导入
  feat 1.3: 去重处理（同 run_id 不重复导入）

Step 2: FastAPI server（~1h）
  feat 2.1: 端点: /instances, /configs, /results, /history
  feat 2.2: 端点: /run（触发封装好的 runner）
  feat 2.3: 静态文件 serve（/static/index.html）

Step 3: 前端 HTML/JS（~1.5h）
  feat 3.1: 左右分栏布局（CSS Grid）
  feat 3.2: InstanceSelector + ConfigSelector 复选框
  feat 3.3: 结果热力表（动态获取数据）
  feat 3.4: 刷新/运行按钮 + 状态指示

Step 4: 调用链路可视化（~1h）
  feat 4.1: CSS/SVG 流程图
  feat 4.2: Solo 模式链路
  feat 4.3: Injected 模式 3+2 链路

Step 5: 历史平均聚合（~30min）
  feat 5.1: SQL query 跨 run 聚合
  feat 5.2: 前端平均数据展示

Step 6: "运行选中"触发评测（~30min）
  feat 6.1: POST /run → subprocess runner
  feat 6.2: 前端轮询进度

Step 7: 费用估算（~15min）
  feat 7.1: token 估算逻辑（按时间/按配置单价）
  feat 7.2: 前端费用展示

Step 8: 完善 + 文档（~15min）
  feat 8.1: 启动脚本
  feat 8.2: 更新 test.md / PLAN.md

总计: ~7h
```

---

## 启动方式

```bash
cd /root/cc-haha/question/eval
pip install fastapi uvicorn   # 首次
python -m uvicorn server:app --port 8888
# → http://localhost:8888
```

---

## 关键设计原则

1. **零构建** — 纯 HTML + Vanilla JS，不依赖 npm/webpack
2. **后向兼容** — `results/*.jsonl` 格式不改，`db.py` 定期扫描导入
3. **题库与评测分离** — 题库管"有哪些题"，评测管"跑这些题"
4. **extend by type** — benchmark_type 是路由和 runner 的第一键值
5. **历史积累** — 每次跑完结果自动进入聚合，越跑统计越稳
