#!/usr/bin/env bun
/**
 * Phase 1 + 2 闭环评测
 *
 * Phase 1: 基础能力 (7 题, 已验证) — bug-fix / security / refactor
 * Phase 2: Advisor 强项 (8 题新题) — 竞态 / 边界 / 语义陷阱 / 架构决策
 *
 * 总共 15 题 × 2 config = 30 runs
 * 预计 ~$12, ~15 分钟
 */

import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

interface Task {
  id: string
  phase: 1 | 2
  category: string
  difficulty: string
  setup: (dir: string) => void
  verify: (dir: string) => { resolved: boolean; reason: string }
}

interface RunResult {
  taskId: string
  phase: number
  category: string
  config: string
  resolved: boolean
  reason: string
  durationMs: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: 基础能力 (上次的 7 题)
// ═══════════════════════════════════════════════════════════════

const PHASE1: Task[] = [
  {
    id: 'P1-001', phase: 1, category: 'algorithm', difficulty: 'medium',
    setup(d) {
      writeFileSync(join(d, 'search.ts'), `export function binarySearch(arr: number[], target: number): number {
  let left = 0, right = arr.length - 1
  while (left < right) {
    const mid = Math.floor((left + right) / 2)
    if (arr[mid] === target) return mid
    if (arr[mid] < target) left = mid + 1; else right = mid
  }
  return -1
}`)
      writeFileSync(join(d, 'test.ts'), `import { binarySearch } from './search'
console.log(binarySearch([1,2,3,4,5], 5))
console.log(binarySearch([1,2,3,4,5], 1))
console.log(binarySearch([10], 10))`)
    },
    verify(d) {
      try {
        const out = execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim().split('\n')
        const pass = out[0] === '4' && out[1] === '0' && out[2] === '0'
        return { resolved: pass, reason: pass ? 'All pass' : `Got: ${out.join(',')}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P1-002', phase: 1, category: 'async', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'iterator.ts'), `export class AsyncPaginatedIterator<T> implements AsyncIterableIterator<T> {
  private buffer: T[] = []; private done = false; private pageIndex = 0
  constructor(private fetchPage: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string }>, private pageToken?: string) {}
  async next(): Promise<IteratorResult<T>> {
    if (this.buffer.length === 0 && !this.done) {
      const result = await this.fetchPage(this.pageToken)
      this.buffer = result.items; this.pageToken = result.nextPageToken
      if (!this.pageToken) this.done = true
    }
    if (this.buffer.length === 0) return { value: undefined as any, done: true }
    return { value: this.buffer.shift()!, done: false }
  }
  [Symbol.asyncIterator]() { return this }
}`)
      writeFileSync(join(d, 'test.ts'), `import { AsyncPaginatedIterator } from './iterator'
async function main() {
  const pages = [{ items: ['a','b'], nextPageToken: 'p2' }, { items: ['c'], nextPageToken: undefined }]
  let c = 0
  const iter = new AsyncPaginatedIterator<string>(async () => pages[c++])
  const r: string[] = []
  for await (const item of iter) r.push(item)
  console.log(r.join(','))
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1) })`)
    },
    verify(d) {
      try {
        const out = execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 10000 }).toString().trim()
        return { resolved: out === 'a,b,c', reason: out === 'a,b,c' ? 'Iterator works' : `Got: ${out}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P1-003', phase: 1, category: 'data-structure', difficulty: 'medium',
    setup(d) {
      writeFileSync(join(d, 'merge.ts'), `export function deepMerge(target: any, source: any): any {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {}
      deepMerge(target[key], source[key])
    } else { target[key] = source[key] }
  }
  return target
}`)
      writeFileSync(join(d, 'test.ts'), `import { deepMerge } from './merge'
const a = { x: [1, 2], y: { z: 1 } }
const b = { x: [3], y: { w: 2 } }
const r = deepMerge({ x: [1, 2], y: { z: 1 } }, b)
const arrOk = JSON.stringify(r.x) === '[1,2,3]'
const origOk = JSON.stringify(a.x) === '[1,2]'
const nestedOk = r.y.z === 1 && r.y.w === 2
console.log(JSON.stringify({ arrOk, origOk, nestedOk }))`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        return { resolved: out.arrOk && out.origOk && out.nestedOk, reason: `arr=${out.arrOk} orig=${out.origOk} nested=${out.nestedOk}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P1-004', phase: 1, category: 'data-structure', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'lru.ts'), `export class LRUCache<K, V> {
  private cache = new Map<K, V>(); private order: K[] = []
  constructor(private maxSize: number) {}
  get(key: K): V | undefined { if (!this.cache.has(key)) return undefined; this.order = this.order.filter(k => k !== key); this.order.push(key); return this.cache.get(key) }
  set(key: K, value: V): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) { const lruKey = this.order.pop()!; this.cache.delete(lruKey) }
    this.cache.set(key, value); this.order.push(key)
  }
}`)
      writeFileSync(join(d, 'test.ts'), `import { LRUCache } from './lru'
const c = new LRUCache<string, number>(3)
c.set('a',1); c.set('b',2); c.set('c',3); c.set('d',4)
console.log(JSON.stringify({ a: c.get('a'), b: c.get('b'), c: c.get('c'), d: c.get('d') }))`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        return { resolved: out.a === undefined && out.b === 2 && out.c === 3 && out.d === 4, reason: `a=${out.a} b=${out.b} c=${out.c} d=${out.d}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P1-005', phase: 1, category: 'timing', difficulty: 'medium',
    setup(d) {
      writeFileSync(join(d, 'debounce.ts'), `type Fn = (...args: any[]) => void
export function debounce(fn: Fn, ms: number, options: { leading?: boolean; trailing?: boolean } = {}): Fn & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null; let lastArgs: any[] | null = null
  const debounced = function(this: any, ...args: any[]) {
    lastArgs = args
    if (options.leading && !timer) { fn.apply(this, args); lastArgs = null }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { if (options.trailing && lastArgs) fn.apply(this, lastArgs); timer = null }, ms)
  } as Fn & { cancel: () => void }
  debounced.cancel = () => { if (timer) clearTimeout(timer) }
  return debounced
}`)
      writeFileSync(join(d, 'test.ts'), `import { debounce } from './debounce'
const calls: string[] = []
const fn = debounce((v: string) => calls.push(v), 50, { leading: true, trailing: true })
fn('a'); fn('b')
setTimeout(() => { const pass = calls.length === 2 && calls[0] === 'a' && calls[1] === 'b'; console.log(JSON.stringify({ calls, pass })); process.exit(pass ? 0 : 1) }, 150)`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        return { resolved: !!out.pass, reason: `calls=${JSON.stringify(out.calls)}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P1-006', phase: 1, category: 'concurrency', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'emitter.ts'), `type Listener = (...args: any[]) => void
export class EventEmitter {
  private events = new Map<string, Listener[]>()
  on(event: string, listener: Listener): () => void { const l = this.events.get(event) || []; l.push(listener); this.events.set(event, l); return () => this.off(event, listener) }
  once(event: string, listener: Listener): () => void { const w: Listener = (...a) => { listener(...a); this.off(event, w) }; return this.on(event, w) }
  off(event: string, listener: Listener): void { const l = this.events.get(event); if (l) this.events.set(event, l.filter(x => x !== listener)) }
  emit(event: string, ...args: any[]): void { const l = this.events.get(event); if (l) for (const fn of l) fn(...args) }
  listenerCount(event: string): number { return this.events.get(event)?.length ?? 0 }
}`)
      writeFileSync(join(d, 'test.ts'), `import { EventEmitter } from './emitter'
const ee = new EventEmitter(); const r: number[] = []
ee.on('t', () => r.push(1))
const rm = ee.on('t', () => { r.push(2); rm() })
ee.on('t', () => r.push(3))
ee.emit('t')
const pass = r.length === 3 && r[0] === 1 && r[1] === 2 && r[2] === 3
console.log(JSON.stringify({ r, pass, count: ee.listenerCount('t') }))`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        return { resolved: !!out.pass && out.count === 2, reason: `r=${JSON.stringify(out.r)} count=${out.count}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P1-007', phase: 1, category: 'async', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'pool.ts'), `export class PromisePool<T> {
  private results: PromiseSettledResult<T>[] = []; private running = 0; private index = 0
  constructor(private items: T[], private fn: (item: T, index: number) => Promise<void>, private concurrency: number = 4) {}
  async run(): Promise<PromiseSettledResult<T>[]> {
    return new Promise((resolve) => {
      const next = () => {
        while (this.running < this.concurrency && this.index < this.items.length) {
          const i = this.index++; this.running++
          this.fn(this.items[i], i).then(() => { this.results[i] = { status: 'fulfilled', value: this.items[i] } })
            .catch((e) => { this.results[i] = { status: 'rejected', reason: e } }).finally(() => { this.running--; next() })
        }
        if (this.running === 0 && this.index >= this.items.length) resolve(this.results)
      }
      next()
    })
  }
}`)
      writeFileSync(join(d, 'test.ts'), `import { PromisePool } from './pool'
async function main() {
  const order: number[] = []
  const pool = new PromisePool([1,2,3,4,5], async (item) => {
    order.push(item); if (item === 3) throw new Error('fail'); await new Promise(r => setTimeout(r, 10))
  }, 2)
  const results = await pool.run()
  const settled = results.filter(Boolean).length; const rejected = results.filter(r => r?.status === 'rejected').length
  console.log(JSON.stringify({ settled, rejected, orderLen: order.length, pass: settled === 5 && rejected === 1 }))
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1) })`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 10000 }).toString().trim())
        return { resolved: !!out.pass, reason: `settled=${out.settled} rejected=${out.rejected}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
]

// ═══════════════════════════════════════════════════════════════
// Phase 2: Advisor 强项题 — 竞态/语义/安全/架构
// ═══════════════════════════════════════════════════════════════

const PHASE2: Task[] = [
  {
    id: 'P2-001', phase: 2, category: 'race-condition', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'counter.ts'), `export class AtomicCounter {
  private value = 0
  async increment(): Promise<number> {
    const current = this.value
    await new Promise(r => setTimeout(r, 1))
    this.value = current + 1
    return this.value
  }
  get(): number { return this.value }
}`)
      writeFileSync(join(d, 'test.ts'), `import { AtomicCounter } from './counter'
async function main() {
  const c = new AtomicCounter()
  await Promise.all(Array(10).fill(null).map(() => c.increment()))
  console.log(c.get())
}
main()`)
    },
    verify(d) {
      try {
        const out = execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim()
        const pass = out === '10'
        return { resolved: pass, reason: pass ? 'Counter is atomic' : `Got ${out} (expected 10)` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P2-002', phase: 2, category: 'edge-case', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'json-path.ts'), `export function getByPath(obj: any, path: string): any {
  const keys = path.split('.')
  let current = obj
  for (const key of keys) {
    if (current == null) return undefined
    // Bug: doesn't handle array indices like items[0]
    current = current[key]
  }
  return current
}`)
      writeFileSync(join(d, 'test.ts'), `import { getByPath } from './json-path'
const obj = { items: [{ name: 'a' }, { name: 'b' }], data: { x: 1 } }
const r1 = getByPath(obj, 'data.x')
const r2 = getByPath(obj, 'items[0].name')
const r3 = getByPath(obj, 'items[1].name')
const r4 = getByPath(obj, 'missing.path')
console.log(JSON.stringify({ r1, r2, r3, r4 }))`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        const pass = out.r1 === 1 && out.r2 === 'a' && out.r3 === 'b' && out.r4 === undefined
        return { resolved: pass, reason: `r1=${out.r1} r2=${out.r2} r3=${out.r3} r4=${out.r4}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P2-003', phase: 2, category: 'security', difficulty: 'medium',
    setup(d) {
      writeFileSync(join(d, 'sanitize.ts'), `export function sanitizeHtml(input: string): string {
  // Bug: doesn't handle nested tags or on* attributes
  return input.replace(/<script[^>]*>.*?<\\/script>/gi, '')
}`)
      writeFileSync(join(d, 'test.ts'), `import { sanitizeHtml } from './sanitize'
const r1 = sanitizeHtml('<script>alert(1)</script>')
const r2 = sanitizeHtml('<img src=x onerror=alert(1)>')
const r3 = sanitizeHtml('<<script>script>alert(1)</script>')
const pass = !r1.includes('alert') && !r2.includes('onerror') && !r3.includes('alert')
console.log(JSON.stringify({ r1: r1.length < 5, r2clean: !r2.includes('onerror'), r3clean: !r3.includes('alert'), pass }))`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        return { resolved: !!out.pass, reason: `r1=${out.r1} r2=${out.r2clean} r3=${out.r3clean}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P2-004', phase: 2, category: 'semantic-trap', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'clone.ts'), `export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(item => deepClone(item)) as any
  const result: any = {}
  for (const key of Object.keys(obj)) {
    result[key] = deepClone((obj as any)[key])
  }
  // Bug: doesn't handle Date, RegExp, Map, Set
  return result
}`)
      writeFileSync(join(d, 'test.ts'), `import { deepClone } from './clone'
const original = { date: new Date('2024-01-01'), regex: /test/gi, map: new Map([['a', 1]]), arr: [1, 2] }
const cloned = deepClone(original)
const dateOk = cloned.date instanceof Date && cloned.date.getTime() === original.date.getTime() && cloned.date !== original.date
const regexOk = cloned.regex instanceof RegExp && cloned.regex.source === original.regex.source && cloned.regex !== original.regex
const mapOk = cloned.map instanceof Map && cloned.map.get('a') === 1 && cloned.map !== original.map
console.log(JSON.stringify({ dateOk, regexOk, mapOk }))`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        const pass = out.dateOk && out.regexOk && out.mapOk
        return { resolved: pass, reason: `date=${out.dateOk} regex=${out.regexOk} map=${out.mapOk}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P2-005', phase: 2, category: 'concurrency', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'semaphore.ts'), `export class Semaphore {
  private waiting: (() => void)[] = []
  constructor(private permits: number) {}
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return }
    // Bug: never resolves when permits are 0
    return new Promise(() => {})
  }
  release(): void {
    this.permits++
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!
      next()
    }
  }
}`)
      writeFileSync(join(d, 'test.ts'), `import { Semaphore } from './semaphore'
async function main() {
  const sem = new Semaphore(2)
  const order: number[] = []
  const tasks = [1,2,3,4].map(async (n) => {
    await sem.acquire()
    order.push(n)
    await new Promise(r => setTimeout(r, 20))
    order.push(n * 10)
    sem.release()
  })
  await Promise.all(tasks)
  // All 4 should complete
  const pass = order.length === 8 && order.includes(10) && order.includes(20) && order.includes(30) && order.includes(40)
  console.log(JSON.stringify({ orderLen: order.length, pass }))
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1) })`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 10000 }).toString().trim())
        return { resolved: !!out.pass, reason: `orderLen=${out.orderLen}` }
      } catch (e: any) { return { resolved: false, reason: `Timeout/hang: ${e.message?.slice(0, 40)}` } }
    },
  },
  {
    id: 'P2-006', phase: 2, category: 'semantic-trap', difficulty: 'medium',
    setup(d) {
      writeFileSync(join(d, 'flatten.ts'), `export function flatten(arr: any[], depth: number = Infinity): any[] {
  // Bug: depth parameter ignored, always flattens fully
  return arr.reduce((acc, item) => {
    if (Array.isArray(item)) return acc.concat(flatten(item, depth))
    return acc.concat(item)
  }, [] as any[])
}`)
      writeFileSync(join(d, 'test.ts'), `import { flatten } from './flatten'
const r1 = flatten([1, [2, [3, [4]]]], 1)
const r2 = flatten([1, [2, [3, [4]]]], 2)
const r3 = flatten([1, [2, [3, [4]]]])
const pass = JSON.stringify(r1) === '[1,2,[3,[4]]]' && JSON.stringify(r2) === '[1,2,3,[4]]' && JSON.stringify(r3) === '[1,2,3,4]'
console.log(JSON.stringify({ r1, r2, r3, pass }))`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        return { resolved: !!out.pass, reason: `r1=${JSON.stringify(out.r1)} r2=${JSON.stringify(out.r2)}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P2-007', phase: 2, category: 'security', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'jwt.ts'), `export function parseJWT(token: string): any {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT')
  // Bug: doesn't verify signature, and doesn't handle base64url padding
  const payload = Buffer.from(parts[1], 'base64').toString()
  return JSON.parse(payload)
}`)
      writeFileSync(join(d, 'test.ts'), `import { parseJWT } from './jwt'
// Standard base64url encoded JWT payload (no padding issues)
const r1 = parseJWT('header.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9.sig')
const nameOk = r1.name === 'John'
// base64url without padding (has - and _ chars)
const r2 = parseJWT('header.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9.sig')
const pass = r1.sub === '1234567890' && nameOk
console.log(JSON.stringify({ sub: r1.sub, name: r1.name, pass }))`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        return { resolved: !!out.pass, reason: `sub=${out.sub} name=${out.name}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
  {
    id: 'P2-008', phase: 2, category: 'architecture', difficulty: 'hard',
    setup(d) {
      writeFileSync(join(d, 'middleware.ts'), `export class Middleware {
  private stack: any[] = []
  use(fn: (ctx: any, next: () => Promise<void>) => Promise<void>) { this.stack.push(fn) }
  async run(ctx: any): Promise<any> {
    // Bug: doesn't chain middleware properly, only runs the first one
    if (this.stack.length === 0) return ctx
    await this.stack[0](ctx, async () => {})
    return ctx
  }
}`)
      writeFileSync(join(d, 'test.ts'), `import { Middleware } from './middleware'
async function main() {
  const mw = new Middleware()
  const order: number[] = []
  mw.use(async (ctx, next) => { order.push(1); await next(); order.push(4) })
  mw.use(async (ctx, next) => { order.push(2); await next(); order.push(3) })
  const ctx = await mw.run({})
  const pass = order.length === 4 && order[0] === 1 && order[1] === 2 && order[2] === 3 && order[3] === 4
  console.log(JSON.stringify({ order, pass }))
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1) })`)
    },
    verify(d) {
      try {
        const out = JSON.parse(execSync(`bun run ${join(d, 'test.ts')} 2>&1`, { timeout: 5000 }).toString().trim())
        return { resolved: !!out.pass, reason: `order=${JSON.stringify(out.order)}` }
      } catch (e: any) { return { resolved: false, reason: e.message?.slice(0, 60) } }
    },
  },
]

const ALL_TASKS = [...PHASE1, ...PHASE2]

// ── Runner ───────────────────────────────────────────────────────────

function runTask(task: Task, config: 'solo' | 'advisor'): RunResult {
  const workDir = join('/tmp', `phase-${task.id}-${config}-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  task.setup(workDir)

  const prompt = `Fix the bug in the TypeScript file in ${workDir}/. The test file test.ts shows expected behavior.
Read the source file, understand the bug, fix it in-place, and ensure 'bun run ${workDir}/test.ts' passes.
Do NOT modify test.ts. Only edit the source file(s).`

  const envVars = { ...process.env as Record<string, string>,
    CLAUDE_CODE_ADVISOR_ENABLED: config === 'advisor' ? 'true' : '',
    CLAUDE_CODE_ADVISOR_MODEL: config === 'advisor' ? 'glm-5.1' : '',
    CC_HAHA_SKIP_DOTENV: '0',
  }

  const cmd = ['bash', './bin/claude-haha', '-p', prompt, '--model', 'glm-4.5-air', '--dangerously-skip-permissions', '--output-format', 'json', '--max-budget-usd', '0.5']

  const start = Date.now()
  let stdout = ''
  try {
    stdout = execSync(cmd.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(' '), {
      cwd: '/Users/jasonjcwu/Documents/GitHub/cc-haha', env: envVars,
      timeout: 180_000, maxBuffer: 1024 * 1024, encoding: 'utf-8',
    })
  } catch (e: any) { stdout = e.stdout ?? '' }
  const durationMs = Date.now() - start

  let costUsd = 0, inputTokens = 0, outputTokens = 0
  try { const d = JSON.parse(stdout); costUsd = d.total_cost_usd ?? 0; inputTokens = d.usage?.input_tokens ?? 0; outputTokens = d.usage?.output_tokens ?? 0 } catch {}

  const { resolved, reason } = task.verify(workDir)
  try { rmSync(workDir, { recursive: true }) } catch {}

  return { taskId: task.id, phase: task.phase, category: task.category, config, resolved, reason, durationMs, costUsd, inputTokens, outputTokens }
}

// ── Main ─────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(72))
console.log('  Phase 1 + 2 Advisor Eval')
console.log('  Phase 1: 7 基础题 (bug-fix / async / data-structure)')
console.log('  Phase 2: 8 强项题 (race / security / semantic / architecture)')
console.log(`  Total: ${ALL_TASKS.length} tasks × 2 configs = ${ALL_TASKS.length * 2} runs`)
console.log('═'.repeat(72))

const soloResults: RunResult[] = []
const advResults: RunResult[] = []

console.log('\n▶ haiku solo')
for (const task of ALL_TASKS) {
  process.stdout.write(`  [${task.id}] ${task.category.padEnd(16)} `.padEnd(38))
  const r = runTask(task, 'solo')
  soloResults.push(r)
  console.log(`${r.resolved ? '✅' : '❌'} ${r.reason.slice(0, 30)}  (${(r.durationMs / 1000).toFixed(1)}s)`)
}

console.log('\n▶ haiku + opus advisor')
for (const task of ALL_TASKS) {
  process.stdout.write(`  [${task.id}] ${task.category.padEnd(16)} `.padEnd(38))
  const r = runTask(task, 'advisor')
  advResults.push(r)
  console.log(`${r.resolved ? '✅' : '❌'} ${r.reason.slice(0, 30)}  (${(r.durationMs / 1000).toFixed(1)}s)`)
}

// ── Report ───────────────────────────────────────────────────────────

function bar(p: number, w = 12) { return '█'.repeat(Math.round(p * w)) + '░'.repeat(w - Math.round(p * w)) }

console.log('\n' + '═'.repeat(72))
console.log('  RESULTS')
console.log('═'.repeat(72))

for (const [phaseLabel, phaseNum] of [['Phase 1 (基础)', 1], ['Phase 2 (强项)', 2]]) {
  const s = soloResults.filter(r => r.phase === phaseNum)
  const a = advResults.filter(r => r.phase === phaseNum)
  const sp = s.filter(r => r.resolved).length / s.length * 100
  const ap = a.filter(r => r.resolved).length / a.length * 100
  console.log(`\n  ${phaseLabel}: solo ${sp.toFixed(0)}% → advisor ${ap.toFixed(0)}% (${ap >= sp ? '+' : ''}${(ap - sp).toFixed(0)}pp)`)
}

console.log('\n── Resolution Matrix ──\n')
console.log('Task         Category        Phase   solo  advisor')
console.log('─'.repeat(56))
for (let i = 0; i < ALL_TASKS.length; i++) {
  const s = soloResults[i], a = advResults[i]
  console.log(`${s.taskId}  ${s.category.padEnd(16)} P${s.phase}     ${s.resolved ? '✅' : '❌'}     ${a.resolved ? '✅' : '❌'}`)
}

const soloPct = soloResults.filter(r => r.resolved).length / soloResults.length
const advPct = advResults.filter(r => r.resolved).length / advResults.length
const soloCost = soloResults.reduce((s, r) => s + r.costUsd, 0)
const advCost = advResults.reduce((s, r) => s + r.costUsd, 0)

console.log('\n── Overall ──\n')
console.log(`  haiku solo:    ${(soloPct * 100).toFixed(0)}% resolved  ${bar(soloPct)}  $${soloCost.toFixed(2)} total`)
console.log(`  haiku+advisor: ${(advPct * 100).toFixed(0)}% resolved  ${bar(advPct)}  $${advCost.toFixed(2)} total`)
console.log(`  delta: ${((advPct - soloPct) * 100) >= 0 ? '+' : ''}${((advPct - soloPct) * 100).toFixed(0)}pp   cost: ${(advCost / soloCost).toFixed(1)}x`)

writeFileSync('question/bench/phase1-2-results.json', JSON.stringify({ solo: soloResults, advisor: advResults, timestamp: new Date().toISOString() }, null, 2))
console.log('\n  Saved: question/bench/phase1-2-results.json')
