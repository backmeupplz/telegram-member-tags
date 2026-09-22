import { config } from './config'
import { buildTagPrompt, parseTagPlan, type TagContext } from './tagging'

type ChatCompletionResponse = {
  error?: {
    code?: number
    message?: string
    metadata?: Record<string, unknown>
  }
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | null
    }
  }>
}

export type TagSuggestionFailureKind =
  | 'auth'
  | 'billing'
  | 'configuration'
  | 'malformed'
  | 'permission'
  | 'provider'
  | 'quota'
  | 'rate-limit'
  | 'timeout'
  | 'unavailable'

export class TagSuggestionError extends Error {
  constructor(
    readonly kind: TagSuggestionFailureKind,
    readonly model: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(
      `Tag suggestion ${kind} failure for ${model}${status ? ` (HTTP ${status})` : ''}`
    )
    this.name = 'TagSuggestionError'
  }
}

const defaultRetryDelayMs = 250
const maxRetryDelayMs = 5_000

async function requestTagPlan(prompt: string, model: string, timeoutMs: number) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.AI_API_KEY}`,
    'Content-Type': 'application/json',
  }

  const body: Record<string, unknown> = {
    model,
    temperature: config.AI_TEMPERATURE,
    max_tokens: config.AI_MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are a witty Telegram group tagger. Return valid compact JSON only.',
      },
      { role: 'user', content: prompt },
    ],
  }

  if (config.AI_BASE_URL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://t.me/tag_smart_bot'
    headers['X-Title'] = 'Tag Smart Bot'
    body.reasoning = { effort: 'none' }
  }

  let response: Response
  try {
    response = await fetch(`${config.AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })
  } catch (error) {
    throw normalizeRequestError(error, model)
  }

  const responseBody = await response.text()
  if (!response.ok) {
    throw classifyHttpError(response, responseBody, model)
  }

  let data: ChatCompletionResponse
  try {
    data = JSON.parse(responseBody) as ChatCompletionResponse
  } catch {
    throw new TagSuggestionError('malformed', model, response.status)
  }

  if (data.error) {
    throw classifyHttpError(response, responseBody, model)
  }

  const content = data.choices?.[0]?.message?.content
  if (!content) {
    throw new TagSuggestionError('malformed', model, response.status)
  }

  try {
    return parseTagPlan(content)
  } catch {
    throw new TagSuggestionError('malformed', model, response.status)
  }
}

export async function suggestTags(context: TagContext) {
  const prompt = buildTagPrompt(context)
  const failures: TagSuggestionError[] = []
  let retryUsed = false
  const deadline = Date.now() + config.AI_TOTAL_TIMEOUT_MS

  modelLoop: for (const model of config.AI_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        failures.push(new TagSuggestionError('timeout', model))
        break modelLoop
      }
      try {
        return await requestTagPlan(
          prompt,
          model,
          Math.min(config.AI_REQUEST_TIMEOUT_MS, remainingMs)
        )
      } catch (error) {
        const failure = normalizeRequestError(error, model)
        failures.push(failure)
        const retryDelay = failure.retryAfterMs ?? defaultRetryDelayMs
        const retryBudgetMs = deadline - Date.now()
        const retrying =
          !retryUsed &&
          attempt === 1 &&
          retryDelay <= maxRetryDelayMs &&
          retryDelay < retryBudgetMs &&
          (failure.kind === 'rate-limit' ||
            (failure.kind === 'provider' &&
              (failure.status === 402 || failure.status === 503) &&
              failure.retryAfterMs !== undefined))
        console.warn('Tag suggestion model failed', {
          model,
          kind: failure.kind,
          status: failure.status,
          attempt,
          retrying,
          retryAfterMs: retrying ? retryDelay : undefined,
        })

        if (isSharedAccountFailure(failure.kind)) {
          throw failure
        }
        if (retrying) {
          retryUsed = true
          await Bun.sleep(retryDelay)
          continue
        }
        break
      }
    }
  }

  const lastFailure = failures.at(-1)
  if (!lastFailure) {
    throw new TagSuggestionError('unavailable', 'none')
  }
  if (failures.every((failure) => failure.kind === lastFailure.kind)) {
    throw lastFailure
  }
  throw new TagSuggestionError('unavailable', lastFailure.model, lastFailure.status)
}

export function tagSuggestionFailureReply(error: unknown) {
  if (!(error instanceof TagSuggestionError)) {
    return 'The tag model is temporarily unavailable. Try again shortly.'
  }
  if (error.kind === 'quota') {
    return "The tag model's free request quota is exhausted. Try again after the provider resets it."
  }
  if (
    error.kind === 'auth' ||
    error.kind === 'billing' ||
    error.kind === 'configuration' ||
    error.kind === 'permission'
  ) {
    return 'The tag model is unavailable because its provider configuration needs attention.'
  }
  return 'The tag model is temporarily unavailable. Try again shortly.'
}

function classifyHttpError(response: Response, body: string, model: string) {
  const providerError = parseProviderError(body)
  const status = providerError?.code ?? response.status
  if (status === 401) {
    return new TagSuggestionError('auth', model, status)
  }
  if (status === 402) {
    if (
      providerError?.metadata?.limit_source === 'openrouter_in_flight_budget' &&
      response.headers.has('Retry-After')
    ) {
      return new TagSuggestionError(
        'provider',
        model,
        status,
        retryAfterMs(response.headers)
      )
    }
    return new TagSuggestionError('billing', model, status)
  }
  if (status === 403) {
    return new TagSuggestionError('permission', model, status)
  }
  if (status === 404 || status === 400 || status === 422) {
    return new TagSuggestionError('configuration', model, status)
  }
  if (status === 408) {
    return new TagSuggestionError('timeout', model, status)
  }
  if (status === 429) {
    const kind = isAccountWideQuota(providerError) ? 'quota' : 'rate-limit'
    return new TagSuggestionError(
      kind,
      model,
      status,
      kind === 'rate-limit' ? retryAfterMs(response.headers) : undefined
    )
  }
  if (status >= 500) {
    return new TagSuggestionError(
      'provider',
      model,
      status,
      status === 503 ? retryAfterMs(response.headers) : undefined
    )
  }
  return new TagSuggestionError('unavailable', model, status)
}

function normalizeRequestError(error: unknown, model: string) {
  if (error instanceof TagSuggestionError) {
    return error
  }
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return new TagSuggestionError('timeout', model)
  }
  return new TagSuggestionError('provider', model)
}

function isSharedAccountFailure(kind: TagSuggestionFailureKind) {
  return (
    kind === 'auth' ||
    kind === 'billing' ||
    kind === 'permission' ||
    kind === 'quota'
  )
}

function isAccountWideQuota(providerError?: ChatCompletionResponse['error']) {
  const limitSource = providerError?.metadata?.limit_source
  return (
    limitSource === 'free_model_daily_requests' ||
    /free[-_ ]models?[-_ ]per[-_ ]day|free_model_daily_requests/i.test(
      providerError?.message ?? ''
    )
  )
}

function retryAfterMs(headers: Headers) {
  const value = headers.get('Retry-After')
  if (!value) {
    return undefined
  }

  const seconds = Number(value)
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now()
  if (!Number.isFinite(delay)) {
    return undefined
  }
  return Math.max(0, delay)
}

function parseProviderError(body: string) {
  try {
    const parsed = JSON.parse(body) as ChatCompletionResponse
    return parsed.error
  } catch {
    return undefined
  }
}
