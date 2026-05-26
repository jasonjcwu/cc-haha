import { afterEach, describe, expect, test } from 'bun:test'
import {
  canUseAdvisorWithBaseModel,
  isAdvisorModelAllowed,
  usesClientSideAdvisorTool,
  usesServerSideAdvisorTool,
} from './advisor.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('advisor provider routing', () => {
  test('uses server-side advisor on first-party Anthropic API', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = ''
    process.env.CLAUDE_CODE_USE_VERTEX = ''
    process.env.CLAUDE_CODE_USE_FOUNDRY = ''
    process.env.CLAUDE_CODE_USE_AZURE_OPENAI = ''
    delete process.env.ANTHROPIC_BASE_URL

    expect(usesServerSideAdvisorTool()).toBe(true)
    expect(usesClientSideAdvisorTool()).toBe(false)
  })

  test('uses client-side advisor on third-party Anthropic-compatible base URL', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = ''
    process.env.CLAUDE_CODE_USE_VERTEX = ''
    process.env.CLAUDE_CODE_USE_FOUNDRY = ''
    process.env.CLAUDE_CODE_USE_AZURE_OPENAI = ''
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'

    expect(usesServerSideAdvisorTool()).toBe(false)
    expect(usesClientSideAdvisorTool()).toBe(true)
  })

  test('relaxes model checks for client-side advisor', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    expect(canUseAdvisorWithBaseModel('deepseek-chat')).toBe(true)
    expect(isAdvisorModelAllowed('deepseek-reasoner')).toBe(true)
  })

  test('keeps Anthropic model checks for server-side advisor', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(canUseAdvisorWithBaseModel('deepseek-chat')).toBe(false)
    expect(isAdvisorModelAllowed('deepseek-reasoner')).toBe(false)
    expect(canUseAdvisorWithBaseModel('claude-sonnet-4-6')).toBe(true)
    expect(isAdvisorModelAllowed('claude-opus-4-6')).toBe(true)
  })
})
