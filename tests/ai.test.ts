import { afterEach, describe, expect, test } from 'bun:test'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.LLM_API_KEY = 'test-llm-key'
process.env.LLM_BASE_URL = 'https://openrouter.ai/api/v1/'
process.env.LLM_MODELS = 'first/free:free, second/free:free'

const originalFetch = globalThis.fetch
const { suggestTags, tagSuggestionFailureReply } = await import('../src/ai')
const { config } = await import('../src/config')
const originalModels = [...config.AI_MODELS]
const originalRequestTimeoutMs = config.AI_REQUEST_TIMEOUT_MS
const originalTotalTimeoutMs = config.AI_TOTAL_TIMEOUT_MS

afterEach(() => {
  globalThis.fetch = originalFetch
  config.AI_MODELS = [...originalModels]
  config.AI_REQUEST_TIMEOUT_MS = originalRequestTimeoutMs
  config.AI_TOTAL_TIMEOUT_MS = originalTotalTimeoutMs
})

describe('suggestTags', () => {
  test('falls back across configured LLM models', async () => {
    const calls: string[] = []

    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      calls.push(body.model)

      if (body.model === 'first/free:free') {
        return new Response('model unavailable', { status: 404 })
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

  test('disables optional reasoning for the JSON-only OpenRouter request', async () => {
    let requestBody: Record<string, unknown> | undefined

    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        choices: [
          {
            message: {
              content: '{"updates":[]}',
            },
          },
        ],
      })
    }) as typeof fetch

    await suggestTags(context)
    expect(requestBody?.reasoning).toEqual({ effort: 'none' })
  })

  test('retries a transient 429 once before falling back', async () => {
    const calls: string[] = []

    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      calls.push(body.model)
      if (body.model === 'first/free:free') {
        return new Response('{"error":{"message":"provider capacity"}}', {
          status: 429,
          headers: { 'Retry-After': '0' },
        })
      }
      return successfulResponse()
    }) as typeof fetch

    await expect(suggestTags(context)).resolves.toHaveLength(1)
    expect(calls).toEqual([
      'first/free:free',
      'first/free:free',
      'second/free:free',
    ])
  })

  test('does not wait on a Retry-After longer than the request budget', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      calls.push(body.model)
      if (body.model === 'first/free:free') {
        return new Response('{"error":{"message":"provider capacity"}}', {
          status: 429,
          headers: { 'Retry-After': '60' },
        })
      }
      return successfulResponse()
    }) as typeof fetch

    await expect(suggestTags(context)).resolves.toHaveLength(1)
    expect(calls).toEqual(['first/free:free', 'second/free:free'])
  })

  test('classifies a provider error returned inside an HTTP 200 body', async () => {
    let calls = 0
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
      calls += 1
      if (calls === 1) {
        return Response.json(
          { error: { code: 429, message: 'provider capacity' } },
          { headers: { 'Retry-After': '0' } }
        )
      }
      return successfulResponse()
    }) as unknown as typeof fetch

    await expect(suggestTags(context)).resolves.toHaveLength(1)
    expect(calls).toBe(2)
  })

  test.each([
    [503, undefined],
    [402, 'openrouter_in_flight_budget'],
  ] as const)(
    'retries transient HTTP %s once when Retry-After is short',
    async (status, limitSource) => {
      const calls: string[] = []
      globalThis.fetch = (async (
        _url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        const request = JSON.parse(String(init?.body)) as { model: string }
        calls.push(request.model)
        if (calls.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: status,
                message: 'temporary provider limit',
                metadata: limitSource ? { limit_source: limitSource } : {},
              },
            }),
            { status, headers: { 'Retry-After': '0' } }
          )
        }
        return successfulResponse()
      }) as typeof fetch

      await expect(suggestTags(context)).resolves.toHaveLength(1)
      expect(calls).toEqual(['first/free:free', 'first/free:free'])
    }
  )

  test('falls back after a malformed model response', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string }
      calls.push(request.model)
      if (request.model === 'first/free:free') {
        return Response.json({
          choices: [{ message: { content: 'not json' } }],
        })
      }
      return successfulResponse()
    }) as typeof fetch

    await expect(suggestTags(context)).resolves.toHaveLength(1)
    expect(calls).toEqual(['first/free:free', 'second/free:free'])
  })

  test('uses only one transient retry across all configured models', async () => {
    let calls = 0
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
      calls += 1
      return new Response('{"error":{"message":"provider capacity"}}', {
        status: 429,
        headers: { 'Retry-After': '0' },
      })
    }) as unknown as typeof fetch

    await expect(suggestTags(context)).rejects.toMatchObject({
      kind: 'rate-limit',
    })
    expect(calls).toBe(3)
  })

  test('matches the deployed empty, empty, 429, 404 failure chain', async () => {
    config.AI_MODELS = ['router', 'reasoner', 'limited', 'removed']
    const calls: string[] = []
    globalThis.fetch = (async (_url, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      calls.push(model)
      if (model === 'router' || model === 'reasoner') {
        return Response.json({
          choices: [{ finish_reason: 'length', message: { content: '' } }],
        })
      }
      if (model === 'limited') {
        return new Response('{"error":{"message":"provider capacity"}}', {
          status: 429,
          headers: { 'Retry-After': '0' },
        })
      }
      return new Response('{"error":{"message":"model not found"}}', {
        status: 404,
      })
    }) as typeof fetch

    const error = await suggestTags(context).catch((caught) => caught)
    expect(error).toMatchObject({ kind: 'unavailable' })
    expect(tagSuggestionFailureReply(error)).toBe(
      'The tag model is temporarily unavailable. Try again shortly.'
    )
    expect(calls).toEqual([
      'router',
      'reasoner',
      'limited',
      'limited',
      'removed',
    ])
  })

  test('does not try other free models after account-wide quota exhaustion', async () => {
    let calls = 0
    globalThis.fetch = (async (_url, _init) => {
      calls += 1
      return new Response(
        '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}',
        { status: 429 }
      )
    }) as typeof fetch

    const error = await suggestTags(context).catch((caught) => caught)
    expect(error).toMatchObject({ kind: 'quota' })
    expect(tagSuggestionFailureReply(error)).toContain('free request quota')
    expect(calls).toBe(1)
  })

  test('falls back after ambiguous model-specific quota wording', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (_url, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      calls.push(model)
      if (model === 'first/free:free') {
        return new Response(
          '{"error":{"message":"Upstream model quota exhausted"}}',
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      }
      return successfulResponse()
    }) as typeof fetch

    await expect(suggestTags(context)).resolves.toHaveLength(1)
    expect(calls).toEqual(['first/free:free', 'second/free:free'])
  })

  test('enforces one elapsed-time budget across all models', async () => {
    config.AI_REQUEST_TIMEOUT_MS = 1_000
    config.AI_TOTAL_TIMEOUT_MS = 20
    let calls = 0
    globalThis.fetch = (async (_url, init) => {
      calls += 1
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('timed out', 'TimeoutError'))
        })
      })
    }) as typeof fetch

    const startedAt = Date.now()
    await expect(suggestTags(context)).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(calls).toBe(1)
  })

  test.each([
    [401, 'auth'],
    [402, 'billing'],
    [403, 'permission'],
  ] as const)('stops on HTTP %s shared-account failures', async (status, kind) => {
    let calls = 0
    globalThis.fetch = (async (_url, _init) => {
      calls += 1
      return new Response('{"error":{"message":"denied"}}', { status })
    }) as typeof fetch

    const error = await suggestTags(context).catch((caught) => caught)
    expect(error).toMatchObject({ kind })
    expect(tagSuggestionFailureReply(error)).toContain('configuration needs attention')
    expect(calls).toBe(1)
  })

  test('reports mixed 5xx and timeout failures without mislabeling them', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      calls.push(body.model)
      if (calls.length === 1) {
        return new Response('{"error":{"message":"upstream unavailable"}}', {
          status: 503,
        })
      }
      if (calls.length === 2) {
        throw new DOMException('timed out', 'TimeoutError')
      }
      return successfulResponse()
    }) as typeof fetch

    await expect(suggestTags(context)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(calls).toEqual(['first/free:free', 'second/free:free'])
  })

  test('classifies bounded all-model timeouts', async () => {
    let calls = 0
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
      calls += 1
      throw new DOMException('timed out', 'TimeoutError')
    }) as unknown as typeof fetch

    await expect(suggestTags(context)).rejects.toMatchObject({ kind: 'timeout' })
    expect(calls).toBe(2)
  })

  test('reports all-model 404s as configuration failures', async () => {
    let calls = 0
    globalThis.fetch = (async (_url, _init) => {
      calls += 1
      return new Response('{"error":{"message":"model not found"}}', {
        status: 404,
      })
    }) as typeof fetch

    const error = await suggestTags(context).catch((caught) => caught)
    expect(error).toMatchObject({ kind: 'configuration' })
    expect(tagSuggestionFailureReply(error)).toContain('configuration needs attention')
    expect(calls).toBe(2)
  })

  test('never includes raw provider response text in the surfaced error', async () => {
    globalThis.fetch = (async (_url, _init) =>
      new Response('{"error":{"message":"secret user content marker"}}', {
        status: 500,
      })) as typeof fetch

    const error = await suggestTags(context).catch((caught) => caught)
    expect(String(error)).not.toContain('secret user content marker')
  })
})

const context = {
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
}

function successfulResponse() {
  return Response.json({
    choices: [
      {
        message: {
          content: '{"updates":[{"user_id":1,"tag":"Free Rider"}]}',
        },
      },
    ],
  })
}
