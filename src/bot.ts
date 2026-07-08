import { Bot, type Context } from 'grammy'
import { config } from './config'
import {
  activeMembers,
  addMessage,
  ensureChat,
  ensureMember,
  getChat,
  markSetupWarningSent,
  markTaggingComplete,
  recentMessages,
  rememberTag,
  trimMessages,
  upsertMember,
} from './db'
import { suggestTags } from './ai'

const setupText = [
  'I can assign context-aware member tags every ~100 messages.',
  '',
  'Setup:',
  '1. Add me to a group.',
  '2. Promote me to admin with the right to change member tags.',
  '3. Send /retag after the group has some chat history.',
].join('\n')

const runningRetags = new Set<number>()

export function createBot() {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN)

  bot.command('start', async (ctx) => {
    if (isGroup(ctx)) {
      await registerChat(ctx)
      await ctx.reply(setupText)
      return
    }
    await ctx.reply(setupText)
  })

  bot.command('help', async (ctx) => {
    if (isGroup(ctx)) {
      await registerChat(ctx)
      await ctx.reply(setupText)
      return
    }
    await ctx.reply(setupText)
  })

  bot.command('retag', async (ctx) => {
    if (!isGroup(ctx)) {
      await ctx.reply('Add me to a group first, then run /retag there.')
      return
    }

    await registerChat(ctx)
    if (!(await userCanManageChat(ctx))) {
      await ctx.reply('Only group admins can trigger a manual retag.')
      return
    }

    await retagChat(bot, ctx.chat.id, { notify: true, ctx })
  })

  bot.on('message:new_chat_members', async (ctx) => {
    if (!ctx.chat || !isGroup(ctx)) {
      return
    }

    await registerChat(ctx)
    const me = await bot.api.getMe()
    const addedMe = ctx.message.new_chat_members.some((member) => member.id === me.id)
    if (addedMe) {
      await ctx.reply(setupText)
    }
  })

  bot.on('message', async (ctx) => {
    if (!isGroup(ctx) || !ctx.from || ctx.from.is_bot) {
      return
    }

    const text = messageText(ctx)
    if (!text) {
      return
    }

    await registerChat(ctx)
    const displayName = formatDisplayName(ctx.from)
    upsertMember({
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      username: ctx.from.username,
      displayName,
    })
    addMessage({
      chatId: ctx.chat.id,
      telegramMessageId: ctx.message.message_id,
      userId: ctx.from.id,
      displayName,
      text,
    })
    trimMessages(ctx.chat.id)

    const chat = getChat(ctx.chat.id)
    if (
      chat &&
      chat.messageCountSinceTags >= config.MESSAGES_PER_RETAG &&
      !runningRetags.has(ctx.chat.id)
    ) {
      void retagChat(bot, ctx.chat.id, { notify: false, ctx }).catch((error) => {
        console.error('automatic retag failed', {
          chatId: ctx.chat?.id,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  })

  bot.catch((error) => {
    console.error('bot update failed', {
      updateId: error.ctx.update.update_id,
      error:
        error.error instanceof Error ? error.error.message : String(error.error),
    })
  })

  return bot
}

async function retagChat(
  bot: Bot,
  chatId: number,
  options: { notify: boolean; ctx?: Context }
) {
  if (runningRetags.has(chatId)) {
    if (options.notify) {
      await options.ctx?.reply('A retag run is already in progress.')
    }
    return
  }

  runningRetags.add(chatId)
  try {
    const chat = getChat(chatId)
    if (!chat) {
      return
    }

    await ensureBotMember(bot, chatId)
    const members = activeMembers(chatId)
    const messages = recentMessages(chatId)

    if (messages.length < 10 || members.length < 2) {
      if (options.notify) {
        await options.ctx?.reply('I need at least 10 messages from a few people first.')
      }
      return
    }

    const canTag = await botCanTagMembers(bot, chatId)
    if (!canTag) {
      if (options.notify) {
        await options.ctx?.reply(setupText)
      } else {
        markSetupWarningSent(chatId)
      }
      return
    }

    const knownUserIds = new Set(members.map((member) => member.userId))
    let suggestions
    try {
      suggestions = (await suggestTags({
        chatTitle: chat.title,
        members,
        messages,
      }))
        .filter((suggestion) => knownUserIds.has(suggestion.userId))
        .slice(0, config.MAX_TAG_CHANGES_PER_RUN)
    } catch (error) {
      console.error('tag suggestion failed', {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      })
      if (options.notify) {
        await options.ctx?.reply('The tag model is temporarily rate-limited. Try again shortly.')
      } else {
        markTaggingComplete(chatId)
      }
      return
    }

    let applied = 0
    for (const suggestion of suggestions) {
      try {
        await setChatMemberTag(bot, chatId, suggestion.userId, suggestion.tag)
        rememberTag(chatId, suggestion.userId, suggestion.tag)
        applied += 1
      } catch (error) {
        console.warn('tag update failed', {
          chatId,
          userId: suggestion.userId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    markTaggingComplete(chatId)
    if (options.notify) {
      await options.ctx?.reply(
        applied
          ? `Updated ${applied} member tag${applied === 1 ? '' : 's'}.`
          : 'Kimi did not find enough good tag material yet.'
      )
    }
  } finally {
    runningRetags.delete(chatId)
  }
}

async function ensureBotMember(bot: Bot, chatId: number) {
  const me = await bot.api.getMe()
  ensureMember({
    chatId,
    userId: me.id,
    username: me.username,
    displayName: `${formatBotDisplayName(me)} (this bot)`,
  })
}

async function setChatMemberTag(
  bot: Bot,
  chatId: number,
  userId: number,
  tag: string
) {
  await bot.api.raw.setChatMemberTag({
    chat_id: chatId,
    user_id: userId,
    tag,
  } as never)
}

async function botCanTagMembers(bot: Bot, chatId: number) {
  const me = await bot.api.getMe()
  const member = await bot.api.getChatMember(chatId, me.id)
  return member.status === 'administrator' || member.status === 'creator'
}

async function userCanManageChat(ctx: Context) {
  if (!ctx.chat || !ctx.from) {
    return false
  }
  const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id)
  return member.status === 'administrator' || member.status === 'creator'
}

async function registerChat(ctx: Context) {
  if (!ctx.chat) {
    return
  }
  ensureChat(ctx.chat.id, chatTitle(ctx), ctx.chat.type)
}

function isGroup(ctx: Context) {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
}

function chatTitle(ctx: Context) {
  return 'title' in ctx.chat! && ctx.chat.title ? ctx.chat.title : String(ctx.chat!.id)
}

function messageText(ctx: Context) {
  const message = ctx.message
  if (!message) {
    return null
  }
  const text =
    'text' in message && message.text
      ? message.text
      : 'caption' in message && message.caption
        ? message.caption
        : null
  return text?.trim() || null
}

function formatDisplayName(user: NonNullable<Context['from']>) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id)
}

function formatBotDisplayName(user: {
  id: number
  first_name: string
  last_name?: string
  username?: string
}) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id)
}
