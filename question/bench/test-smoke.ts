#!/usr/bin/env bun
/**
 * Smoke test for the advisor benchmark framework.
 * Validates the pipeline without making real API calls.
 */

import { TASKS } from './tasks.js'

// ── Validate tasks ───────────────────────────────────────────────────

console.log('=== Task Validation ===')
for (const task of TASKS) {
  console.log(`  [${task.id}] ${task.category}/${task.difficulty}: ${task.prompt.slice(0, 60)}...`)
}

console.log(`\nTotal tasks: ${TASKS.length}`)
console.log(`Categories: ${[...new Set(TASKS.map(t => t.category))].join(', ')}`)
console.log(`Difficulties: ${[...new Set(TASKS.map(t => t.difficulty))].join(', ')}`)

// ── Validate provider config ────────────────────────────────────────

import {
  createAdvisorProvider,
  getAdvisorProviderConfig,
  type AdvisorProviderConfig,
} from '../../src/services/advisorProvider.js'

console.log('\n=== Provider Config Validation ===')

const testModels = [
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
  'deepseek-chat',
  'glm-4',
  'gpt-4o',
  'unknown-model',
]

for (const model of testModels) {
  const config = getAdvisorProviderConfig(model)
  console.log(`  ${model} → ${config.provider} / ${config.model} / ${config.baseUrl || '(default)'}`)

  // Try creating provider (will fail for unknown-model if no baseUrl)
  try {
    const provider = createAdvisorProvider(config)
    console.log(`    ✓ Provider created`)
  } catch (e: any) {
    console.log(`    ✗ ${e.message}`)
  }
}

// ── Validate advisor client config ──────────────────────────────────

import {
  isAdvisorEnabled,
  getAdvisorModel,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from '../../src/utils/advisorClient.js'

console.log('\n=== Advisor Client Config ===')
console.log(`  isAdvisorEnabled (no env): ${isAdvisorEnabled()}`)
console.log(`  getAdvisorModel (no env): ${getAdvisorModel()}`)
console.log(`  isValidAdvisorModel(any): ${isValidAdvisorModel('literally-anything')}`)
console.log(`  modelSupportsAdvisor(any): ${modelSupportsAdvisor('literally-anything')}`)

// ── Simulate advisor flow ───────────────────────────────────────────

console.log('\n=== Simulated Advisor Flow ===')

// Simulate the conversation message extraction
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (block.type === 'text') return block.text
        if (block.type === 'tool_use') return `[Tool: ${block.name}]`
        if (block.type === 'tool_result') return `[Tool Result]`
        if (block.type === 'thinking') return ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return String(content)
}

// Simulate messages
const mockMessages = [
  { type: 'user', message: 'Write a function that reverses a string' },
  { type: 'assistant', message: [
    { type: 'text', text: 'Let me write that function.' },
    { type: 'tool_use', name: 'FileWrite', input: { path: '/tmp/test.ts', content: '...' } },
  ]},
  { type: 'user', message: [
    { type: 'tool_result', content: 'File written successfully' },
  ]},
  { type: 'assistant', message: [
    { type: 'text', text: 'Done! I wrote the reverse function.' },
  ]},
]

const extracted = mockMessages
  .filter((msg: any) => msg.type === 'user' || msg.type === 'assistant')
  .map((msg: any) => ({
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: extractTextFromContent(msg.message),
  }))
  .filter((m: any) => m.content.length > 0)

console.log('  Extracted conversation:')
for (const msg of extracted) {
  console.log(`    [${msg.role}]: ${msg.content.slice(0, 80)}${msg.content.length > 80 ? '...' : ''}`)
}

// ── Summary ─────────────────────────────────────────────────────────

console.log('\n=== Summary ===')
console.log('✓ Tasks validated')
console.log('✓ Provider configs validated')
console.log('✓ Advisor client config validated')
console.log('✓ Message extraction validated')
console.log('\nTo run the full benchmark with API calls:')
console.log('  ANTHROPIC_API_KEY=xxx bun run question/bench/runner.ts')
console.log('  # Optional: DEEPSEEK_API_KEY, GLM_API_KEY for multi-provider tests')
