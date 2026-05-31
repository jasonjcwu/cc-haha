# 本地调试 & 跑单任务指南

## 环境设置

```bash
cd /root/cc-haha
```

两个模型对应两个环境脚本，跑之前必须 source 对应脚本：

```bash
# DeepSeek 辅助对照
source scripts/set-env-ds.sh
# → executor: --model haiku/sonnet → deepseek-v4-flash
# → advisor: deepseek-v4-pro

# GLM 主实验
source scripts/set-env-glm.sh
# → executor: --model haiku → glm-4.5-air
# → executor: --model sonnet → glm-5-turbo
# → advisor: glm-5.1
```

验证链路通不通：
```bash
source scripts/set-env-ds.sh
./bin/claude-haha --bare -p "say hello"
# 应该输出 Hello
```

---

## 快速原型：从 hard6 提一条题

```bash
INSTANCE=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(json.dumps(d[0]))  # 第 0 题: django__django-10914
")
echo $INSTANCE | head -c 200
```

---

## 方式一：跑 Solo 模式（最常用的调试路径）

一条命令跑完探索→实现→验证，cc-haha 自己搞定：

```bash
source scripts/set-env-ds.sh

INSTANCE=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(json.dumps(d[0]))
")

python3 question/eval/cc_haha_solo.py \
  --instance-json "$INSTANCE" \
  --executor-model haiku \
  --timeout 600
```

**输出**：JSON 到 stdout，包含 `has_patch`, `wall_seconds`, `patch`。

**换第几题**：`d[0]` → `d[1]` ~ `d[5]`

**换 GLM**：
```bash
source scripts/set-env-glm.sh
# 同样命令
```

---

## 方式二：跑 Injected 模式（official-like dynamic advisor）

```bash
source scripts/set-env-ds.sh

INSTANCE=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(json.dumps(d[0]))
")

python3 question/eval/cc_haha_injected.py \
  --instance-json "$INSTANCE" \
  --executor-model haiku \
  --advisor-model deepseek \
  --timeout 600
```

**关键区别**：
- `--executor-model haiku` → 用当前 provider 的弱档 executor（DS Flash 或 GLM Air）
- `--executor-model sonnet` → 用当前 provider 的中档 executor（GLM Turbo）
- `--advisor-model deepseek` → 用 DeepSeek v4 Pro 做 advisor
- `--advisor-model glm` → 用 GLM-5.1 做 advisor
- executor 如需指导会输出 `<advisor_request>...</advisor_request>`，runner 捕获后调用 advisor
- 执行过程中会打印: `Executor turn N`, `Advisor N`, 等进度
- 默认最多 4 个 executor turns、3 次 advisor calls
- 耗时约 Solo 的 1-4 倍，取决于 executor 是否调用 advisor

---

## 方式三：通过 runner 跑（自动按配置分组）

```bash
# 跑 DeepSeek v4 Flash Solo 1 题
source scripts/set-env-ds.sh
python3 question/runner_cc_haha.py --mode solo --model ds --limit 1

# 跑 DeepSeek v4 Flash + v4 Pro Injected 1 题
source scripts/set-env-ds.sh
python3 question/runner_cc_haha.py --mode injected --model ds --limit 1

# 跑 GLM 主实验 6 题（Air/Turbo × Solo/Injected，谨慎，耗时较长）
source scripts/set-env-glm.sh
python3 question/runner_cc_haha.py --mode all --model glm --limit 6
```

**参数说明：**
| 参数 | 值 | 含义 |
|------|-----|------|
| `--mode` | `solo` / `injected` / `all` | 跑哪种模式 |
| `--model` | `ds` / `glm` / `both` | 用哪个模型 |
| `--limit` | 1~6 | 跑前 N 题 |

---

## 方式四：直接调 cc-haha CLI（干跑，无后处理）

想看看 cc-haha 在 SWE-bench 上到底怎么反应的：

```bash
source scripts/set-env-ds.sh

INSTANCE=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(json.dumps(d[0]))
")

IID=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(d[0]['instance_id'])
")

REPO=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(d[0]['repo'])
")

COMMIT=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(d[0]['base_commit'])
")

# 准备 repo 目录
REPO_DIR="/tmp/cc-haha-swe/${IID//\//__}"
mkdir -p "$REPO_DIR"
git clone "https://github.com/$REPO.git" "$REPO_DIR" 2>/dev/null
cd "$REPO_DIR" && git checkout "$COMMIT" 2>/dev/null
cd /root/cc-haha

# 直接跑 cc-haha
QUESTION=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(d[0]['problem_statement'][:500])
")

./bin/claude-haha --bare -p "Fix this bug in $REPO

Issue:
$QUESTION

Explore the repo, find root cause, fix it, output patch between \`\`\`diff markers." | tail -100
```

---

## 查看结果

每次跑完，结果存在：

```bash
# 如果是 runner 跑的
ls -la question/eval/results/
# → A-DS-Solo_20260528_143022.jsonl
# → all_20260528_143022.json

# 如果是直接调 python 脚本跑的
# → stdout 上打印 JSON
```

---

## 常见调试问题

### 1. 环境变量不对

```bash
# 检查当前环境
echo $ANTHROPIC_BASE_URL
echo $ANTHROPIC_API_KEY | head -c 10
echo $ANTHROPIC_AUTH_TOKEN  # 这个应该为空

# 如果 ANTHROPIC_AUTH_TOKEN 有值，说明旧 proxy 配置没清掉
unset ANTHROPIC_AUTH_TOKEN
```

### 2. cc-haha 没找到

```bash
# 确保在项目根目录
cd /root/cc-haha
ls -la bin/claude-haha
```

### 3. 超时

- Solo 默认 timeout 600s（10 分钟）
- Injected 默认 timeout 600s（最多 4 个 executor turns；每个 turn 至少 240s）
- 复杂项目（sympy, sphinx）可能超时，调大 `--timeout 900`

### 4. 生成的 patch 不完整

检查 extract_patch 是否匹配到：
- cc-haha 输出中的 `\`\`\`diff` 代码块
- 或者纯 `diff --git` 起始的行
- 如果都没匹配 → `stdout_preview` 字段看最后 500 字符

---

## 最快调试路径

想验证模型+CLI 链路是否正常，最快路径：

```bash
# 1. 环境就绪
source scripts/set-env-ds.sh

# 2. 取第 0 题
INSTANCE=$(python3 -c "
import json
d = json.load(open('question/eval/benchmark/hard6.json'))
print(json.dumps(d[0]))
")

# 3. 跑 Solo（约 2-3 分钟）
python3 question/eval/cc_haha_solo.py --instance-json "$INSTANCE" --timeout 600 | python3 -c "
import sys, json
lines = [l for l in sys.stdin.read().strip().split(chr(10)) if l.strip().startswith('{')]
if lines:
    r = json.loads(lines[-1])
    print(f\"Patch: {'✅' if r.get('has_patch') else '❌'} | {r.get('wall_seconds', 0):.0f}s | {r.get('patch_len', 0)} chars\")
"
```

输出示例：
```
Patch: ✅ | 138s | 45 chars
```
