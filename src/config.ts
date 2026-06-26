import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  LLM_API_KEY: z.string().min(1).optional(),
  FIREWORKS_API_KEY: z.string().min(1).optional(),
  LLM_BASE_URL: z.string().url().optional(),
  FIREWORKS_BASE_URL: z
    .string()
    .url()
    .default('https://api.fireworks.ai/inference/v1'),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_MODELS: z.string().min(1).optional(),
  FIREWORKS_MODEL: z
    .string()
    .min(1)
    .default('accounts/fireworks/routers/kimi-k2p6-turbo'),
  FIREWORKS_MODELS: z.string().min(1).optional(),
  DATABASE_PATH: z.string().min(1).default('./data/member-tags.sqlite'),
  MESSAGES_PER_RETAG: z.coerce.number().int().positive().default(100),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(120),
  MAX_STORED_MESSAGES_PER_CHAT: z.coerce.number().int().positive().default(600),
  MAX_TAG_CHANGES_PER_RUN: z.coerce.number().int().positive().default(25),
  TAG_MAX_LENGTH: z.coerce.number().int().min(4).max(32).default(16),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.9),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(2500),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n')
  throw new Error(`Configuration validation failed:\n${issues}`)
}

const values = parsed.data
const aiApiKey = values.LLM_API_KEY ?? values.FIREWORKS_API_KEY
if (!aiApiKey) {
  throw new Error(
    'Configuration validation failed:\nLLM_API_KEY or FIREWORKS_API_KEY is required'
  )
}

const aiModels = (
  values.LLM_MODELS ??
  values.FIREWORKS_MODELS ??
  values.LLM_MODEL ??
  values.FIREWORKS_MODEL
)
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean)

if (aiModels.length === 0) {
  throw new Error(
    'Configuration validation failed:\nLLM_MODEL, LLM_MODELS, FIREWORKS_MODEL, or FIREWORKS_MODELS is required'
  )
}

export const config = {
  ...values,
  AI_API_KEY: aiApiKey,
  AI_BASE_URL: (values.LLM_BASE_URL ?? values.FIREWORKS_BASE_URL).replace(
    /\/+$/,
    ''
  ),
  AI_MODELS: aiModels,
}

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true })
