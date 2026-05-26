#!/usr/bin/env bun
/**
 * LLM-as-Judge Advisor Evaluation
 *
 * 设计: 生成和评分分离
 *   --generate   生成 solo + advisor 输出 (慢, ~15min, 只需跑一次)
 *   --judge      重新评分 (快, ~1min, 可反复迭代 rubric)
 *   (default)    跑全流程
 *
 * 评分用温度0 + 结构化 JSON rubric → 确定性
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const ARTIFACTS_DIR = join(import.meta.dir, 'artifacts')
const TASKS_FILE = join(import.meta.dir, 'judge-tasks', 'tasks.json')
const RUBRIC_FILE = join(import.meta.dir, 'rubric.json')

// ── Types ────────────────────────────────────────────────────────────

interface Task {
  id: string
  source: string
  difficulty: string
  repo: string
  issue: string
  gold_summary: string
}

interface Rubric {
  version: number
  dimensions: Array<{
    id: string
    question: string
    type: 'binary' | 'score'
    weight: number
  }>
  judge_prompt: string
}

interface GeneratedOutput {
  taskId: string
  config: string
  output: string
  durationMs: number
  costUsd: number
  timestamp: string
}

interface JudgeScore {
  id: string
  type: 'binary' | 'score'
  value: boolean | number
}

interface JudgeResult {
  taskId: string
  config: string
  scores: JudgeScore[]
  weightedScore: number
  rawJson: string
}

interface EvalRun {
  tasks: Task[]
  rubric: Rubric
  solo: GeneratedOutput[]
  advisor: GeneratedOutput[]
  soloJudge: JudgeResult[]
  advisorJudge: JudgeResult[]
  timestamp: string
}

// ── Generate: run agent and capture output ───────────────────────────

function generateOutput(task: Task, config: 'solo' | 'advisor'): GeneratedOutput {
  const prompt = `You are a senior developer. Analyze this GitHub issue and propose a fix.

Repository: ${task.repo}
Issue: ${task.issue}

Provide:
1. Root cause analysis — what exactly is broken and why
2. Files that need to change (with specific paths)
3. Proposed fix — describe the exact changes (what to add/remove/modify)
4. Edge cases to consider
5. Any risks or side effects of the fix

Be specific. Reference exact function names, line logic, and method signatures.`

  const envVars = {
    ...process.env as Record<string, string>,
    CLAUDE_CODE_ADVISOR_ENABLED: config === 'advisor' ? 'true' : '',
    CLAUDE_CODE_ADVISOR_MODEL: config === 'advisor' ? 'glm-5.1' : '',
    CC_HAHA_SKIP_DOTENV: '0',
  }

  const cmd = ['bash', './bin/claude-haha', '-p', prompt, '--model', 'glm-4.5-air',
    '--dangerously-skip-permissions', '--output-format', 'json', '--max-budget-usd', '0.3']

  const start = Date.now()
  let stdout = ''
  try {
    stdout = execSync(cmd.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(' '), {
      cwd: '/Users/jasonjcwu/Documents/GitHub/cc-haha',
      env: envVars, timeout: 120_000, maxBuffer: 1024 * 1024, encoding: 'utf-8',
    })
  } catch (e: any) { stdout = e.stdout ?? '' }

  let output = '', costUsd = 0
  try {
    const d = JSON.parse(stdout)
    output = d.result ?? ''
    costUsd = d.total_cost_usd ?? 0
  } catch { output = stdout }

  return { taskId: task.id, config, output, durationMs: Date.now() - start, costUsd, timestamp: new Date().toISOString() }
}

// ── Judge: structured rubric scoring ─────────────────────────────────

function judgeOutput(task: Task, output: GeneratedOutput, rubric: Rubric): JudgeResult {
  const dimensions = rubric.dimensions
  const scoreSchema = {
    type: 'object',
    properties: Object.fromEntries(dimensions.map(d => [
      d.id, d.type === 'binary' ? { type: 'boolean' } : { type: 'number', minimum: 0, maximum: 10 }
    ])),
    required: dimensions.map(d => d.id),
    additionalProperties: false,
  }

  const judgePrompt = `${rubric.judge_prompt}

ISSUE (from ${task.repo}):
${task.issue}

SOLUTION TO EVALUATE:
${output.output}

GOLD STANDARD SUMMARY (for reference only — do not share with the solution):
${task.gold_summary}

Evaluate the solution against each dimension. Output a JSON object with these keys:
${dimensions.map(d => `- "${d.id}": ${d.type === 'binary' ? 'true/false' : '0-10'} — ${d.question}`).join('\n')}

Output ONLY the JSON object, nothing else.`

  // Use the CLI as judge with structured output
  const cmd = ['bash', './bin/claude-haha', '-p', judgePrompt, '--model', 'glm-5.1',
    '--dangerously-skip-permissions', '--output-format', 'json', '--max-budget-usd', '0.05',
    '--json-schema', JSON.stringify(scoreSchema)]

  let stdout = ''
  try {
    stdout = execSync(cmd.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(' '), {
      cwd: '/Users/jasonjcwu/Documents/GitHub/cc-haha',
      env: process.env as Record<string, string>,
      timeout: 60_000, maxBuffer: 512 * 1024, encoding: 'utf-8',
    })
  } catch (e: any) { stdout = e.stdout ?? '' }

  let rawJson = ''
  let parsed: Record<string, any> = {}
  try {
    const d = JSON.parse(stdout)
    rawJson = d.result ?? ''
    // Try to parse the JSON from the result
    const jsonMatch = rawJson.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
  } catch { /* fall through with empty parsed */ }

  const scores: JudgeScore[] = dimensions.map(d => ({
    id: d.id,
    type: d.type,
    value: d.type === 'binary' ? !!parsed[d.id] : Math.min(10, Math.max(0, Number(parsed[d.id]) || 0)),
  }))

  const weightedScore = scores.reduce((sum, s) => {
    const dim = dimensions.find(d => d.id === s.id)!
    const normalized = s.type === 'binary' ? (s.value ? 10 : 0) : (s.value as number)
    return sum + normalized * dim.weight
  }, 0) / dimensions.reduce((sum, d) => sum + d.weight, 0)

  return { taskId: task.id, config: output.config, scores, weightedScore, rawJson }
}

// ── Report ───────────────────────────────────────────────────────────

function printReport(tasks: Task[], rubric: Rubric, solo: GeneratedOutput[], advisor: GeneratedOutput[],
  soloJudge: JudgeResult[], advisorJudge: JudgeResult[]) {
  const bar = (p: number, w = 10) => '█'.repeat(Math.round(p * w / 10)) + '░'.repeat(w - Math.round(p * w / 10))

  console.log('\n' + '═'.repeat(72))
  console.log('  LLM-as-Judge Advisor Evaluation')
  console.log('  Worker: glm-4.5-air  |  Advisor: glm-5.1  |  Judge: glm-5.1')
  console.log('═'.repeat(72))

  // Per-task comparison
  console.log('\n── Per-Task Scores ──\n')

  const header = 'Task'.padEnd(22) + '│ solo    │ advisor │ Δ'
  console.log(header)
  console.log('─'.repeat(header.length))

  for (const task of tasks) {
    const sj = soloJudge.find(j => j.taskId === task.id)
    const aj = advisorJudge.find(j => j.taskId === task.id)
    const s = sj ? sj.weightedScore.toFixed(1) : '?'
    const a = aj ? aj.weightedScore.toFixed(1) : '?'
    const delta = sj && aj ? (aj.weightedScore - sj.weightedScore).toFixed(1) : '?'
    const sign = delta !== '?' && parseFloat(delta) >= 0 ? '+' : ''
    console.log(`${task.id.padEnd(22)}│ ${s.padStart(6)}  │ ${a.padStart(6)}  │ ${sign}${delta}`)
  }

  // Averages
  const avgSolo = soloJudge.reduce((s, j) => s + j.weightedScore, 0) / soloJudge.length
  const avgAdv = advisorJudge.reduce((s, j) => s + j.weightedScore, 0) / advisorJudge.length
  const delta = avgAdv - avgSolo
  const sign = delta >= 0 ? '+' : ''

  console.log('─'.repeat(header.length))
  console.log(`${'AVERAGE'.padEnd(22)}│ ${avgSolo.toFixed(1).padStart(6)}  │ ${avgAdv.toFixed(1).padStart(6)}  │ ${sign}${delta.toFixed(1)}`)

  // Per-dimension breakdown
  console.log('\n── Per-Dimension Breakdown ──\n')

  for (const dim of rubric.dimensions) {
    const soloAvg = soloJudge.reduce((s, j) => {
      const sc = j.scores.find(sc => sc.id === dim.id)
      return s + (sc?.type === 'binary' ? (sc.value ? 10 : 0) : (sc?.value as number ?? 0))
    }, 0) / soloJudge.length
    const advAvg = advisorJudge.reduce((s, j) => {
      const sc = j.scores.find(sc => sc.id === dim.id)
      return s + (sc?.type === 'binary' ? (sc.value ? 10 : 0) : (sc?.value as number ?? 0))
    }, 0) / advisorJudge.length
    const d = advAvg - soloAvg
    const s = d >= 0 ? '+' : ''
    const dimLabel = `${dim.id} (${dim.type})`.padEnd(24)
    console.log(`  ${dimLabel} solo=${soloAvg.toFixed(1).padStart(4)} ${bar(soloAvg)}  adv=${advAvg.toFixed(1).padStart(4)} ${bar(advAvg)}  ${s}${d.toFixed(1)}`)
  }

  // Win/Loss/Tie
  let wins = 0, losses = 0, ties = 0
  for (const task of tasks) {
    const sj = soloJudge.find(j => j.taskId === task.id)
    const aj = advisorJudge.find(j => j.taskId === task.id)
    if (sj && aj) {
      if (aj.weightedScore > sj.weightedScore + 0.5) wins++
      else if (aj.weightedScore < sj.weightedScore - 0.5) losses++
      else ties++
    }
  }
  console.log(`\n  Win/Loss/Tie: ${wins}W / ${losses}L / ${ties}T`)

  // Cost
  const soloCost = solo.reduce((s, o) => s + o.costUsd, 0)
  const advCost = advisor.reduce((s, o) => s + o.costUsd, 0)
  console.log(`  Cost: solo $${soloCost.toFixed(2)} / advisor $${advCost.toFixed(2)} (${(advCost / soloCost).toFixed(1)}x)`)

  // Summary
  console.log('\n── Summary ──\n')
  console.log(`  solo avg:    ${avgSolo.toFixed(1)}/10  ${bar(avgSolo)}`)
  console.log(`  advisor avg: ${avgAdv.toFixed(1)}/10  ${bar(advAdv)}`)
  console.log(`  delta: ${sign}${delta.toFixed(1)} points (${(delta / avgSolo * 100).toFixed(0)}%)`)
  console.log()
  if (delta > 1) console.log('  → Advisor provides meaningful improvement')
  else if (delta > 0) console.log('  → Advisor provides marginal improvement — consider harder tasks')
  else console.log('  → No improvement detected — investigate task difficulty or rubric')
}

// ── Main ─────────────────────────────────────────────────────────────

const tasks: Task[] = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'))
const rubric: Rubric = JSON.parse(readFileSync(RUBRIC_FILE, 'utf-8'))

const mode = process.argv[2] ?? 'all'
const generateOnly = mode === '--generate'
const judgeOnly = mode === '--judge'

mkdirSync(ARTIFACTS_DIR, { recursive: true })

let solo: GeneratedOutput[] = []
let advisor: GeneratedOutput[] = []

// ── Generate phase ───────────────────────────────────────────────────

if (!judgeOnly) {
  console.log('\n' + '═'.repeat(60))
  console.log('  Phase 1: Generate Outputs')
  console.log(`  ${tasks.length} tasks × 2 configs`)
  console.log('═'.repeat(60))

  console.log('\n▶ haiku solo')
  for (const task of tasks) {
    process.stdout.write(`  [${task.id}] `.padEnd(28))
    const out = generateOutput(task, 'solo')
    solo.push(out)
    writeFileSync(join(ARTIFACTS_DIR, `${task.id}-solo.json`), JSON.stringify(out, null, 2))
    console.log(`${(out.durationMs / 1000).toFixed(1)}s  $${out.costUsd.toFixed(3)}  ${out.output.slice(0, 40)}...`)
  }

  console.log('\n▶ haiku + opus advisor')
  for (const task of tasks) {
    process.stdout.write(`  [${task.id}] `.padEnd(28))
    const out = generateOutput(task, 'advisor')
    advisor.push(out)
    writeFileSync(join(ARTIFACTS_DIR, `${task.id}-advisor.json`), JSON.stringify(out, null, 2))
    console.log(`${(out.durationMs / 1000).toFixed(1)}s  $${out.costUsd.toFixed(3)}  ${out.output.slice(0, 40)}...`)
  }

  if (generateOnly) {
    console.log('\n  Outputs saved to question/bench/artifacts/')
    console.log('  Run with --judge to score them')
    process.exit(0)
  }
} else {
  // Load pre-generated outputs
  console.log('\n  Loading pre-generated outputs...')
  for (const task of tasks) {
    const soloFile = join(ARTIFACTS_DIR, `${task.id}-solo.json`)
    const advFile = join(ARTIFACTS_DIR, `${task.id}-advisor.json`)
    if (existsSync(soloFile)) solo.push(JSON.parse(readFileSync(soloFile, 'utf-8')))
    if (existsSync(advFile)) advisor.push(JSON.parse(readFileSync(advFile, 'utf-8')))
  }
  console.log(`  Loaded ${solo.length} solo + ${advisor.length} advisor outputs`)
}

// ── Judge phase ──────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60))
console.log('  Phase 2: LLM Judge Scoring')
console.log(`  Rubric v${rubric.version}: ${rubric.dimensions.length} dimensions`)
console.log('═'.repeat(60))

const soloJudge: JudgeResult[] = []
const advisorJudge: JudgeResult[] = []

console.log('\n▶ Judging solo outputs')
for (const out of solo) {
  process.stdout.write(`  [${out.taskId}] `.padEnd(28))
  const result = judgeOutput(tasks.find(t => t.id === out.taskId)!, out, rubric)
  soloJudge.push(result)
  writeFileSync(join(ARTIFACTS_DIR, `${out.taskId}-solo-judge.json`), JSON.stringify(result, null, 2))
  const dimSummary = result.scores.map(s => `${s.id}=${s.type === 'binary' ? s.value : (s.value as number).toFixed(0)}`).join(' ')
  console.log(`avg=${result.weightedScore.toFixed(1)}  ${dimSummary}`)
}

console.log('\n▶ Judging advisor outputs')
for (const out of advisor) {
  process.stdout.write(`  [${out.taskId}] `.padEnd(28))
  const result = judgeOutput(tasks.find(t => t.id === out.taskId)!, out, rubric)
  advisorJudge.push(result)
  writeFileSync(join(ARTIFACTS_DIR, `${out.taskId}-advisor-judge.json`), JSON.stringify(result, null, 2))
  const dimSummary = result.scores.map(s => `${s.id}=${s.type === 'binary' ? s.value : (s.value as number).toFixed(0)}`).join(' ')
  console.log(`avg=${result.weightedScore.toFixed(1)}  ${dimSummary}`)
}

// ── Report ───────────────────────────────────────────────────────────

printReport(tasks, rubric, solo, advisor, soloJudge, advisorJudge)

// Save full run
const run: EvalRun = { tasks, rubric, solo, advisor, soloJudge, advisorJudge, timestamp: new Date().toISOString() }
writeFileSync(join(ARTIFACTS_DIR, 'eval-run.json'), JSON.stringify(run, null, 2))
console.log('\n  Full run saved: question/bench/artifacts/eval-run.json')
