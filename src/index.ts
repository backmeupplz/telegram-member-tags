import { closeDb } from './db'
import { createBot } from './bot'
import { startWithHandover } from './handover'

const bot = createBot()
const me = await bot.api.getMe()

await startWithHandover(
  bot,
  {
    allowed_updates: ['message', 'my_chat_member', 'chat_member'],
    onStart: () => console.log(`Starting Telegram member tag bot as @${me.username ?? me.id}`),
  },
  () => {
    console.log('Stopping Telegram member tag bot')
    closeDb()
  }
)
