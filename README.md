# Telegram Group Bot

Минимальный Telegram-бот для группы на `TypeScript + Telegraf`.

Что умеет:

- реагировать на обычные сообщения в группе
- чаще реагировать на пользователей из `TARGET_USER_IDS`
- генерировать шутки через Gemini для пользователей из `TARGET_USERNAMES`
- отвечать с cooldown, чтобы не спамить
- поддерживать команды `/joke` и `/roastme`

## Запуск

```bash
npm install
cp .env.example .env
npm run dev
```

## Настройка Telegram

1. Создай бота через `@BotFather`
2. Получи токен и вставь его в `.env`
3. Выключи `Privacy Mode` через `@BotFather -> /mybots -> Bot Settings -> Group Privacy -> Turn off`
4. Добавь бота в группу
5. Если хочешь, чтобы бот чаще реагировал на конкретного участника, укажи его numeric `user_id` в `TARGET_USER_IDS`

## Переменные окружения

- `BOT_TOKEN` - токен бота
- `BOT_USERNAME` - имя бота без `@`, опционально для будущих доработок
- `TARGET_USER_IDS` - список numeric user id через запятую
- `TARGET_USERNAMES` - список Telegram username через запятую, например `Yharitonovich`
- `ROAST_COOLDOWN_MS` - минимальная пауза между ответами в одном чате
- `REPLY_CHANCE_PERCENT` - шанс случайной реакции на обычное сообщение
- `GEMINI_API_KEY` - ключ Gemini API
- `GEMINI_MODEL` - модель Gemini, по умолчанию `gemini-3.5-flash`

## Как узнать user id

Самый быстрый способ:

- написать боту в личку
- временно добавить `console.log(ctx.from)` в обработчик
- или использовать любого служебного Telegram ID бота

## Production

Для простого хостинга подойдут `Railway`, `Render` или VPS с `pm2`.
