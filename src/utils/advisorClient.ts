import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * Client-side advisor configuration.
 * Unlike the original advisor.ts which requires first-party API + beta headers,
 * this module enables advisor for any model + any provider.
 */

export function isAdvisorEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)) {
    return false
  }
  // Enabled via env var or settings
  if (isEnvTruthy(process.env.CLAUDE_CODE_ADVISOR_ENABLED)) {
    return true
  }
  return !!getInitialSettings().advisorModel
}

export function getAdvisorModel(): string | undefined {
  const envModel = process.env.CLAUDE_CODE_ADVISOR_MODEL
  if (envModel) return envModel
  return getInitialSettings().advisorModel
}

// Allow any model as advisor — no first-party restriction
export function isValidAdvisorModel(_model: string): boolean {
  return true
}

// Allow any main model to call advisor — no first-party restriction
export function modelSupportsAdvisor(_model: string): boolean {
  return true
}
