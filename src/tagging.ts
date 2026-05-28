import { z } from 'zod'
import { config } from './config'
import type { MemberRecord, MessageRecord } from './db'

export type TagSuggestion = {
  userId: number
  tag: string
  reason?: string
}

export type TagContext = {
  chatTitle: string
  members: MemberRecord[]
  messages: MessageRecord[]
}

const planSchema = z.object({
  updates: z
    .array(
      z.object({
        user_id: z.union([z.number(), z.string()]),
        tag: z.string(),
        reason: z.string().optional(),
      })
    )
    .default([]),
})

export function normalizeTag(raw: string): string | null {
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+/, '')
    .trim()

  if (!cleaned) {
    return null
  }

  const safe = cleaned.slice(0, config.TAG_MAX_LENGTH).trim()
  return safe.length >= 2 ? safe : null
}

export function parseTagPlan(raw: string): TagSuggestion[] {
  const json = extractJson(raw)
  const parsed = planSchema.safeParse(JSON.parse(json))
  if (!parsed.success) {
    throw new Error(parsed.error.message)
  }

  const seen = new Set<number>()
  const result: TagSuggestion[] = []

  for (const update of parsed.data.updates) {
    const userId = Number(update.user_id)
    const tag = normalizeTag(update.tag)
    if (!Number.isSafeInteger(userId) || !tag || seen.has(userId)) {
      continue
    }
    seen.add(userId)
    result.push({ userId, tag, reason: update.reason })
  }

  return result
}

export function buildTagPrompt(context: TagContext) {
  const memberLines = context.members
    .map((member) => {
      const handle = member.username ? `@${member.username}` : 'no username'
      const tag = member.currentTag ? `, current tag: ${member.currentTag}` : ''
      return `- ${member.userId}: ${member.displayName} (${handle}), messages: ${member.messageCount}${tag}`
    })
    .join('\n')

  const messageLines = context.messages
    .map((message) => {
      const text = message.text.replace(/\s+/g, ' ').slice(0, 500)
      return `[${message.telegramMessageId}] ${message.displayName} (${message.userId}): ${text}`
    })
    .join('\n')

  return [
    'You assign Telegram member tags for one group chat.',
    'The tags should be funny, specific to recent behavior, affectionate, and short.',
    `Hard limit: every tag must be at most ${config.TAG_MAX_LENGTH} characters.`,
    'Do not use slurs, sexual labels, harassment, threats, or sensitive-trait guesses.',
    'Do not tag people based on race, religion, nationality, sexuality, health, disability, or politics unless the user explicitly self-identifies and it is clearly harmless.',
    'Prefer concrete group-context jokes over generic tags like active, cool, friend, admin.',
    'Only tag users listed in Members. Skip users when there is not enough signal.',
    'Output JSON only, with this exact shape: {"updates":[{"user_id":123,"tag":"tiny tag","reason":"short reason"}]}',
    '',
    `Group: ${context.chatTitle}`,
    '',
    'Members:',
    memberLines || '- none',
    '',
    'Recent messages:',
    messageLines || '- none',
  ].join('\n')
}

function extractJson(raw: string) {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI response did not contain JSON')
  }

  return trimmed.slice(start, end + 1)
}
