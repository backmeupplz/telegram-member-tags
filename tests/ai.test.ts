import { afterEach, describe, expect, test } from 'bun:test'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.LLM_API_KEY = 'test-llm-key'
process.env.LLM_BASE_URL = 'https://openrouter.ai/api/v1/'
process.env.LLM_MODELS = 'first/free:free, second/free:free'

const originalFetch = globalThis.fetch
const { suggestTags } = await import('../src/ai')

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('suggestTags', () => {
  test('falls back across configured LLM models', async () => {
    const calls: string[] = []

    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      calls.push(body.model)

      if (body.model === 'first/free:free') {
        return new Response('rate limited', { status: 429 })
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                updates: [{ user_id: 1, tag: 'Free Rider' }],
              }),
            },
          },
        ],
      })
    }) as typeof fetch

    await expect(
      suggestTags({
        chatTitle: 'OpenRouter Lab',
        members: [
          {
            userId: 1,
            username: 'nikita',
            displayName: 'Nikita',
            messageCount: 2,
            currentTag: null,
          },
        ],
        messages: [
          {
            telegramMessageId: 10,
            userId: 1,
            displayName: 'Nikita',
            text: 'use the free models',
            createdAt: 'now',
          },
        ],
      })
    ).resolves.toEqual([
      { userId: 1, tag: 'Free Rider', reason: undefined },
    ])
    expect(calls).toEqual(['first/free:free', 'second/free:free'])
  })
})
