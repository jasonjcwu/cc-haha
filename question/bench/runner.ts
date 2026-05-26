#!/usr/bin/env bun
/**
 * Advisor Benchmark Runner
 *
 * Runs coding tasks through different worker × advisor model combinations,
 * collects outputs, and produces a comparison report.
 *
 * Usage:
 *   bun run question/bench/runner.ts
 *
 * Environment:
 *   ANTHROPIC_API_KEY  - required for Claude models
 *   OPENAI_API_KEY     - for GPT models
 *   DEEPSEEK_API_KEY   - for DeepSeek models
 *   GLM_API_KEY        - for GLM models
 */

import Anthropic from '@anthropic-ai/sdk'
import { TASKS, type BenchTask } from './tasks.js'

// ── Config ───────────────────────────────────────────────────────────

interface ModelConfig {
  id: string
  name: string
  provider: 'anthropic' | 'openai-compat'
  model: string
  baseUrl?: string
}

interface RunConfig {
  worker: ModelConfig
  advisor: ModelConfig | null // null = no advisor (baseline)
}

const MODELS: Record<string, ModelConfig> = {
  'haiku-4.5': {
    id: 'haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
  },
  'sonnet-4.6': {
    id: 'sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6-20250514',
  },
  'opus-4.7': {
    id: 'opus-4.7',
    name: 'Claude Opus 4.7',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  },
  'deepseek-v3': {
    id: 'deepseek-v3',
    name: 'DeepSeek V3',
    provider: 'openai-compat',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
  },
  'glm-4': {
    id: 'glm-4',
    name: 'GLM-4',
    provider: 'openai-compat',
    model: 'glm-4',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
}

// Test matrix: worker × advisor
const RUN_CONFIGS: RunConfig[] = [
  // Baseline: no advisor
  { worker: MODELS['haiku-4.5'], advisor: null },
  // Classic advisor combo
  { worker: MODELS['haiku-4.5'], advisor: MODELS['opus-4.7'] },
  // Budget advisor
  { worker: MODELS['haiku-4.5'], advisor: MODELS['deepseek-v3'] },
  // Domestic model
  { worker: MODELS['haiku-4.5'], advisor: MODELS['glm-4'] },
  // Mid-tier worker
  { worker: MODELS['sonnet-4.6'], advisor: null },
  { worker: MODELS['sonnet-4.6'], advisor: MODELS['opus-4.7'] },
]

// ── API Clients ──────────────────────────────────────────────────────

const anthropic = new Anthropic()

async function callAnthropic(
  model: string,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens = 4096,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: messages as Anthropic.MessageParam[],
  })
  const textBlock = response.content.find(b => b.type === 'text')
  return {
    text: textBlock?.type === 'text' ? textBlock.text : '',
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
}

async function callOpenAICompat(
  model: string,
  baseUrl: string,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens = 4096,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.GLM_API_KEY || process.env.OPENAI_API_KEY || ''
  const allMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...messages,
  ]

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: allMessages,
    }),
  })

  if (!response.ok) {
    throw new Error(`API error (${response.status}): ${await response.text()}`)
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>
    usage: { prompt_tokens: number; completion_tokens: number }
  }

  return {
    text: data.choices?.[0]?.message?.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  }
}

async function callModel(
  config: ModelConfig,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens?: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  if (config.provider === 'anthropic') {
    return callAnthropic(config.model, systemPrompt, messages, maxTokens)
  }
  return callOpenAICompat(config.model, config.baseUrl!, systemPrompt, messages, maxTokens)
}

// ── Advisor Flow ─────────────────────────────────────────────────────

const WORKER_SYSTEM = `You are a coding assistant. Write clean, correct TypeScript code. Be thorough but concise.`

const ADVISOR_SYSTEM = `You are an expert code reviewer. Review the worker's planned approach and provide specific, actionable advice. Focus on correctness, edge cases, and potential bugs. Be concise.`

async function runWithAdvisor(
  task: BenchTask,
  config: RunConfig,
): Promise<{
  taskId: string
  configId: string
  output: string
  advisorAdvice: string | null
  totalInputTokens: number
  totalOutputTokens: number
  latencyMs: number
}> {
  const start = Date.now()
  const configId = `${config.worker.id}${config.advisor ? `+${config.advisor.id}` : '-noadvisor'}`

  let totalInput = 0
  let totalOutput = 0
  let advisorAdvice: string | null = null

  // Step 1: Call advisor to get guidance (if configured)
  if (config.advisor) {
    const advisorResult = await callModel(
      config.advisor,
      ADVISOR_SYSTEM,
      [
        {
          role: 'user',
          content: `Review this coding task and provide guidance before the worker starts:\n\n${task.prompt}`,
        },
      ],
    )
    advisorAdvice = advisorResult.text
    totalInput += advisorResult.inputTokens
    totalOutput += advisorResult.outputTokens
  }

  // Step 2: Worker does the task (with or without advisor advice)
  const workerMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let workerPrompt = task.prompt
  if (advisorAdvice) {
    workerPrompt = `${task.prompt}\n\n---\nAdvisor guidance (from a stronger model):\n${advisorAdvice}\n---\nUse this guidance to produce a better result.`
  }

  workerMessages.push({ role: 'user', content: workerPrompt })

  const workerResult = await callModel(
    config.worker,
    WORKER_SYSTEM,
    workerMessages,
    8192,
  )
  totalInput += workerResult.inputTokens
  totalOutput += workerResult.outputTokens

  return {
    taskId: task.id,
    configId,
    output: workerResult.text,
    advisorAdvice,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    latencyMs: Date.now() - start,
  }
}

// ── Judge ────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are a code quality judge. Score the following code output on a 1-10 scale.

Evaluate based on:
1. Correctness — does it solve the stated problem?
2. Code quality — clean, well-typed TypeScript
3. Edge cases — handles error cases, boundary conditions
4. Completeness — test cases, documentation where appropriate

Output ONLY a JSON object: {"score": <1-10>, "reason": "<brief explanation>"}`

async function judgeOutput(
  task: BenchTask,
  output: string,
): Promise<{ score: number; reason: string }> {
  const result = await callAnthropic(
    'claude-haiku-4-5-20251001',
    JUDGE_SYSTEM,
    [
      {
        role: 'user',
        content: `Task: ${task.prompt}\n\nEvaluation criteria: ${task.evaluationCriteria}\n\nOutput to evaluate:\n${output}`,
      },
    ],
    1024,
  )

  try {
    // Extract JSON from response (may have markdown fencing)
    const jsonMatch = result.text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
  } catch {
    // fall through
  }
  return { score: 0, reason: 'Failed to parse judge output' }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const results: Array<{
    task: BenchTask
    config: RunConfig
    configId: string
    output: string
    advisorAdvice: string | null
    score: number
    scoreReason: string
    totalInputTokens: number
    totalOutputTokens: number
    latencyMs: number
  }> = []

  // Only use a subset of tasks for quick runs
  const tasksToRun = TASKS
  const configsToRun = RUN_CONFIGS

  console.log(`\n${'='.repeat(60)}`)
  console.log(`Advisor Benchmark`)
  console.log(`${tasksToRun.length} tasks × ${configsToRun.length} configs = ${tasksToRun.length * configsToRun.length} runs`)
  console.log(`${'='.repeat(60)}\n`)

  for (const config of configsToRun) {
    const configId = `${config.worker.id}${config.advisor ? `+${config.advisor.id}` : '-noadvisor'}`
    console.log(`\n--- Config: ${configId} ---`)

    for (const task of tasksToRun) {
      process.stdout.write(`  [${task.id}] ${task.category}/${task.difficulty}: `)

      try {
        const result = await runWithAdvisor(task, config)

        process.stdout.write(`(${result.latencyMs}ms, ${result.totalInputTokens + result.totalOutputTokens} tokens) judging... `)

        const judgeResult = await judgeOutput(task, result.output)

        results.push({
          task,
          config,
          configId,
          output: result.output,
          advisorAdvice: result.advisorAdvice,
          score: judgeResult.score,
          scoreReason: judgeResult.reason,
          totalInputTokens: result.totalInputTokens,
          totalOutputTokens: result.totalOutputTokens,
          latencyMs: result.latencyMs,
        })

        console.log(`score: ${judgeResult.score}/10`)
      } catch (error: any) {
        console.log(`ERROR: ${error.message}`)
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(60)}`)
  console.log(`RESULTS SUMMARY`)
  console.log(`${'='.repeat(60)}\n`)

  // Group by config
  const grouped = new Map<string, typeof results>()
  for (const r of results) {
    const existing = grouped.get(r.configId) ?? []
    existing.push(r)
    grouped.set(r.configId, existing)
  }

  console.log('| Config | Avg Score | Avg Latency | Total Tokens |')
  console.log('|--------|-----------|-------------|-------------|')
  for (const [configId, runs] of grouped) {
    const avgScore = runs.reduce((s, r) => s + r.score, 0) / runs.length
    const avgLatency = runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length
    const totalTokens = runs.reduce((s, r) => s + r.totalInputTokens + r.totalOutputTokens, 0)
    console.log(`| ${configId.padEnd(25)} | ${(avgScore).toFixed(1).padStart(9)} | ${Math.round(avgLatency).toString().padStart(9)}ms | ${totalTokens.toString().padStart(11)} |`)
  }

  // Per-task comparison
  console.log(`\nPer-task scores:`)
  console.log(`${''.padEnd(12)}| ${[...grouped.keys()].map(k => k.padEnd(10)).join(' | ')}`)
  console.log(`${'-'.repeat(12)}|${'-'.repeat(12).repeat(grouped.size)}`)
  for (const task of tasksToRun) {
    const scores = [...grouped.keys()].map(configId => {
      const run = results.find(r => r.task.id === task.id && r.configId === configId)
      return run ? `${run.score}`.padEnd(10) : 'N/A'.padEnd(10)
    })
    console.log(`${task.id.padEnd(12)}| ${scores.join(' | ')}`)
  }

  // Write detailed JSON results
  const fs = await import('fs')
  const path = await import('path')
  const outputPath = path.join(import.meta.dir, 'results.json')
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2))
  console.log(`\nDetailed results saved to: ${outputPath}`)
}

main().catch(console.error)
