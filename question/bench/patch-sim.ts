#!/usr/bin/env bun
/**
 * 轻量 Advisor 评测 — Patch Similarity
 *
 * 不跑 Docker、不 clone repo、不跑测试。
 * 只比对模型生成的 patch 跟 gold patch 的重叠度。
 *
 * 指标:
 *   - File Recall:    改对了几个文件 (gold 文件的覆盖率)
 *   - Line Precision: 改的行有多少在 gold 附近 (±3 行内)
 *   - Direction:      改的方向对不对 (add/delete/modify)
 *   - 综合分:         以上加权
 *
 * 用法:
 *   bun run question/bench/patch-sim.ts
 */

import { execSync } from 'child_process'
import { writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

// ── Parse unified diff ───────────────────────────────────────────────

interface FileEdit {
  file: string
  action: 'add' | 'delete' | 'modify'
  oldLines: Set<number>   // lines removed
  newLines: Set<number>   // lines added
}

function parsePatch(patch: string): FileEdit[] {
  const files: FileEdit[] = []
  const hunks = patch.split(/(?=^diff --git)/m).filter(Boolean)

  for (const hunk of hunks) {
    const fileMatch = hunk.match(/^[+-]{3} [ab]\/(.+)$/m) || hunk.match(/^diff --git a\/(.+?) b\//m)
    if (!fileMatch) continue
    const file = fileMatch[1]

    const oldLines = new Set<number>()
    const newLines = new Set<number>()
    let oldLine = 0, newLine = 0

    // is this a new file or deleted file?
    const isNew = hunk.includes('new file')
    const isDeleted = hunk.includes('deleted file')

    const hunkHeaders = hunk.matchAll(/@@@?(?: -(\d+)(?:,\d+)?)? \+(\d+)(?:,\d+)? @@@?/g)
    for (const m of hunkHeaders) {
      oldLine = parseInt(m[1] || '0')
      newLine = parseInt(m[2] || '0')
    }

    for (const line of hunk.split('\n')) {
      if (line.startsWith('@@@') || line.startsWith('@@')) {
        const hm = line.match(/@@@?(?: -(\d+)(?:,\d+)?)? \+(\d+)(?:,\d+)? @@@?/)
        if (hm) { oldLine = parseInt(hm[1] || '0'); newLine = parseInt(hm[2] || '0') }
        continue
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        oldLines.add(oldLine++)
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newLines.add(newLine++)
      } else if (line.startsWith(' ')) {
        oldLine++; newLine++
      }
    }

    files.push({
      file,
      action: isNew ? 'add' : isDeleted ? 'delete' : 'modify',
      oldLines,
      newLines,
    })
  }
  return files
}

function computeSimilarity(goldPatch: string, modelPatch: string): {
  fileRecall: number
  lineRecall: number
  linePrecision: number
  directionMatch: number
  score: number
} {
  const gold = parsePatch(goldPatch)
  const model = parsePatch(modelPatch)

  if (gold.length === 0) return { fileRecall: 0, lineRecall: 0, linePrecision: 0, directionMatch: 0, score: 0 }

  // 1. File recall: how many gold files did the model touch?
  const goldFiles = new Set(gold.map(f => f.file))
  const modelFiles = new Set(model.map(f => f.file))
  let fileHits = 0
  for (const f of goldFiles) {
    if (modelFiles.has(f)) fileHits++
  }
  const fileRecall = fileHits / goldFiles.size

  // 2. Line recall: gold lines covered by model (±3 tolerance)
  const TOLERANCE = 3
  let goldLineHits = 0
  let totalGoldLines = 0

  for (const gf of gold) {
    const mf = model.find(m => m.file === gf.file)
    const allModelLines = new Set([...(mf?.oldLines || []), ...(mf?.newLines || [])])

    const allGoldLines = new Set([...gf.oldLines, ...gf.newLines])
    totalGoldLines += allGoldLines.size

    for (const gl of allGoldLines) {
      for (let d = -TOLERANCE; d <= TOLERANCE; d++) {
        if (allModelLines.has(gl + d)) { goldLineHits++; break }
      }
    }
  }
  const lineRecall = totalGoldLines > 0 ? goldLineHits / totalGoldLines : 0

  // 3. Line precision: model lines that are near gold lines
  let modelLineHits = 0
  let totalModelLines = 0

  for (const mf of model) {
    const gf = gold.find(g => g.file === mf.file)
    if (!gf) { totalModelLines += mf.oldLines.size + mf.newLines.size; continue }

    const allGoldLines = new Set([...gf.oldLines, ...gf.newLines])
    const allModelLines = [...mf.oldLines, ...mf.newLines]
    totalModelLines += allModelLines.length

    for (const ml of allModelLines) {
      for (let d = -TOLERANCE; d <= TOLERANCE; d++) {
        if (allGoldLines.has(ml + d)) { modelLineHits++; break }
      }
    }
  }
  const linePrecision = totalModelLines > 0 ? modelLineHits / totalModelLines : 0

  // 4. Direction match
  let dirMatch = 0
  for (const gf of gold) {
    const mf = model.find(m => m.file === gf.file)
    if (mf && mf.action === gf.action) dirMatch++
  }
  const directionMatch = gold.length > 0 ? dirMatch / gold.length : 0

  const score = fileRecall * 0.35 + lineRecall * 0.30 + linePrecision * 0.20 + directionMatch * 0.15

  return { fileRecall, lineRecall, linePrecision, directionMatch, score }
}

// ── Run one task ─────────────────────────────────────────────────────

interface TaskResult {
  id: string
  config: string
  fileRecall: number
  lineRecall: number
  linePrecision: number
  score: number
  durationMs: number
  costUsd: number
  generatedPatch: string
}

function runTask(task: any, config: 'solo' | 'advisor'): TaskResult {
  const prompt = `You are given a GitHub issue from the repository ${task.repo}.
Your task is to generate a unified diff patch (git diff format) that fixes the issue.

ISSUE:
${task.problem_statement}

Requirements:
1. Output ONLY the patch in unified diff format (diff --git a/... b/...)
2. Include the correct file paths
3. Make minimal, targeted changes
4. Do NOT output any explanation, only the patch`

  const envVars: Record<string, string> = {
    ...process.env as Record<string, string>,
    CLAUDE_CODE_ADVISOR_ENABLED: config === 'advisor' ? 'true' : '',
    CLAUDE_CODE_ADVISOR_MODEL: config === 'advisor' ? 'glm-5.1' : '',
    CC_HAHA_SKIP_DOTENV: '0',
  }

  const cmd = [
    'bash', './bin/claude-haha',
    '-p', prompt,
    '--model', 'glm-4.5-air',
    '--dangerously-skip-permissions',
    '--output-format', 'json',
    '--max-budget-usd', '0.3',
  ]

  const start = Date.now()
  let stdout = ''
  try {
    stdout = execSync(cmd.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(' '), {
      cwd: '/Users/jasonjcwu/Documents/GitHub/cc-haha',
      env: envVars,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
    })
  } catch (e: any) {
    stdout = e.stdout ?? ''
  }

  const durationMs = Date.now() - start
  let costUsd = 0
  let resultText = ''
  try {
    const data = JSON.parse(stdout)
    costUsd = data.total_cost_usd ?? 0
    resultText = data.result ?? ''
  } catch {
    resultText = stdout
  }

  // Extract patch from model output
  const patchMatch = resultText.match(/diff --git[\s\S]*?(?=\n\n\n|\n```|$)/)
  const generatedPatch = patchMatch ? patchMatch[0] : ''

  const sim = computeSimilarity(task.patch, generatedPatch)

  return {
    id: task.instance_id,
    config,
    ...sim,
    durationMs,
    costUsd,
    generatedPatch,
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const tasks = JSON.parse(readFileSync('question/bench/swe-sampled.json', 'utf-8'))

console.log('\n' + '═'.repeat(70))
console.log('  PATCH SIMILARITY — Lightweight Advisor Eval')
console.log('  Worker: glm-4.5-air  |  Advisor: glm-5.1')
console.log('  No Docker, no clone, no tests — just patch overlap')
console.log('═'.repeat(70))
console.log(`\n  ${tasks.length} tasks × 2 configs = ${tasks.length * 2} runs\n`)

const soloResults: TaskResult[] = []
const advResults: TaskResult[] = []

// Phase 1: Solo
console.log('▶ haiku solo')
for (const task of tasks) {
  process.stdout.write(`  [${task.instance_id}] `.padEnd(42))
  const r = runTask(task, 'solo')
  soloResults.push(r)
  console.log(`score=${(r.score * 100).toFixed(0)}%  files=${(r.fileRecall * 100).toFixed(0)}%  lines=${(r.lineRecall * 100).toFixed(0)}%  (${(r.durationMs / 1000).toFixed(1)}s)`)
}

// Phase 2: Advisor
console.log('\n▶ haiku + opus advisor')
for (const task of tasks) {
  process.stdout.write(`  [${task.instance_id}] `.padEnd(42))
  const r = runTask(task, 'advisor')
  advResults.push(r)
  console.log(`score=${(r.score * 100).toFixed(0)}%  files=${(r.lineRecall * 100).toFixed(0)}%  lines=${(r.lineRecall * 100).toFixed(0)}%  (${(r.durationMs / 1000).toFixed(1)}s)`)
}

// ── Report ───────────────────────────────────────────────────────────

function bar(pct: number, w = 12) { return '█'.repeat(Math.round(pct * w)) + '░'.repeat(w - Math.round(pct * w)) }
function fmt$(n: number) { return n < 0.001 ? '<$0.001' : `$${n.toFixed(3)}` }

console.log('\n' + '═'.repeat(70))
console.log('  RESULTS')
console.log('═'.repeat(70))

console.log('\n── Per-Task Comparison ──\n')
console.log('Task                          │ solo score  │ advisor score │ Δ')
console.log('─'.repeat(75))

for (let i = 0; i < tasks.length; i++) {
  const s = soloResults[i], a = advResults[i]
  const delta = (a.score - s.score) * 100
  const sign = delta >= 0 ? '+' : ''
  console.log(
    `${s.id.padEnd(30)}│ ${(s.score * 100).toFixed(0)}% ${bar(s.score)} │ ${(a.score * 100).toFixed(0)}% ${bar(a.score)} │ ${sign}${delta.toFixed(0)}pp`
  )
}

// Summary
const avgSolo = soloResults.reduce((s, r) => s + r.score, 0) / soloResults.length
const avgAdv = advResults.reduce((s, r) => s + r.score, 0) / advResults.length
const avgSoloCost = soloResults.reduce((s, r) => s + r.costUsd, 0) / soloResults.length
const avgAdvCost = advResults.reduce((s, r) => s + r.costUsd, 0) / advResults.length

console.log('\n── Summary ──\n')
console.log(`  haiku solo:    avg score ${(avgSolo * 100).toFixed(1)}%  cost ${fmt$(avgSoloCost)}/task`)
console.log(`  haiku+advisor: avg score ${(avgAdv * 100).toFixed(1)}%  cost ${fmt$(avgAdvCost)}/task`)
console.log(`  delta: ${((avgAdv - avgSolo) * 100) >= 0 ? '+' : ''}${((avgAdv - avgSolo) * 100).toFixed(1)}pp  cost ratio ${(avgAdvCost / avgSoloCost).toFixed(1)}x`)

// Per-metric breakdown
console.log('\n── Metric Breakdown ──\n')
for (const [label, results] of [['solo', soloResults], ['advisor', advResults]] as const) {
  const fr = results.reduce((s, r) => s + r.fileRecall, 0) / results.length
  const lr = results.reduce((s, r) => s + r.lineRecall, 0) / results.length
  const lp = results.reduce((s, r) => s + r.linePrecision, 0) / results.length
  const dm = results.reduce((s, r) => s + r.directionMatch, 0) / results.length
  console.log(`  ${label}:`)
  console.log(`    file recall:    ${(fr * 100).toFixed(0)}%  ${bar(fr)}`)
  console.log(`    line recall:    ${(lr * 100).toFixed(0)}%  ${bar(lr)}`)
  console.log(`    line precision: ${(lp * 100).toFixed(0)}%  ${bar(lp)}`)
  console.log(`    direction:      ${(dm * 100).toFixed(0)}%  ${bar(dm)}`)
  console.log()
}

writeFileSync(
  'question/bench/patch-sim-results.json',
  JSON.stringify({ solo: soloResults, advisor: advResults, timestamp: new Date().toISOString() }, null, 2),
)
console.log('  Saved: question/bench/patch-sim-results.json')
