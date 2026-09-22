import { afterAll, afterEach, describe, expect, test } from 'bun:test'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.LLM_API_KEY = 'test-llm-key'
process.env.LLM_BASE_URL = 'https://openrouter.ai/api/v1/'
process.env.LLM_MODELS = 'first/free:free, second/free:free'
process.env.DATABASE_PATH = ':memory:'

const originalFetch = globalThis.fetch
const { retagChat } = await import('../src/bot')
const { addMessage, closeDb, ensureChat, upsertMember } = await import('../src/db')

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(() => {
  closeDb()
})

describe('retagChat concurrency', () => {
  test('one chat has one model call, tag write, and completion reply at a time', async () => {
    const chatId = -1001
    ensureChat(chatId, 'Concurrency Lab', 'supergroup')
    for (const userId of [1, 2]) {
      upsertMember({
        chatId,
        userId,
        username: `user${userId}`,
        displayName: `User ${userId}`,
      })
    }
    for (let index = 0; index < 10; index += 1) {
      addMessage({
        chatId,
        telegramMessageId: index + 1,
        userId: (index % 2) + 1,
        displayName: `User ${(index % 2) + 1}`,
        text: `message ${index + 1}`,
      })
    }

    let finishRequest!: (response: Response) => void
    let modelCalls = 0
    const requestStarted = new Promise<void>((resolve) => {
      globalThis.fetch = (async () => {
        modelCalls += 1
        resolve()
        return await new Promise<Response>((finish) => {
          finishRequest = finish
        })
      }) as unknown as typeof fetch
    })

    let tagWrites = 0
    const bot = {
      api: {
        getMe: async () => ({ id: 99, first_name: 'Tag Bot', is_bot: true }),
        getChatMember: async () => ({ status: 'administrator' }),
        raw: {
          setChatMemberTag: async () => {
            tagWrites += 1
          },
        },
      },
    }
    const firstReplies: string[] = []
    const secondReplies: string[] = []
    const first = retagChat(bot as never, chatId, {
      notify: true,
      ctx: { reply: async (text: string) => firstReplies.push(text) } as never,
    })

    await requestStarted
    await retagChat(bot as never, chatId, {
      notify: true,
      ctx: { reply: async (text: string) => secondReplies.push(text) } as never,
    })
    finishRequest(
      Response.json({
        choices: [
          {
            message: {
              content: '{"updates":[{"user_id":1,"tag":"Only Once"}]}',
            },
          },
        ],
      })
    )
    await first

    expect(modelCalls).toBe(1)
    expect(tagWrites).toBe(1)
    expect(firstReplies).toEqual(['Updated 1 member tag.'])
    expect(secondReplies).toEqual(['A retag run is already in progress.'])
  })
})
