import { z } from 'zod/v4'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  createAdvisorProvider,
  getAdvisorProviderConfig,
  type AdvisorCallOptions,
} from '../../services/advisorProvider.js'
import {
  isAdvisorEnabled,
  getAdvisorModel,
} from '../../utils/advisorClient.js'

const ADVISOR_TOOL_NAME = 'advisor'

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z
      .string()
      .optional()
      .describe(
        'Optional specific question or area you want advice on. If omitted, the advisor will review your overall approach.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    advice: z.string().describe('The advisor model response'),
    model: z.string().describe('The advisor model used'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

const ADVISOR_SYSTEM_PROMPT = `You are an expert advisor reviewing another AI's work. The conversation below shows the task, the tools used, and results so far.

Your job:
1. Identify potential issues, bugs, or missed edge cases
2. Suggest better approaches if the current one seems suboptimal
3. Flag any security concerns
4. Confirm if the approach looks solid

Be concise and actionable. If nothing needs attention, say so briefly.`

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (block.type === 'text') return block.text
        if (block.type === 'tool_use') return `[Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`
        if (block.type === 'tool_result') {
          const inner = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((b: any) => b.text ?? '').join('')
              : ''
          return `[Tool Result: ${inner.slice(0, 2000)}]`
        }
        if (block.type === 'thinking') return ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return String(content)
}

export const AdvisorClientTool = buildTool({
  name: ADVISOR_TOOL_NAME,
  searchHint: 'ask a stronger model for advice before substantive work',
  maxResultSizeChars: 50_000,
  userFacingName() {
    return 'Advisor'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isAdvisorEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'Call a stronger advisor model to review your approach and provide guidance'
  },
  async prompt() {
    return 'Call this tool to get advice from a stronger model before writing code, fixing bugs, or making architectural decisions. The advisor sees your conversation history and provides specific guidance.'
  },
  mapToolResultToToolResultBlockParam(
    { advice, model }: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `[Advisor (${model})]:\n${advice}`,
    }
  },
  async call({ prompt }, context): Promise<ToolResult<Output>> {
    const advisorModel = getAdvisorModel()
    if (!advisorModel) {
      return {
        data: {
          advice: 'No advisor model configured. Use /advisor <model> to set one.',
          model: 'none',
        },
      }
    }

    // Convert conversation messages to simple text format
    const messages = context.messages
      .filter((msg: any) => msg.type === 'user' || msg.type === 'assistant')
      .slice(-40) // Last 40 messages for context window budget
      .map((msg: any) => ({
        role: msg.type === 'user' ? 'user' as const : 'assistant' as const,
        content: extractTextFromContent(msg.message ?? msg.content),
      }))
      .filter((m: any) => m.content.length > 0)

    // If prompt provided, append it as the final user message
    if (prompt) {
      messages.push({
        role: 'user',
        content: `Specific question: ${prompt}`,
      })
    }

    const providerConfig = getAdvisorProviderConfig(advisorModel)
    const provider = createAdvisorProvider(providerConfig)

    logEvent('tengu_advisor_tool_call', {
      model: context.options.mainLoopModel,
      advisor_model: advisorModel,
      provider: providerConfig.provider,
    })

    try {
      const advice = await provider.call({
        messages,
        systemPrompt: ADVISOR_SYSTEM_PROMPT,
        maxTokens: 4096,
        signal: context.abortController.signal,
      })

      return {
        data: {
          advice,
          model: advisorModel,
        },
      }
    } catch (error: any) {
      const errorMsg = error?.message ?? String(error)
      return {
        data: {
          advice: `Advisor call failed: ${errorMsg}`,
          model: advisorModel,
        },
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
