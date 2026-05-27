// ── Types ────────────────────────────────────────────────────────────

export type AdvisorProviderType = 'anthropic' | 'openai-compatible'

export interface AdvisorProviderConfig {
  provider: AdvisorProviderType
  model: string
  apiKey?: string
  baseUrl?: string
}

export interface AdvisorCallOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  systemPrompt?: string
  maxTokens?: number
  signal?: AbortSignal
}

export interface AdvisorProvider {
  call(options: AdvisorCallOptions): Promise<string>
}

// ── Anthropic-compatible Provider ────────────────────────────────────
// Uses raw fetch so it inherits the same ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
// that the main conversation uses — no separate SDK client needed.

export class AnthropicAdvisorProvider implements AdvisorProvider {
  private model: string

  constructor(config: { model: string }) {
    this.model = config.model
  }

  async call(options: AdvisorCallOptions): Promise<string> {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
    const token =
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY ||
      ''

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options.maxTokens ?? 4096,
        system: options.systemPrompt ?? 'You are an expert advisor. Review the conversation and provide concise, actionable guidance.',
        messages: options.messages,
      }),
      signal: options.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Advisor Anthropic API error (${response.status}): ${errorText}`)
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>
    }

    const textBlock = data.content?.find(b => b.type === 'text')
    return textBlock?.text ?? ''
  }
}

// ── OpenAI-compatible Provider (DeepSeek, GLM native, etc.) ──────────

export class OpenAICompatAdvisorProvider implements AdvisorProvider {
  private apiKey: string
  private baseUrl: string
  private model: string

  constructor(config: { apiKey?: string; baseUrl: string; model: string }) {
    this.apiKey = config.apiKey || process.env.ADVISOR_API_KEY || ''
    this.baseUrl = config.baseUrl
    this.model = config.model
  }

  async call(options: AdvisorCallOptions): Promise<string> {
    const messages = [
      {
        role: 'system' as const,
        content: options.systemPrompt ?? 'You are an expert advisor. Review the conversation and provide concise, actionable guidance.',
      },
      ...options.messages,
    ]

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options.maxTokens ?? 4096,
        messages,
      }),
      signal: options.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Advisor API error (${response.status}): ${errorText}`)
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }

    return data.choices?.[0]?.message?.content ?? ''
  }
}

// ── Factory ──────────────────────────────────────────────────────────

export function createAdvisorProvider(config: AdvisorProviderConfig): AdvisorProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicAdvisorProvider({ model: config.model })
    case 'openai-compatible':
      if (!config.baseUrl) {
        throw new Error('baseUrl is required for openai-compatible provider')
      }
      return new OpenAICompatAdvisorProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      })
    default:
      throw new Error(`Unknown advisor provider: ${config.provider}`)
  }
}

// ── Config Helpers ───────────────────────────────────────────────────

export function getAdvisorProviderConfig(model: string): AdvisorProviderConfig {
  const m = model.toLowerCase()

  // Anthropic models
  if (
    m.includes('claude') ||
    m.includes('opus') ||
    m.includes('sonnet') ||
    m.includes('haiku')
  ) {
    return {
      provider: 'anthropic',
      model,
    }
  }

  // GLM (Zhipu AI) — OpenAI-compatible API
  // Uses coding endpoint by default (for GLM 编码套餐)
  if (m.includes('glm')) {
    return {
      provider: 'openai-compatible',
      model,
      baseUrl: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: process.env.GLM_API_KEY,
    }
  }

  // OpenAI
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) {
    return {
      provider: 'openai-compatible',
      model,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
    }
  }

  // DeepSeek
  if (m.includes('deepseek')) {
    return {
      provider: 'openai-compatible',
      model,
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY,
    }
  }

  // Default: use the same Anthropic-compatible endpoint as the main conversation
  return {
    provider: 'anthropic',
    model,
  }
}
