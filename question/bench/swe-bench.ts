#!/usr/bin/env bun
/**
 * SWE-bench 风格 Advisor 评测
 *
 * 对比: glm-4.5-air (haiku) solo  vs  glm-4.5-air + glm-5.1 advisor
 *
 * 用法:
 *   bash ./bin/claude-haha  # 确保环境可用
 *   bun run question/bench/swe-bench.ts
 *
 * 指标:
 *   - 解决率 (% Resolved)
 *   - Advisor 调用次数
 *   - Token 消耗
 *   - 单题成本
 *   - 耗时
 */

import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

// ── SWE-bench 风格任务 ───────────────────────────────────────────────

interface SWETask {
  id: string
  difficulty: 'medium' | 'hard'
  description: string
  // 准备函数：在工作目录创建待修改的文件
  setup: (dir: string) => void
  // 验证函数：检查修复是否正确
  verify: (dir: string) => { resolved: boolean; reason: string }
}

const TASKS: SWETask[] = [
  // ─── SWE-001: off-by-one in binary search ────────────────────────
  {
    id: 'SWE-001',
    difficulty: 'medium',
    description: 'Binary search returns wrong index for elements at the end of the array. The while loop condition causes it to miss the last element.',
    setup(dir) {
      writeFileSync(join(dir, 'search.ts'), `export function binarySearch(arr: number[], target: number): number {
  let left = 0
  let right = arr.length - 1
  while (left < right) {
    const mid = Math.floor((left + right) / 2)
    if (arr[mid] === target) return mid
    if (arr[mid] < target) left = mid + 1
    else right = mid
  }
  return -1
}
`)
      writeFileSync(join(dir, 'test.ts'), `import { binarySearch } from './search'
// Should find last element
console.log(binarySearch([1,2,3,4,5], 5))   // expect 4
console.log(binarySearch([1,2,3,4,5], 1))   // expect 0
console.log(binarySearch([1,2,3,4,5], 3))   // expect 2
console.log(binarySearch([1,2,3,4,5], 6))   // expect -1
console.log(binarySearch([10], 10))          // expect 0
`)
    },
    verify(dir) {
      const code = require('fs').readFileSync(join(dir, 'search.ts'), 'utf-8')
      // The bug is "while (left < right)" should be "while (left <= right)"
      const fixed = code.includes('left <= right') || code.includes('left<=right')
      // Also verify with bun
      try {
        const out = execSync(`bun run ${join(dir, 'test.ts')} 2>&1`, { timeout: 5000 }).toString()
        const lines = out.trim().split('\n').map(l => l.trim())
        const pass = lines[0] === '4' && lines[1] === '0' && lines[2] === '2' && lines[3] === '-1' && lines[4] === '0'
        return { resolved: pass, reason: pass ? 'All test cases pass' : `Test output: ${out.trim().slice(0, 100)}` }
      } catch (e: any) {
        return { resolved: false, reason: `Runtime error: ${e.message?.slice(0, 80)}` }
      }
    },
  },

  // ─── SWE-002: async iterator missing return ───────────────────────
  {
    id: 'SWE-002',
    difficulty: 'hard',
    description: 'AsyncPaginatedIterator has a bug: when fetchPage returns an empty array on the last page, the iterator throws TypeError instead of completing gracefully. Also, the nextPageToken is never cleared after the last page.',
    setup(dir) {
      writeFileSync(join(dir, 'iterator.ts'), `export class AsyncPaginatedIterator<T> implements AsyncIterableIterator<T> {
  private buffer: T[] = []
  private done = false
  private pageIndex = 0

  constructor(
    private fetchPage: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string }>,
    private pageToken?: string,
  ) {}

  async next(): Promise<IteratorResult<T>> {
    if (this.buffer.length === 0 && !this.done) {
      const result = await this.fetchPage(this.pageToken)
      this.buffer = result.items
      this.pageToken = result.nextPageToken
      if (!this.pageToken) this.done = true
    }
    if (this.buffer.length === 0) {
      return { value: undefined as any, done: true }
    }
    return { value: this.buffer.shift()!, done: false }
  }

  [Symbol.asyncIterator]() {
    return this
  }
}
`)
      writeFileSync(join(dir, 'test.ts'), `import { AsyncPaginatedIterator } from './iterator'

async function main() {
  const pages = [
    { items: ['a', 'b'], nextPageToken: 'page2' },
    { items: ['c'], nextPageToken: undefined },
  ]
  let callCount = 0
  const iter = new AsyncPaginatedIterator<string>(
    async (token) => pages[callCount++]
  )
  const results: string[] = []
  for await (const item of iter) {
    results.push(item)
  }
  console.log(results.join(','))
  // expect: a,b,c
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1) })
`)
    },
    verify(dir) {
      try {
        const out = execSync(`bun run ${join(dir, 'test.ts')} 2>&1`, { timeout: 10000 }).toString().trim()
        const pass = out === 'a,b,c'
        return { resolved: pass, reason: pass ? 'Iterator works correctly' : `Got: ${out.slice(0, 100)}` }
      } catch (e: any) {
        return { resolved: false, reason: `Error: ${e.message?.slice(0, 80)}` }
      }
    },
  },

  // ─── SWE-003: deep merge overwrites arrays ───────────────────────
  {
    id: 'SWE-003',
    difficulty: 'medium',
    description: 'deepMerge function has a bug: when both source and target have an array at the same key, it replaces the array instead of concatenating. This causes data loss. Also, it mutates the original target object.',
    setup(dir) {
      writeFileSync(join(dir, 'merge.ts'), `export function deepMerge(target: any, source: any): any {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {}
      deepMerge(target[key], source[key])
    } else {
      target[key] = source[key]
    }
  }
  return target
}
`)
      writeFileSync(join(dir, 'test.ts'), `import { deepMerge } from './merge'

const a = { x: [1, 2], y: { z: 1 } }
const b = { x: [3], y: { w: 2 } }
const result = deepMerge(a, b)

// Arrays should be concatenated, not replaced
const arrOk = JSON.stringify(result.x) === '[1,2,3]'
// Original should not be mutated
const origOk = JSON.stringify(a.x) === '[1,2]'
// Nested merge
const nestedOk = result.y.z === 1 && result.y.w === 2

console.log(JSON.stringify({ arrOk, origOk, nestedOk, result }))
`)
    },
    verify(dir) {
      try {
        const out = execSync(`bun run ${join(dir, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim()
        const data = JSON.parse(out)
        const pass = data.arrOk && data.origOk && data.nestedOk
        return { resolved: pass, reason: pass ? 'Deep merge correct' : `arrOk=${data.arrOk} origOk=${data.origOk} nestedOk=${data.nestedOk}` }
      } catch (e: any) {
        return { resolved: false, reason: `Error: ${e.message?.slice(0, 80)}` }
      }
    },
  },

  // ─── SWE-004: LRU cache eviction bug ──────────────────────────────
  {
    id: 'SWE-004',
    difficulty: 'hard',
    description: 'LRUCache has two bugs: (1) When updating an existing key, it appends to the end but does NOT remove the old position from the middle — causing duplicate entries and wrong eviction order. (2) The eviction evicts from the wrong end — it removes the most-recently-used instead of the least-recently-used.',
    setup(dir) {
      writeFileSync(join(dir, 'lru.ts'), `export class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private order: K[] = []
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined
    this.order = this.order.filter(k => k !== key)
    this.order.push(key)
    return this.cache.get(key)
  }

  set(key: K, value: V): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const lruKey = this.order.pop()!
      this.cache.delete(lruKey)
    }
    this.cache.set(key, value)
    this.order.push(key)
  }

  getOrder(): K[] { return [...this.order] }
}
`)
      writeFileSync(join(dir, 'test.ts'), `import { LRUCache } from './lru'

const cache = new LRUCache<string, number>(3)
cache.set('a', 1)
cache.set('b', 2)
cache.set('c', 3)
// evict oldest (a), add d
cache.set('d', 4)

const hasA = cache.get('a')  // should be undefined (evicted)
const hasB = cache.get('b')  // should be 2
const hasC = cache.get('c')  // should be 3
const hasD = cache.get('d')  // should be 4

const pass = hasA === undefined && hasB === 2 && hasC === 3 && hasD === 4
console.log(JSON.stringify({ hasA, hasB, hasC, hasD, pass }))
`)
    },
    verify(dir) {
      try {
        const out = execSync(`bun run ${join(dir, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim()
        const data = JSON.parse(out)
        return { resolved: !!data.pass, reason: data.pass ? 'LRU eviction correct' : `hasA=${data.hasA} hasB=${data.hasB} hasC=${data.hasC} hasD=${data.hasD}` }
      } catch (e: any) {
        return { resolved: false, reason: `Error: ${e.message?.slice(0, 80)}` }
      }
    },
  },

  // ─── SWE-005: debounced function drops trailing call ──────────────
  {
    id: 'SWE-005',
    difficulty: 'medium',
    description: 'debounce function has a bug: it drops the last call when leading=true and trailing=true. If you call it twice quickly with different args, only the first call executes. Also, the cancel method does not properly clear the pending timeout.',
    setup(dir) {
      writeFileSync(join(dir, 'debounce.ts'), `type Fn = (...args: any[]) => void

export function debounce(fn: Fn, ms: number, options: { leading?: boolean; trailing?: boolean } = {}): Fn & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: any[] | null = null

  const debounced = function(this: any, ...args: any[]) {
    lastArgs = args
    if (options.leading && !timer) {
      fn.apply(this, args)
      lastArgs = null
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (options.trailing && lastArgs) {
        fn.apply(this, lastArgs)
      }
      timer = null
    }, ms)
  } as Fn & { cancel: () => void }

  debounced.cancel = () => {
    if (timer) clearTimeout(timer)
  }

  return debounced
}
`)
      writeFileSync(join(dir, 'test.ts'), `import { debounce } from './debounce'

const calls: string[] = []
const fn = debounce((v: string) => calls.push(v), 50, { leading: true, trailing: true })

fn('a')
fn('b')

setTimeout(() => {
  // Should have 'a' (leading) and 'b' (trailing)
  const pass = calls.length === 2 && calls[0] === 'a' && calls[1] === 'b'
  console.log(JSON.stringify({ calls, pass }))
  process.exit(pass ? 0 : 1)
}, 150)
`)
    },
    verify(dir) {
      try {
        const out = execSync(`bun run ${join(dir, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim()
        const data = JSON.parse(out)
        return { resolved: !!data.pass, reason: data.pass ? 'Debounce trailing+leading correct' : `calls=${JSON.stringify(data.calls)}` }
      } catch (e: any) {
        return { resolved: false, reason: `Error: ${e.message?.slice(0, 80)}` }
      }
    },
  },

  // ─── SWE-006: event emitter memory leak ───────────────────────────
  {
    id: 'SWE-006',
    difficulty: 'hard',
    description: 'EventEmitter has a subtle memory leak: when removeListener is called during event emission (inside a listener callback), it breaks the iteration because the listeners array is modified while being iterated. The once() method also has a bug: if the listener throws, the wrapper is never removed.',
    setup(dir) {
      writeFileSync(join(dir, 'emitter.ts'), `type Listener = (...args: any[]) => void

export class EventEmitter {
  private events = new Map<string, Listener[]>()

  on(event: string, listener: Listener): () => void {
    const listeners = this.events.get(event) || []
    listeners.push(listener)
    this.events.set(event, listeners)
    return () => this.off(event, listener)
  }

  once(event: string, listener: Listener): () => void {
    const wrapper: Listener = (...args) => {
      listener(...args)
      this.off(event, wrapper)
    }
    return this.on(event, wrapper)
  }

  off(event: string, listener: Listener): void {
    const listeners = this.events.get(event)
    if (listeners) {
      this.events.set(event, listeners.filter(l => l !== listener))
    }
  }

  emit(event: string, ...args: any[]): void {
    const listeners = this.events.get(event)
    if (listeners) {
      for (const listener of listeners) {
        listener(...args)
      }
    }
  }

  listenerCount(event: string): number {
    return this.events.get(event)?.length ?? 0
  }
}
`)
      writeFileSync(join(dir, 'test.ts'), `import { EventEmitter } from './emitter'

const ee = new EventEmitter()
const results: number[] = []

// Test: removeListener during emission
ee.on('test', () => results.push(1))
const remover = ee.on('test', () => {
  results.push(2)
  remover()  // remove self during emission
})
ee.on('test', () => results.push(3))

ee.emit('test')
// Should get [1, 2, 3] — all listeners fire, then the middle one is removed

const pass = results.length === 3 && results[0] === 1 && results[1] === 2 && results[2] === 3
const remaining = ee.listenerCount('test')

console.log(JSON.stringify({ results, pass, remaining }))
`)
    },
    verify(dir) {
      try {
        const out = execSync(`bun run ${join(dir, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim()
        const data = JSON.parse(out)
        return { resolved: !!data.pass && data.remaining === 2, reason: data.pass ? `Emitter correct, ${data.remaining} listeners remain` : `results=${JSON.stringify(data.results)} remaining=${data.remaining}` }
      } catch (e: any) {
        return { resolved: false, reason: `Error: ${e.message?.slice(0, 80)}` }
      }
    },
  },

  // ─── SWE-007: promise pool concurrency bug ────────────────────────
  {
    id: 'SWE-007',
    difficulty: 'hard',
    description: 'PromisePool has a bug: when a task rejects, the remaining tasks still execute and the pool never settles. The error handling is broken — Promise.allSettled is used but errors are swallowed. Also, when concurrency > tasks.length, it never completes because it waits for a slot that will never be needed.',
    setup(dir) {
      writeFileSync(join(dir, 'pool.ts'), `export class PromisePool<T> {
  private results: PromiseSettledResult<T>[] = []
  private running = 0
  private index = 0

  constructor(
    private items: T[],
    private fn: (item: T, index: number) => Promise<void>,
    private concurrency: number = 4,
  ) {}

  async run(): Promise<PromiseSettledResult<T>[]> {
    return new Promise((resolve) => {
      const next = () => {
        while (this.running < this.concurrency && this.index < this.items.length) {
          const i = this.index++
          this.running++
          this.fn(this.items[i], i)
            .then(() => { this.results[i] = { status: 'fulfilled', value: this.items[i] } })
            .catch((e) => { this.results[i] = { status: 'rejected', reason: e } })
            .finally(() => { this.running--; next() })
        }
        if (this.running === 0 && this.index >= this.items.length) {
          resolve(this.results)
        }
      }
      next()
    })
  }
}
`)
      writeFileSync(join(dir, 'test.ts'), `import { PromisePool } from './pool'

async function main() {
  const order: number[] = []
  const items = [1, 2, 3, 4, 5]
  const pool = new PromisePool(items, async (item, i) => {
    order.push(item)
    if (item === 3) throw new Error('fail on 3')
    await new Promise(r => setTimeout(r, 10))
  }, 2)

  const results = await pool.run
  const settled = results.filter(r => r).length
  const rejected = results.filter(r => r?.status === 'rejected').length
  const pass = settled === 5 && rejected === 1 && order.length === 5

  console.log(JSON.stringify({ settled, rejected, orderLen: order.length, pass }))
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1) })
`)
    },
    verify(dir) {
      try {
        const out = execSync(`bun run ${join(dir, 'test.ts')} 2>&1`, { timeout: 10000 }).toString().trim()
        // Check if it even completed (pool might hang)
        const data = JSON.parse(out)
        return { resolved: !!data.pass, reason: data.pass ? 'Promise pool correct' : `settled=${data.settled} rejected=${data.rejected} orderLen=${data.orderLen}` }
      } catch (e: any) {
        const msg = e.message ?? ''
        if (msg.includes('timed out')) return { resolved: false, reason: 'Pool hung (concurrency bug)' }
        return { resolved: false, reason: `Error: ${msg.slice(0, 80)}` }
      }
    },
  },
]

// ── CLI Runner ───────────────────────────────────────────────────────

interface RunResult {
  taskId: string
  config: string
  resolved: boolean
  reason: string
  advisorCalls: number
  durationMs: number
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

function runTask(task: SWETask, config: 'solo' | 'with-advisor'): RunResult {
  const workDir = join('/tmp', `swe-bench-${task.id}-${config}-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })

  // Setup: create the buggy file
  task.setup(workDir)

  const prompt = `You are given a buggy TypeScript file in ${workDir}/.
The bug description is: ${task.description}

Your task:
1. Read the source file(s)
2. Understand the bug
3. Fix the code in-place
4. Make sure the test file passes when run with: bun run ${workDir}/test.ts

ONLY edit the source file (not the test file). When done, explain the fix briefly.`

  const envVars = {
    ...process.env,
    CLAUDE_CODE_ADVISOR_ENABLED: config === 'with-advisor' ? 'true' : '',
    CLAUDE_CODE_ADVISOR_MODEL: config === 'with-advisor' ? 'glm-5.1' : '',
    CC_HAHA_SKIP_DOTENV: '0',  // use .env
  }

  const cmd = [
    'bash', './bin/claude-haha',
    '-p', prompt,
    '--model', 'glm-4.5-air',
    '--dangerously-skip-permissions',
    '--output-format', 'json',
    '--max-budget-usd', '0.5',
  ]

  const start = Date.now()
  let stdout = ''
  let exitCode = 0

  try {
    stdout = execSync(cmd.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(' '), {
      cwd: '/Users/jasonjcwu/Documents/GitHub/cc-haha',
      env: envVars,
      timeout: 180_000,  // 3 min per task
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    })
  } catch (e: any) {
    stdout = e.stdout ?? ''
    exitCode = e.status ?? 1
  }
  const durationMs = Date.now() - start

  // Parse JSON output
  let advisorCalls = 0
  let totalCostUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0

  try {
    const data = JSON.parse(stdout)
    totalCostUsd = data.total_cost_usd ?? 0
    inputTokens = data.usage?.input_tokens ?? 0
    outputTokens = data.usage?.output_tokens ?? 0
    cacheReadTokens = data.usage?.cache_read_input_tokens ?? 0
    // Count advisor tool calls from num_turns (rough estimate)
    const result = data.result ?? ''
    advisorCalls = (result.match(/\[Advisor/g) || []).length
  } catch {}

  // Verify fix
  const { resolved, reason } = task.verify(workDir)

  // Cleanup
  try { rmSync(workDir, { recursive: true }) } catch {}

  return {
    taskId: task.id,
    config,
    resolved,
    reason,
    advisorCalls,
    durationMs,
    totalCostUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
  }
}

// ── Report ───────────────────────────────────────────────────────────

function bar(pct: number, w = 15) {
  const f = Math.round(pct * w)
  return '█'.repeat(f) + '░'.repeat(w - f)
}
function fmt$(n: number) { return n < 0.001 ? '<$0.001' : `$${n.toFixed(3)}` }
function fmtTok(n: number) { return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n) }

function printReport(solo: RunResult[], advised: RunResult[]) {
  console.log('\n' + '═'.repeat(78))
  console.log('  SWE-BENCH STYLE — ADVISOR EVALUATION')
  console.log('  Worker: glm-4.5-air (haiku)  |  Advisor: glm-5.1 (opus)')
  console.log('═'.repeat(78))

  // Per-task results
  console.log('\n── Per-Task Results ──\n')

  const cfg = (r: RunResult) => r.config === 'with-advisor' ? 'haiku+opus' : 'haiku solo'
  const icon = (r: RunResult) => r.resolved ? '✅' : '❌'

  const colW = [12, 15, 10, 10, 10, 12, 10]
  const headers = ['Task', 'Config', 'Result', 'Time', 'Tokens', 'Cost', 'Detail']
  console.log(headers.map((h, i) => h.padEnd(colW[i])).join(' '))
  console.log('─'.repeat(colW.reduce((a, b) => a + b, 0)))

  const all = [...solo, ...advised].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.config.localeCompare(b.config))
  for (const r of all) {
    const totalT = r.inputTokens + r.outputTokens + r.cacheReadTokens
    const detail = r.resolved ? r.reason.slice(0, 25) : r.reason.slice(0, 25)
    console.log([
      r.taskId.padEnd(colW[0]),
      cfg(r).padEnd(colW[1]),
      icon(r).padEnd(colW[2]),
      `${(r.durationMs/1000).toFixed(1)}s`.padEnd(colW[3]),
      fmtTok(totalT).padEnd(colW[4]),
      fmt$(r.totalCostUsd).padEnd(colW[5]),
      detail,
    ].join(' '))
  }

  // Summary
  console.log('\n── Summary ──\n')

  for (const [label, runs] of [['haiku solo', solo], ['haiku+opus', advised]] as const) {
    const resolved = runs.filter(r => r.resolved).length
    const pct = resolved / runs.length
    const avgTime = runs.reduce((s, r) => s + r.durationMs, 0) / runs.length
    const totalCost = runs.reduce((s, r) => s + r.totalCostUsd, 0)
    const totalTokens = runs.reduce((s, r) => s + r.inputTokens + r.outputTokens + r.cacheReadTokens, 0)
    const avgAdvisor = runs.reduce((s, r) => s + r.advisorCalls, 0) / runs.length

    console.log(`  ${label}:`)
    console.log(`    % Resolved:     ${(pct * 100).toFixed(0)}%  ${bar(pct)}`)
    console.log(`    Advisor calls:  ${avgAdvisor.toFixed(1)} / task`)
    console.log(`    Total tokens:   ${fmtTok(totalTokens)}`)
    console.log(`    Total cost:     ${fmt$(totalCost)}`)
    console.log(`    Avg time/task:  ${(avgTime / 1000).toFixed(1)}s`)
    console.log()
  }

  // Delta
  const soloPct = solo.filter(r => r.resolved).length / solo.length * 100
  const advPct = advised.filter(r => r.resolved).length / advised.length * 100
  const soloCost = solo.reduce((s, r) => s + r.totalCostUsd, 0) / solo.length
  const advCost = advised.reduce((s, r) => s + r.totalCostUsd, 0) / advised.length

  console.log('── Delta ──\n')
  console.log(`  Resolution: ${advPct >= soloPct ? '+' : ''}${(advPct - soloPct).toFixed(0)}pp`)
  console.log(`  Cost:       ${advCost >= soloCost ? '+' : ''}${fmt$(advCost - soloCost)}/task (${(advCost / soloCost).toFixed(1)}x)`)
  console.log()

  // Resolution matrix
  console.log('── Resolution Matrix ──\n')
  console.log('Task        haiku solo   haiku+opus')
  console.log('─'.repeat(38))
  for (const s of solo) {
    const a = advised.find(r => r.taskId === s.taskId)!
    console.log(`${s.taskId.padEnd(12)}${(s.resolved ? '✅' : '❌').padEnd(14)}${a.resolved ? '✅' : '❌'}`)
  }

  // Save
  writeFileSync(
    join(import.meta.dir, 'swe-results.json'),
    JSON.stringify({ solo, advised, timestamp: new Date().toISOString() }, null, 2),
  )
  console.log(`\n  Saved: question/bench/swe-results.json`)
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log('  SWE-BENCH ADVISOR TEST')
  console.log(`  ${TASKS.length} tasks × 2 configs (solo + advisor)`)
  console.log('  Worker: glm-4.5-air  Advisor: glm-5.1')
  console.log('═'.repeat(60))

  const soloResults: RunResult[] = []
  const advisedResults: RunResult[] = []

  // Phase 1: haiku solo
  console.log('\n▶ Phase 1: haiku solo (no advisor)')
  for (const task of TASKS) {
    process.stdout.write(`  [${task.id}] (${task.difficulty}) `.padEnd(24))
    try {
      const r = runTask(task, 'solo')
      soloResults.push(r)
      console.log(`${r.resolved ? '✅' : '❌'} ${r.reason.slice(0, 40)}  (${(r.durationMs/1000).toFixed(1)}s)`)
    } catch (e: any) {
      console.log(`⚠️  ${e.message?.slice(0, 60)}`)
    }
  }

  // Phase 2: haiku + opus advisor
  console.log('\n▶ Phase 2: haiku + opus advisor')
  for (const task of TASKS) {
    process.stdout.write(`  [${task.id}] (${task.difficulty}) `.padEnd(24))
    try {
      const r = runTask(task, 'with-advisor')
      advisedResults.push(r)
      console.log(`${r.resolved ? '✅' : '❌'} ${r.reason.slice(0, 40)}  (${(r.durationMs/1000).toFixed(1)}s)`)
    } catch (e: any) {
      console.log(`⚠️  ${e.message?.slice(0, 60)}`)
    }
  }

  printReport(soloResults, advisedResults)
}

main().catch(console.error)
