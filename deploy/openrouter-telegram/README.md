# OpenClaw Telegram Bot

Быстрый деплой AI-бота в Telegram. Anthropic (подписка) + OpenRouter (fallback). Один скрипт, 4 параметра, Docker.

## Что нужно

- Сервер с Docker и Docker Compose
- Telegram бот (создать у [@BotFather](https://t.me/BotFather))
- Подписка Claude Pro ($20) или Max ($200) — получить setup-token: `claude setup-token`
- API ключ [OpenRouter](https://openrouter.ai/keys) — fallback
- Твой Telegram ID (узнать у [@userinfobot](https://t.me/userinfobot))

## Быстрый старт

```bash
git clone <YOUR_REPO_URL>
cd <REPO_NAME>/deploy/openrouter-telegram
./setup.sh
```

Скрипт спросит 4 значения и запустит бота.

## Ручная установка

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

## Архитектура

```
Anthropic (Claude подписка)  ← основная модель
         ↓ fallback
OpenRouter (minimax-m2.5)    ← если Anthropic недоступен
```

## Управление

```bash
docker compose logs -f       # Логи
docker compose restart       # Перезапуск
docker compose down          # Остановка
docker compose ps            # Статус
```

## Команды бота (в Telegram)

| Команда | Описание |
|---------|----------|
| `/reauth` | Обновить Anthropic токен (запусти `claude setup-token` и вставь) |
| `/setmodel anthropic/claude-opus-4-6` | Сменить модель без рестарта |
| `/invite` | Создать ссылку-приглашение |
| `/users` | Список пользователей |
| `/block` / `/unblock` | Управление пользователями |
| `/status` | Статус бота, модель, токены |

## Как работает

- **Primary:** Anthropic через setup-token от подписки Claude Pro/Max
- **Fallback:** OpenRouter если Anthropic недоступен
- Новые пользователи: `/start` → админ одобряет
- Изолированные сессии для каждого пользователя

## Смена модели

```
/setmodel anthropic/claude-sonnet-4-6    # Claude Sonnet (default)
/setmodel anthropic/claude-opus-4-6      # Claude Opus
/setmodel openrouter/google/gemini-2.5-pro  # Gemini через OpenRouter
/setmodel openrouter/openai/gpt-4o         # GPT-4o через OpenRouter
```

## Обновление токена

Если токен протух — пишешь боту `/reauth`:
1. Бот просит: запусти `claude setup-token` на любом устройстве
2. Вставляешь токен в чат
3. Бот применяет — работает
