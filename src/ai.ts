import { config } from './config'
import { buildTagPrompt, parseTagPlan, type TagContext } from './tagging'

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
    }
  }>
}

export async function suggestTags(context: TagContext) {
  const prompt = buildTagPrompt(context)
  const response = await fetch(`${config.FIREWORKS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.FIREWORKS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.FIREWORKS_MODEL,
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
      `Fireworks request failed: ${response.status} ${body.slice(0, 300)}`
    )
  }

  const data = (await response.json()) as ChatCompletionResponse
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('Fireworks response did not contain message content')
  }

  return parseTagPlan(content)
}
