import { closeDb } from './db'
import { createBot } from './bot'

const bot = createBot()
const me = await bot.api.getMe()

console.log(`Starting Telegram member tag bot as @${me.username ?? me.id}`)

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

await bot.start({
  allowed_updates: ['message', 'my_chat_member', 'chat_member'],
})

async function shutdown() {
  console.log('Stopping Telegram member tag bot')
  await bot.stop()
  closeDb()
  process.exit(0)
}
