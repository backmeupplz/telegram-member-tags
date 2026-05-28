# Tag Smart Bot

Telegram group bot that watches group chat messages and periodically asks Kimi K2.6 Turbo, via Fireworks, to assign funny context-aware member tags.

Bot: [@tag_smart_bot](https://t.me/tag_smart_bot)

## What It Does

- Stores message context separately per Telegram group.
- Recalculates tags automatically every ~100 text messages by default.
- Uses Kimi K2.6 Turbo through Fireworks for context-aware tag suggestions.
- Matches tag language and script to the chat's dominant language.
- Updates Telegram member tags through the Bot API when the bot has admin rights.

## Telegram Setup

This is the same setup shown by `/start` and `/help` in the bot.

1. Add the bot to a group.
2. Promote it to admin with the right to change member tags.
3. Send `/start`, `/help`, or `/retag` in the group to verify setup.

Messages and tags never mix between groups.

## Environment

Copy `.env.example` to `.env` locally, or set these variables in Easypanel:

- `TELEGRAM_BOT_TOKEN`
- `FIREWORKS_API_KEY`
- `FIREWORKS_BASE_URL`
- `FIREWORKS_MODEL`
- `DATABASE_PATH`
- `MESSAGES_PER_RETAG`
- `MAX_CONTEXT_MESSAGES`
- `MAX_TAG_CHANGES_PER_RUN`
- `TAG_MAX_LENGTH`

Keep `DATABASE_PATH` on a persistent Easypanel volume, for example `/app/data/member-tags.sqlite`.

## Development

```bash
bun install
bun test
bun run typecheck
bun run start
```

## Deployment

Use Nixpacks on Hetzner Easypanel. Set the env vars above in Easypanel and mount a persistent data volume at `/app/data`.
