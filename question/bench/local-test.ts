#!/usr/bin/env bun
/**
 * Advisor 本地评测 — 一键跑通 + 可视化报告
 *
 * 用法:
 *   export ANTHROPIC_API_KEY=sk-xxx
 *   bun run question/bench/local-test.ts
 *
 * 可选:
 *   DEEPSEEK_API_KEY=xxx    — 启用 DeepSeek advisor 测试
 *   GLM_API_KEY=xxx         — 启用 GLM advisor 测试
 *   BENCH_TASKS=3           — 只跑前 N 个任务 (默认全部 5 个)
 *   BENCH_WORKER=haiku      — 指定 worker (haiku | sonnet)
 */

import Anthropic from '@anthropic-ai/sdk'

// ── Pricing ($/1M tokens) ────────────────────────────────────────────

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00 },
  'claude-sonnet-4-6-20250514': { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':            { input: 15.00, output: 75.00 },
  'deepseek-chat':              { input: 0.27,  output: 1.10 },
  'glm-4':                      { input: 0.10,  output: 0.10 },
}

function getModelPrice(model: string) {
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.includes(key) || key.includes(model)) return price
  }
  return { input: 1.00, output: 5.00 } // fallback
}

// ── Tasks ────────────────────────────────────────────────────────────

interface Task {
  id: string
  prompt: string
  type: string
  accept: (output: string) => { resolved: boolean; reason: string }
}

const TASKS: Task[] = [
  {
    id: 'fix-palindrome',
    type: 'bug-fix',
    prompt: `Fix the bug in this function. It should return all unique palindromic substrings including single characters, but it misses single chars and the loop bound is wrong:

\`\`\`typescript
function palindromes(s: string): string[] {
  const result: string[] = []
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 2; j <= s.length; j++) {
      const sub = s.slice(i, j)
      if (sub === sub.split("").reverse().join("")) {
        result.push(sub)
      }
    }
  }
  return [...new Set(result)]
}
\`\`\`

Return ONLY the corrected function.`,
    accept(output) {
      const hasSingleChar = output.includes('j = i + 1') || output.includes('j = i+1') || output.includes('j=i+1')
      const hasStart = output.includes('j = i') || output.includes('j=i')
      const resolved = hasStart && (hasSingleChar || output.includes('j <= s.length') || output.includes('j<=s.length'))
      return { resolved, reason: resolved ? 'Loop bound fixed' : 'Loop bound not fixed or single chars still missing' }
    },
  },
  {
    id: 'fix-race-condition',
    type: 'bug-fix',
    prompt: `Fix the race condition in this async function. Sometimes it processes the same item twice because Set operations are not atomic with async:

\`\`\`typescript
async function processQueue(items: string[]) {
  const seen = new Set<string>()
  const results = await Promise.all(
    items.map(async (item) => {
      if (seen.has(item)) return null
      seen.add(item)
      return await processItem(item)
    })
  )
  return results.filter(Boolean)
}
\`\`\`

Return ONLY the corrected function.`,
    accept(output) {
      const usesSequential = output.includes('for await') || output.includes('for (const') || output.includes('for (let') || output.includes('.reduce') || output.includes('reduce(')
      const noPromiseAll = !output.includes('Promise.all') || output.includes('for')
      const resolved = usesSequential && noPromiseAll
      return { resolved, reason: resolved ? 'Race condition fixed (sequential processing)' : 'Race condition not properly fixed' }
    },
  },
  {
    id: 'fix-sql-injection',
    type: 'security',
    prompt: `Fix all security vulnerabilities in this Express endpoint:

\`\`\`typescript
app.get("/user/:id", async (req, res) => {
  const user = await db.query(\`SELECT * FROM users WHERE id = \${req.params.id}\`)
  const posts = await db.query(\`SELECT * FROM posts WHERE user_id = \${req.params.id} AND status != 'draft'\`)
  res.json({ user, posts })
})
\`\`\`

Return ONLY the corrected code.`,
    accept(output) {
      const hasParamQuery = output.includes('?') || output.includes('$1') || output.includes('param') || output.includes('Param')
      const noTemplateLiteral = !output.includes('${req.params')
      const resolved = hasParamQuery && noTemplateLiteral
      return { resolved, reason: resolved ? 'SQL injection fixed' : 'SQL injection not fixed (still uses string interpolation)' }
    },
  },
  {
    id: 'impl-rate-limiter',
    type: 'code-gen',
    prompt: `Implement a token bucket rate limiter in TypeScript:
- Constructor takes (capacity: number, refillRate: number)
- allow(): returns true if request allowed, decrements tokens
- Thread-safe for concurrent calls (use simple mutex)
- Include 3 test cases

Return the complete code.`,
    accept(output) {
      const hasConstructor = output.includes('capacity') && output.includes('refillRate')
      const hasAllow = output.includes('allow') && (output.includes('return') || output.includes('=>'))
      const hasTest = (output.match(/test|Test|describe|it\(/g) || []).length >= 2
      const resolved = hasConstructor && hasAllow
      return { resolved, reason: resolved ? `Rate limiter impl found${hasTest ? ' with tests' : ' (no tests)'}` : 'Missing core components' }
    },
  },
  {
    id: 'refactor-strategy',
    type: 'refactor',
    prompt: `Refactor to strategy pattern — remove the if-else chain, make it extensible:

\`\`\`typescript
class PaymentProcessor {
  processPayment(type: string, amount: number) {
    if (type === "credit_card") {
      console.log(\`Processing credit card payment of $\${amount}\`)
    } else if (type === "paypal") {
      console.log(\`Processing PayPal payment of $\${amount}\`)
    } else if (type === "crypto") {
      console.log(\`Processing crypto payment of $\${amount}\`)
    }
  }
}
\`\`\`

Return the complete refactored code.`,
    accept(output) {
      const hasInterface = output.includes('interface') || output.includes('abstract') || output.includes('Strategy')
      const noIfElse = !output.includes('else if')
      const hasProcessMethod = output.includes('process')
      const resolved = hasInterface && noIfElse && hasProcessMethod
      return { resolved, reason: resolved ? 'Strategy pattern applied' : 'Still has if-else or missing strategy abstraction' }
    },
  },
]

// ── Config ───────────────────────────────────────────────────────────

type ModelRef = { id: string; model: string; provider: 'anthropic' | 'openai-compat'; baseUrl?: string }

const MODELS: Record<string, ModelRef> = {
  'haiku': { id: 'haiku', model: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
  'sonnet': { id: 'sonnet', model: 'claude-sonnet-4-6-20250514', provider: 'anthropic' },
  'opus':   { id: 'opus', model: 'claude-opus-4-7', provider: 'anthropic' },
  'deepseek': { id: 'deepseek', model: 'deepseek-chat', provider: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1' },
  'glm':      { id: 'glm', model: 'glm-4', provider: 'openai-compat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
}

interface TestConfig {
  label: string
  worker: ModelRef
  advisor: ModelRef | null
}

function buildConfigs(): TestConfig[] {
  const workerName = process.env.BENCH_WORKER || 'haiku'
  const worker = MODELS[workerName]
  if (!worker) {
    console.error(`Unknown worker: ${workerName}. Available: ${Object.keys(MODELS).join(', ')}`)
    process.exit(1)
  }

  const configs: TestConfig[] = []

  // Baseline: no advisor
  configs.push({ label: `${worker.id} (no advisor)`, worker, advisor: null })

  // Opus advisor (needs Anthropic key)
  if (process.env.ANTHROPIC_API_KEY) {
    configs.push({ label: `${worker.id} + opus`, worker, advisor: MODELS['opus'] })
    configs.push({ label: `${worker.id} + sonnet`, worker, advisor: MODELS['sonnet'] })
  }

  // DeepSeek advisor
  if (process.env.DEEPSEEK_API_KEY) {
    configs.push({ label: `${worker.id} + deepseek`, worker, advisor: MODELS['deepseek'] })
  }

  // GLM advisor
  if (process.env.GLM_API_KEY) {
    configs.push({ label: `${worker.id} + glm`, worker, advisor: MODELS['glm'] })
  }

  return configs
}

// ── API Calls ────────────────────────────────────────────────────────

const anthropic = new Anthropic()

interface CallResult {
  text: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

async function callAnthropic(
  model: string, system: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens = 4096,
): Promise<CallResult> {
  const start = Date.now()
  const r = await anthropic.messages.create({
    model, max_tokens: maxTokens, system,
    messages: messages as Anthropic.MessageParam[],
  })
  const text = r.content.find(b => b.type === 'text')
  return {
    text: text?.type === 'text' ? text.text : '',
    inputTokens: r.usage.input_tokens,
    outputTokens: r.usage.output_tokens,
    latencyMs: Date.now() - start,
  }
}

async function callOpenAI(
  model: string, baseUrl: string, system: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens = 4096,
): Promise<CallResult> {
  const start = Date.now()
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.GLM_API_KEY || ''
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages] }),
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  const data = await res.json() as any
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
  }
}

async function callModel(
  ref: ModelRef, system: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<CallResult> {
  return ref.provider === 'anthropic'
    ? callAnthropic(ref.model, system, messages)
    : callOpenAI(ref.model, ref.baseUrl!, system, messages)
}

function calcCost(ref: ModelRef, inputTokens: number, outputTokens: number): number {
  const p = getModelPrice(ref.model)
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
}

// ── Per-Run Result ───────────────────────────────────────────────────

interface RunResult {
  taskId: string
  configLabel: string
  resolved: boolean
  resolveReason: string
  advisorCalls: number
  workerInputTokens: number
  workerOutputTokens: number
  advisorInputTokens: number
  advisorOutputTokens: number
  totalCost: number
  wallMs: number
  output: string
}

// ── Run One Task ─────────────────────────────────────────────────────

async function runTask(task: Task, config: TestConfig): Promise<RunResult> {
  const wallStart = Date.now()
  let advisorCalls = 0
  let aIn = 0, aOut = 0, wIn = 0, wOut = 0

  // Advisor pre-review
  let advice = ''
  if (config.advisor) {
    advisorCalls++
    const ar = await callModel(config.advisor,
      'You are an expert code reviewer. Provide concise, actionable guidance.',
      [{ role: 'user', content: `Review and advise on this coding task:\n\n${task.prompt}` }],
    )
    advice = ar.text
    aIn += ar.inputTokens
    aOut += ar.outputTokens
  }

  // Worker executes
  const workerPrompt = advice
    ? `${task.prompt}\n\n---\nAdvisor guidance:\n${advice}\n---\nUse this guidance to produce a correct result.`
    : task.prompt

  const wr = await callModel(config.worker,
    'You are a coding assistant. Write clean, correct TypeScript code. Be thorough but concise.',
    [{ role: 'user', content: workerPrompt }],
    8192,
  )
  wIn += wr.inputTokens
  wOut += wr.outputTokens

  // Evaluate
  const { resolved, reason } = task.accept(wr.text)

  const wCost = calcCost(config.worker, wIn, wOut)
  const aCost = config.advisor ? calcCost(config.advisor, aIn, aOut) : 0

  return {
    taskId: task.id,
    configLabel: config.label,
    resolved,
    resolveReason: reason,
    advisorCalls,
    workerInputTokens: wIn,
    workerOutputTokens: wOut,
    advisorInputTokens: aIn,
    advisorOutputTokens: aOut,
    totalCost: wCost + aCost,
    wallMs: Date.now() - wallStart,
    output: wr.text,
  }
}

// ── Visual Report ────────────────────────────────────────────────────

function bar(pct: number, width = 20): string {
  const filled = Math.round(pct * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function fmt$(n: number): string {
  return n < 0.001 ? '<$0.001' : `$${n.toFixed(4)}`
}

function fmtToken(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

async function printReport(results: RunResult[]) {
  const configs = [...new Set(results.map(r => r.configLabel))]
  const tasks = [...new Set(results.map(r => r.taskId))]

  // ── Per-config summary ───────────────────────────────────────────
  console.log('\n' + '═'.repeat(80))
  console.log('  ADVISOR BENCHMARK RESULTS')
  console.log('═'.repeat(80))

  console.log('\n── Per-Config Summary ─'.repeat(1).slice(0, 60))
  console.log()

  const col1 = 30, col2 = 12, col3 = 14, col4 = 14, col5 = 12, col6 = 10
  console.log(
    'Config'.padEnd(col1) +
    '% Resolved'.padEnd(col2) +
    'Advisor Calls'.padEnd(col3) +
    'Total Tokens'.padEnd(col4) +
    'Cost'.padEnd(col5) +
    'Time'.padEnd(col6),
  )
  console.log('─'.repeat(col1 + col2 + col3 + col4 + col5 + col6))

  for (const cfg of configs) {
    const runs = results.filter(r => r.configLabel === cfg)
    const resolved = runs.filter(r => r.resolved).length
    const pct = resolved / runs.length
    const avgCalls = runs.reduce((s, r) => s + r.advisorCalls, 0) / runs.length
    const totalTokens = runs.reduce((s, r) => s + r.workerInputTokens + r.workerOutputTokens + r.advisorInputTokens + r.advisorOutputTokens, 0)
    const totalCost = runs.reduce((s, r) => s + r.totalCost, 0)
    const avgTime = runs.reduce((s, r) => s + r.wallMs, 0) / runs.length

    console.log(
      cfg.padEnd(col1) +
      `${(pct * 100).toFixed(0)}% ${bar(pct, 8)}`.padEnd(col2) +
      `${avgCalls.toFixed(1)}/task`.padEnd(col3) +
      fmtToken(totalTokens).padEnd(col4) +
      fmt$(totalCost).padEnd(col5) +
      `${(avgTime / 1000).toFixed(1)}s`.padEnd(col6),
    )
  }

  // ── Per-task breakdown ────────────────────────────────────────────
  console.log('\n── Per-Task Breakdown ─'.repeat(1).slice(0, 60))
  console.log()

  const taskCol = 20, resCol = 12, costCol = 12, tokenCol = 12, timeCol = 10, reasonCol = 30
  for (const cfg of configs) {
    console.log(`\n  ▶ ${cfg}`)
    console.log(
      '  ' +
      'Task'.padEnd(taskCol) +
      'Resolved?'.padEnd(resCol) +
      'Cost'.padEnd(costCol) +
      'Tokens'.padEnd(tokenCol) +
      'Time'.padEnd(timeCol) +
      'Detail'.padEnd(reasonCol),
    )
    console.log('  ' + '─'.repeat(taskCol + resCol + costCol + tokenCol + timeCol + reasonCol))

    for (const task of tasks) {
      const r = results.find(x => x.taskId === task && x.configLabel === cfg)
      if (!r) continue
      const totalT = r.workerInputTokens + r.workerOutputTokens + r.advisorInputTokens + r.advisorOutputTokens
      console.log(
        '  ' +
        r.taskId.padEnd(taskCol) +
        (r.resolved ? '✅ PASS' : '❌ FAIL').padEnd(resCol) +
        fmt$(r.totalCost).padEnd(costCol) +
        fmtToken(totalT).padEnd(tokenCol) +
        `${(r.wallMs / 1000).toFixed(1)}s`.padEnd(timeCol) +
        r.resolveReason.slice(0, reasonCol - 1).padEnd(reasonCol),
      )
    }
  }

  // ── Comparison matrix ─────────────────────────────────────────────
  console.log('\n── Resolution Comparison ─'.repeat(1).slice(0, 60))
  console.log()

  const cfgWidth = Math.max(...configs.map(c => c.length), 10) + 2
  let header = 'Task'.padEnd(16)
  for (const cfg of configs) header += cfg.padEnd(cfgWidth)
  console.log(header)
  console.log('─'.repeat(16 + cfgWidth * configs.length))

  for (const task of tasks) {
    let row = task.padEnd(16)
    for (const cfg of configs) {
      const r = results.find(x => x.taskId === task && x.configLabel === cfg)
      row += (r?.resolved ? '✅' : '❌').padEnd(cfgWidth)
    }
    console.log(row)
  }

  // ── Summary stats ─────────────────────────────────────────────────
  console.log('\n── Key Metrics ─'.repeat(1).slice(0, 60))
  console.log()

  const baseline = configs.find(c => c.includes('no advisor'))
  for (const cfg of configs) {
    if (cfg === baseline) continue
    const runs = results.filter(r => r.configLabel === cfg)
    const baseRuns = baseline ? results.filter(r => r.configLabel === baseline) : []
    const resolvedPct = runs.filter(r => r.resolved).length / runs.length * 100
    const baseResolvedPct = baseRuns.length ? baseRuns.filter(r => r.resolved).length / baseRuns.length * 100 : 0
    const delta = resolvedPct - baseResolvedPct
    const avgCost = runs.reduce((s, r) => s + r.totalCost, 0) / runs.length
    const baseAvgCost = baseRuns.length ? baseRuns.reduce((s, r) => s + r.totalCost, 0) / baseRuns.length : 0
    const costRatio = baseAvgCost > 0 ? avgCost / baseAvgCost : 0

    console.log(`  ${cfg}:`)
    console.log(`    Resolution: ${resolvedPct.toFixed(0)}% (${delta >= 0 ? '+' : ''}${delta.toFixed(0)}pp vs baseline)`)
    console.log(`    Cost/task:  ${fmt$(avgCost)} (${costRatio > 0 ? costRatio.toFixed(1) + 'x' : 'N/A'} of baseline)`)
    console.log()
  }

  // ── Save JSON ─────────────────────────────────────────────────────
  const fs = await import('fs')
  const path = await import('path')
  const outPath = path.join(import.meta.dir, 'local-results.json')
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`\n  Results saved: ${outPath}`)
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY is required')
    console.error('Usage: ANTHROPIC_API_KEY=sk-xxx bun run question/bench/local-test.ts')
    process.exit(1)
  }

  const configs = buildConfigs()
  const maxTasks = parseInt(process.env.BENCH_TASKS || '0') || TASKS.length
  const tasks = TASKS.slice(0, maxTasks)
  const total = tasks.length * configs.length

  console.log()
  console.log('═'.repeat(60))
  console.log('  ADVISOR LOCAL BENCHMARK')
  console.log('═'.repeat(60))
  console.log(`  ${tasks.length} tasks x ${configs.length} configs = ${total} runs`)
  console.log()
  for (const c of configs) {
    console.log(`  • ${c.label}`)
  }
  console.log()

  const results: RunResult[] = []

  for (const config of configs) {
    console.log(`\n▶ ${config.label}`)
    for (const task of tasks) {
      process.stdout.write(`  [${task.id}] `.padEnd(28))
      try {
        const r = await runTask(task, config)
        results.push(r)
        const icon = r.resolved ? '✅' : '❌'
        process.stdout.write(`${icon} ${r.resolveReason.slice(0, 35)}  (${(r.wallMs / 1000).toFixed(1)}s, ${fmt$(r.totalCost)})\n`)
      } catch (e: any) {
        process.stdout.write(`⚠️  ${e.message.slice(0, 60)}\n`)
      }
    }
  }

  await printReport(results)
}

main().catch(console.error)
