import { z } from 'zod/v4'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import { buildTool } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import {
  ADVISOR_CLIENT_SYSTEM_PROMPT,
  ADVISOR_CLIENT_TOOL_NAME,
  usesClientSideAdvisorTool,
} from '../../utils/advisor.js'
import { logForDebugging } from '../../utils/debug.js'
import { logEvent } from '../../services/analytics/index.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { ADVISOR_CLIENT_TOOL_DESCRIPTION } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))

type Input = z.infer<ReturnType<typeof inputSchema>>
type Output = { advice: string }

function extractAssistantText(message: AssistantMessage): string {
  const text = message.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text || '(No advisor response)'
}

export const AdvisorClientTool = buildTool({
  name: ADVISOR_CLIENT_TOOL_NAME,
  searchHint: 'consult a stronger reviewer model for strategic guidance',
  async description() {
    return ADVISOR_CLIENT_TOOL_DESCRIPTION
  },
  async prompt() {
    return ADVISOR_CLIENT_TOOL_DESCRIPTION
  },
  get inputSchema() {
    return inputSchema()
  },
  userFacingName() {
    return 'Advisor'
  },
  isEnabled() {
    return usesClientSideAdvisorTool()
  },
  isConcurrencySafe() {
    return false
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  toAutoClassifierInput() {
    return ''
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: content.advice,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage(content) {
    return content.advice
  },
  async call(_input, context) {
    const appState = context.getAppState()
    const advisorModel = appState.advisorModel
    if (!advisorModel) {
      throw new Error(
        'Advisor model is not configured. Use /advisor <model> to enable it.',
      )
    }

    const resolvedAdvisorModel = parseUserSpecifiedModel(advisorModel)
    logForDebugging(
      `[AdvisorTool] Client-side advisor call with ${resolvedAdvisorModel}`,
    )
    logEvent('tengu_advisor_tool_call', {
      model:
        context.options.mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      advisor_model:
        resolvedAdvisorModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      execution: 'client' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    const advisorMessage = await queryModelWithoutStreaming({
      messages: context.messages,
      systemPrompt: asSystemPrompt([ADVISOR_CLIENT_SYSTEM_PROMPT]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: context.abortController.signal,
      options: {
        getToolPermissionContext: async () =>
          context.getAppState().toolPermissionContext,
        model: resolvedAdvisorModel,
        isNonInteractiveSession: context.options.isNonInteractiveSession,
        hasAppendSystemPrompt: !!context.options.appendSystemPrompt,
        querySource: 'advisor_client_tool',
        agents: context.options.agentDefinitions.activeAgents,
        mcpTools: [],
        agentId: context.agentId,
        effortValue: appState.effortValue,
      },
    })

    const advice = extractAssistantText(advisorMessage)
    logForDebugging(
      `[AdvisorTool] Client-side advisor completed (${advice.length} chars)`,
    )
    return { data: { advice } }
  },
})
