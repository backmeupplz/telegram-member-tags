import { describe, expect, test } from 'bun:test'

process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.FIREWORKS_API_KEY = 'test-fireworks-key'
process.env.LLM_API_KEY = 'test-llm-key'
process.env.LLM_BASE_URL = 'https://openrouter.ai/api/v1/'
process.env.LLM_MODELS = 'first/free:free, second/free:free'

const { buildTagPrompt, normalizeTag, parseTagPlan } = await import(
  '../src/tagging'
)

describe('normalizeTag', () => {
  test('trims whitespace and limits length', () => {
    expect(normalizeTag('  #Very Long Tag Name That Keeps Going  ')).toBe(
      'Very Long Tag Na'
    )
  })

  test('rejects empty tags', () => {
    expect(normalizeTag('   \n')).toBeNull()
  })
})

describe('parseTagPlan', () => {
  test('parses compact JSON and de-duplicates users', () => {
    expect(
      parseTagPlan(
        JSON.stringify({
          updates: [
            { user_id: 1, tag: 'Snack CEO' },
            { user_id: '1', tag: 'Duplicate' },
            { user_id: 2, tag: 'Bit Wrangler' },
          ],
        })
      )
    ).toEqual([
      { userId: 1, tag: 'Snack CEO', reason: undefined },
      { userId: 2, tag: 'Bit Wrangler', reason: undefined },
    ])
  })
})

describe('buildTagPrompt', () => {
  test('includes only the supplied chat context', () => {
    const prompt = buildTagPrompt({
      chatTitle: 'One Group',
      members: [
        {
          userId: 1,
          username: 'nikita',
          displayName: 'Nikita',
          messageCount: 12,
          currentTag: null,
        },
      ],
      messages: [
        {
          telegramMessageId: 10,
          userId: 1,
          displayName: 'Nikita',
          text: 'ship it',
          createdAt: 'now',
        },
      ],
    })

    expect(prompt).toContain('Group: One Group')
    expect(prompt).toContain('ship it')
    expect(prompt).toContain('Use recent messages as evidence, not as tag text')
    expect(prompt).toContain('Invent compact persona/vibe labels')
    expect(prompt).toContain('You may assign the bot its own funny tag')
    expect(prompt).toContain('Use the same language and script as the recent chat')
    expect(prompt).not.toContain('Other Group')
  })
})
