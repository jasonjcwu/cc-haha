#!/usr/bin/env bun
/**
 * Eval V2: LLM-as-Judge Advisor Evaluation
 *
 * Generation: full mode (advisor tool needs non-bare for tool registration)
 * Judge: --bare mode (no tools needed, 4x cheaper)
 * Three modes:
 *   --generate   Generate solo + advisor outputs (slow, ~5min)
 *   --judge      Re-score existing outputs (fast, ~1min)
 *   (default)    Full pipeline
 *
 * Worker: glm-4.5-air | Advisor: glm-5.1 | Judge: glm-5.1
 * Budget: ~$2.70 for 5 tasks
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const ARTIFACTS_DIR = join(import.meta.dir, 'artifacts-v2')
const TASKS_FILE = join(import.meta.dir, 'eval-v2-tasks.json')
const RUBRIC_FILE = join(import.meta.dir, 'eval-v2-rubric.json')
const CLI = join(import.meta.dir, '..', '..', 'bin', 'claude-haha')
const CWD = join(import.meta.dir, '..', '..')

const WORKER_MODEL = 'glm-4.5-air'
const ADVISOR_MODEL = 'glm-5.1'
const JUDGE_MODEL = 'glm-5.1'
const MAX_BUDGET = '0.50'
const SYSTEM_PROMPT = 'You are a senior developer. Analyze code carefully and provide specific, actionable answers with code references.'

// ── Types ────────────────────────────────────────────────────────────

interface Task {
  id: string
  category: string
  difficulty: string
  code: string
  question: string
  gold_answer: string
}

interface RubricDimension {
  id: string
  question: string
  type: 'score'
  weight: number
  scoring: string
}

interface Rubric {
  version: number
  dimensions: RubricDimension[]
  judge_instructions: string
}

interface GeneratedOutput {
  taskId: string
  config: 'solo' | 'advisor'
  output: string
  numTurns: number
  advisorCalled: boolean
  durationMs: number
  costUsd: number
  modelUsage: Record<string, any>
  timestamp: string
}

interface JudgeScores {
  root_cause: number
  fix_correct: number
  edge_cases: number
  specificity: number
}

interface JudgeResult {
  taskId: string
  config: 'solo' | 'advisor'
  scores: JudgeScores
  weightedScore: number
  rawResponse: string
  parsedOk: boolean
}

// ── Generate: run CLI and capture output ─────────────────────────────

// Full mode: advisor tool is registered (needs non-bare)
// Bare mode: no tools, cheaper (for judge)
function runCLI(prompt: string, env: Record<string, string> = {}, bare = false): {
  output: string
  costUsd: number
  durationMs: number
  numTurns: number
  modelUsage: Record<string, any>
} {
  const model = bare ? JUDGE_MODEL : WORKER_MODEL
  const cmd = [
    CLI,
    '-p', prompt,
    '--model', model,
    ...(bare ? ['--bare', '--system-prompt', SYSTEM_PROMPT] : []),
    '--output-format', 'json',
    '--max-budget-usd', MAX_BUDGET,
    '--dangerously-skip-permissions',
  ]

  const start = Date.now()
  let stdout = ''
  try {
    stdout = execSync(
      cmd.map(c => `'${c.replace(/'/g, "'\\''")}'`).join(' '),
      {
        cwd: CWD,
        env: { ...process.env as Record<string, string>, ...env },
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8',
      },
    )
  } catch (e: any) {
    stdout = e.stdout ?? ''
  }

  let output = ''
  let costUsd = 0
  let numTurns = 1
  let modelUsage: Record<string, any> = {}
  try {
    const d = JSON.parse(stdout)
    output = (d.result ?? '').trim()
    costUsd = d.total_cost_usd ?? 0
    numTurns = d.num_turns ?? 1
    modelUsage = d.modelUsage ?? {}
  } catch {
    output = stdout.trim()
  }

  return { output, costUsd, durationMs: Date.now() - start, numTurns, modelUsage }
}

function generateOutput(task: Task, config: 'solo' | 'advisor'): GeneratedOutput {
  const advisorPrefix = config === 'advisor'
    ? "First, call the advisor tool to get expert guidance on this problem. Then provide your answer.\n\n"
    : ''

  const prompt = `${advisorPrefix}${task.code}

---

${task.question}`

  const env: Record<string, string> = {}
  if (config === 'advisor') {
    env.CLAUDE_CODE_ADVISOR_ENABLED = 'true'
    env.CLAUDE_CODE_ADVISOR_MODEL = ADVISOR_MODEL
  }

  const { output, costUsd, durationMs, numTurns, modelUsage } = runCLI(prompt, env)
  // Advisor detection: num_turns > 1 means the model used a tool (advisor)
  // Also check for advisor references in the final output
  const advisorCalled = numTurns > 1 || output.toLowerCase().includes('advisor')

  return {
    taskId: task.id,
    config,
    output,
    numTurns,
    advisorCalled,
    durationMs,
    costUsd,
    modelUsage,
    timestamp: new Date().toISOString(),
  }
}

// ── Judge: structured scoring ────────────────────────────────────────

function parseScores(raw: string, dimensions: RubricDimension[]): { scores: JudgeScores; parsedOk: boolean } {
  // Try JSON parse first
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      const scores: any = {}
      let allValid = true
      for (const dim of dimensions) {
        const v = Number(parsed[dim.id])
        if (isNaN(v)) { allValid = false; scores[dim.id] = 0 }
        else { scores[dim.id] = Math.min(10, Math.max(0, v)) }
      }
      return { scores: scores as JudgeScores, parsedOk: allValid }
    } catch { /* fall through */ }
  }

  // Fallback: regex for each dimension
  const scores: any = {}
  let anyFound = false
  for (const dim of dimensions) {
    const re = new RegExp(`${dim.id}[^0-9]*([0-9]+)`, 'i')
    const m = raw.match(re)
    if (m) {
      scores[dim.id] = Math.min(10, Math.max(0, parseInt(m[1])))
      anyFound = true
    } else {
      scores[dim.id] = 0
    }
  }
  return { scores: scores as JudgeScores, parsedOk: anyFound }
}

function judgeOutput(task: Task, output: GeneratedOutput, rubric: Rubric): JudgeResult {
  const dimLines = rubric.dimensions
    .map(d => `"${d.id}": score 0-10 — ${d.question}. Scoring guide: ${d.scoring}`)
    .join('\n')

  const prompt = `${rubric.judge_instructions}

QUESTION ASKED:
${task.question}

CODE PROVIDED:
${task.code}

SOLUTION TO EVALUATE:
${output.output}

GOLD REFERENCE (for calibration — do not require exact match):
${task.gold_answer}

Score the solution on each dimension. Output a JSON object with exactly these keys and integer scores 0-10:
${dimLines}

Output ONLY the JSON object.`

  const { output: rawResponse } = runCLI(prompt, {}, true /* bare mode for judge */)
  const { scores, parsedOk } = parseScores(rawResponse, rubric.dimensions)

  const weightedScore = rubric.dimensions.reduce((sum, dim) => {
    return sum + (scores as any)[dim.id] * dim.weight
  }, 0) / rubric.dimensions.reduce((sum, d) => sum + d.weight, 0)

  return {
    taskId: task.id,
    config: output.config,
    scores,
    weightedScore,
    rawResponse,
    parsedOk,
  }
}

// ── Report ───────────────────────────────────────────────────────────

function bar(v: number, w = 10) {
  const filled = Math.round(v * w / 10)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

function printReport(
  tasks: Task[],
  rubric: Rubric,
  solo: GeneratedOutput[],
  advisor: GeneratedOutput[],
  soloJudge: JudgeResult[],
  advisorJudge: JudgeResult[],
) {
  console.log('\n' + '═'.repeat(72))
  console.log('  Eval V2: LLM-as-Judge Advisor Evaluation')
  console.log(`  Worker: ${WORKER_MODEL}  |  Advisor: ${ADVISOR_MODEL}  |  Judge: ${JUDGE_MODEL}`)
  console.log('═'.repeat(72))

  // Advisor call stats
  const advisorCalled = advisor.filter(o => o.advisorCalled).length
  const avgAdvisorTurns = advisor.length > 0
    ? (advisor.reduce((s, o) => s + o.numTurns, 0) / advisor.length).toFixed(1)
    : 'N/A'
  const avgSoloTurns = solo.length > 0
    ? (solo.reduce((s, o) => s + o.numTurns, 0) / solo.length).toFixed(1)
    : 'N/A'
  console.log(`\n  Advisor tool called: ${advisorCalled}/${advisor.length} tasks`)
  console.log(`  Avg turns: solo=${avgSoloTurns} / advisor=${avgAdvisorTurns}`)

  // Per-task comparison
  console.log('\n── Per-Task Scores ──\n')

  const header = 'Task'.padEnd(28) + '│ solo    │ advisor │ Δ'
  console.log(header)
  console.log('─'.repeat(header.length))

  for (const task of tasks) {
    const sj = soloJudge.find(j => j.taskId === task.id)
    const aj = advisorJudge.find(j => j.taskId === task.id)
    const s = sj ? sj.weightedScore.toFixed(1) : '?'
    const a = aj ? aj.weightedScore.toFixed(1) : '?'
    const delta = sj && aj ? (aj.weightedScore - sj.weightedScore).toFixed(1) : '?'
    const sign = delta !== '?' && parseFloat(delta) >= 0 ? '+' : ''
    const advCall = advisor.find(o => o.taskId === task.id)?.advisorCalled ? ' *' : '  '
    console.log(`${(task.id + advCall).padEnd(28)}│ ${s.padStart(6)}  │ ${a.padStart(6)}  │ ${sign}${delta}`)
  }
  console.log('  (* = advisor tool was called)')

  // Averages
  if (soloJudge.length > 0 && advisorJudge.length > 0) {
    const avgSolo = soloJudge.reduce((s, j) => s + j.weightedScore, 0) / soloJudge.length
    const avgAdv = advisorJudge.reduce((s, j) => s + j.weightedScore, 0) / advisorJudge.length
    const delta = avgAdv - avgSolo
    const sign = delta >= 0 ? '+' : ''

    console.log('─'.repeat(header.length))
    console.log(`${'AVERAGE'.padEnd(28)}│ ${avgSolo.toFixed(1).padStart(6)}  │ ${avgAdv.toFixed(1).padStart(6)}  │ ${sign}${delta.toFixed(1)}`)

    // Per-dimension breakdown
    console.log('\n── Per-Dimension Breakdown ──\n')

    for (const dim of rubric.dimensions) {
      const soloAvg = soloJudge.reduce((s, j) => s + (j.scores as any)[dim.id], 0) / soloJudge.length
      const advAvg = advisorJudge.reduce((s, j) => s + (j.scores as any)[dim.id], 0) / advisorJudge.length
      const d = advAvg - soloAvg
      const s = d >= 0 ? '+' : ''
      console.log(`  ${dim.id.padEnd(14)} solo=${soloAvg.toFixed(1).padStart(4)} ${bar(soloAvg)}  adv=${advAvg.toFixed(1).padStart(4)} ${bar(advAvg)}  ${s}${d.toFixed(1)}`)
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
    const judgeCost = soloCost + advCost // approximate
    console.log(`  Cost: solo $${soloCost.toFixed(2)} / advisor $${advCost.toFixed(2)} (${(advCost / soloCost).toFixed(1)}x)`)

    // Summary
    console.log('\n── Summary ──\n')
    console.log(`  solo avg:    ${avgSolo.toFixed(1)}/10  ${bar(avgSolo)}`)
    console.log(`  advisor avg: ${avgAdv.toFixed(1)}/10  ${bar(avgAdv)}`)
    console.log(`  delta: ${sign}${delta.toFixed(1)} points (${(delta / avgSolo * 100).toFixed(0)}%)`)
    console.log()
    if (delta > 1.5) console.log('  → Advisor provides meaningful improvement')
    else if (delta > 0.5) console.log('  → Advisor provides moderate improvement')
    else if (delta > 0) console.log('  → Advisor provides marginal improvement — consider harder tasks')
    else console.log('  → No improvement detected — investigate task difficulty or advisor integration')
  }

  // Parse quality
  const parseOk = [...soloJudge, ...advisorJudge].filter(j => j.parsedOk).length
  const total = soloJudge.length + advisorJudge.length
  console.log(`\n  Judge parse success: ${parseOk}/${total}`)
}

// ── Main ─────────────────────────────────────────────────────────────

const tasks: Task[] = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'))
const rubric: Rubric = JSON.parse(readFileSync(RUBRIC_FILE, 'utf-8'))

const mode = process.argv[2] ?? ''
const generateOnly = mode === '--generate'
const judgeOnly = mode === '--judge'

mkdirSync(ARTIFACTS_DIR, { recursive: true })

let solo: GeneratedOutput[] = []
let advisor: GeneratedOutput[] = []

// ── Generate phase ───────────────────────────────────────────────────

if (!judgeOnly) {
  console.log('\n' + '═'.repeat(60))
  console.log('  Phase 1: Generate Outputs')
  console.log(`  ${tasks.length} tasks × 2 configs | worker=${WORKER_MODEL} advisor=${ADVISOR_MODEL}`)
  console.log('═'.repeat(60))

  console.log('\n▶ solo (no advisor)')
  for (const task of tasks) {
    process.stdout.write(`  [${task.id}] `.padEnd(32))
    const out = generateOutput(task, 'solo')
    solo.push(out)
    writeFileSync(join(ARTIFACTS_DIR, `${task.id}-solo.json`), JSON.stringify(out, null, 2))
    console.log(`${(out.durationMs / 1000).toFixed(1)}s  $${out.costUsd.toFixed(3)}  ${out.output.slice(0, 50).replace(/\n/g, ' ')}...`)
  }

  console.log('\n▶ advisor enabled')
  for (const task of tasks) {
    process.stdout.write(`  [${task.id}] `.padEnd(32))
    const out = generateOutput(task, 'advisor')
    advisor.push(out)
    writeFileSync(join(ARTIFACTS_DIR, `${task.id}-advisor.json`), JSON.stringify(out, null, 2))
    const callFlag = out.advisorCalled ? 'ADVISED' : 'NO-CALL'
    console.log(`${(out.durationMs / 1000).toFixed(1)}s  $${out.costUsd.toFixed(3)}  [${callFlag}]  ${out.output.slice(0, 40).replace(/\n/g, ' ')}...`)
  }

  if (generateOnly) {
    const totalCost = solo.reduce((s, o) => s + o.costUsd, 0) + advisor.reduce((s, o) => s + o.costUsd, 0)
    console.log(`\n  Generation done. Total cost: $${totalCost.toFixed(2)}`)
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

if (solo.length === 0 && advisor.length === 0) {
  console.error('\n  No outputs to judge. Run without --judge first, or with --generate.')
  process.exit(1)
}

console.log('\n' + '═'.repeat(60))
console.log('  Phase 2: LLM Judge Scoring')
console.log(`  Rubric v${rubric.version}: ${rubric.dimensions.length} dimensions | judge=${JUDGE_MODEL}`)
console.log('═'.repeat(60))

const soloJudge: JudgeResult[] = []
const advisorJudge: JudgeResult[] = []

if (solo.length > 0) {
  console.log('\n▶ Judging solo outputs')
  for (const out of solo) {
    process.stdout.write(`  [${out.taskId}] `.padEnd(32))
    const result = judgeOutput(tasks.find(t => t.id === out.taskId)!, out, rubric)
    soloJudge.push(result)
    writeFileSync(join(ARTIFACTS_DIR, `${out.taskId}-solo-judge.json`), JSON.stringify(result, null, 2))
    const dimSummary = rubric.dimensions.map(d => `${d.id}=${(result.scores as any)[d.id]}`).join(' ')
    console.log(`avg=${result.weightedScore.toFixed(1)}  ${dimSummary}  ${result.parsedOk ? '' : '(PARSE-FALLBACK)'}`)
  }
}

if (advisor.length > 0) {
  console.log('\n▶ Judging advisor outputs')
  for (const out of advisor) {
    process.stdout.write(`  [${out.taskId}] `.padEnd(32))
    const result = judgeOutput(tasks.find(t => t.id === out.taskId)!, out, rubric)
    advisorJudge.push(result)
    writeFileSync(join(ARTIFACTS_DIR, `${out.taskId}-advisor-judge.json`), JSON.stringify(result, null, 2))
    const dimSummary = rubric.dimensions.map(d => `${d.id}=${(result.scores as any)[d.id]}`).join(' ')
    console.log(`avg=${result.weightedScore.toFixed(1)}  ${dimSummary}  ${result.parsedOk ? '' : '(PARSE-FALLBACK)'}`)
  }
}

// ── Report ───────────────────────────────────────────────────────────

printReport(tasks, rubric, solo, advisor, soloJudge, advisorJudge)

// Save full run
const run = {
  tasks, rubric, solo, advisor, soloJudge, advisorJudge,
  timestamp: new Date().toISOString(),
  config: { worker: WORKER_MODEL, advisor: ADVISOR_MODEL, judge: JUDGE_MODEL },
}
writeFileSync(join(ARTIFACTS_DIR, 'eval-run.json'), JSON.stringify(run, null, 2))
console.log('\n  Full run saved: question/bench/artifacts-v2/eval-run.json')
