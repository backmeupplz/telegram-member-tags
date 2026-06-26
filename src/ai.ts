import { config } from './config'
import { buildTagPrompt, parseTagPlan, type TagContext } from './tagging'

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
    }
  }>
}

async function requestTagPlan(prompt: string, model: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.AI_API_KEY}`,
    'Content-Type': 'application/json',
  }

  if (config.AI_BASE_URL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://t.me/tag_smart_bot'
    headers['X-Title'] = 'Tag Smart Bot'
  }

  const response = await fetch(`${config.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
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
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `LLM request failed for ${model}: ${response.status} ${body.slice(0, 300)}`
    )
  }

  const data = (await response.json()) as ChatCompletionResponse
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    throw new Error(`LLM response from ${model} did not contain message content`)
  }

  return parseTagPlan(content)
}

export async function suggestTags(context: TagContext) {
  const prompt = buildTagPrompt(context)
  let lastError: unknown

  for (const model of config.AI_MODELS) {
    try {
      return await requestTagPlan(prompt, model)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`Tag suggestion failed with ${model}: ${message}`)
    }
  }

  if (lastError instanceof Error) {
    throw lastError
  }
  throw new Error('All configured LLM models failed')
}
