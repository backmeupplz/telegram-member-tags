# Telegram Member Tags

Telegram group bot that watches group chat messages and periodically asks Kimi K2.6 Turbo, via Fireworks, to assign funny context-aware member tags.

## Telegram Setup

1. In BotFather, disable privacy mode for the bot so it receives all group messages.
2. Add the bot to a group.
3. Promote it to admin with the right to change member tags.
4. Send `/start` or `/retag` in the group to verify setup.

The bot stores context per Telegram chat ID. Messages and tags never mix between groups.

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
