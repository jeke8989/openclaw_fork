# OpenClaw Telegram Bot (OpenRouter)

Быстрый деплой AI-бота в Telegram через OpenRouter. Один скрипт, 3 параметра, Docker.

## Что нужно

- Сервер с Docker и Docker Compose
- Telegram бот (создать у [@BotFather](https://t.me/BotFather))
- API ключ [OpenRouter](https://openrouter.ai/keys)
- Твой Telegram ID (узнать у [@userinfobot](https://t.me/userinfobot))

## Быстрый старт

```bash
git clone https://github.com/jeke8989/openclaw_fork.git
cd openclaw_fork/deploy/openrouter-telegram
./setup.sh
```

Скрипт спросит 3 значения и запустит бота.

## Ручная установка

```bash
cp .env.example .env
# Заполни .env своими значениями
nano .env

docker compose up -d --build
```

## Управление

```bash
# Логи
docker compose logs -f

# Перезапуск
docker compose restart

# Остановка
docker compose down

# Статус
docker compose ps
```

## Как работает

- Новые пользователи пишут `/start` боту
- Админ получает уведомление и может одобрить/отклонить (dmPolicy: pairing)
- Каждый пользователь имеет изолированную сессию
- Модель по умолчанию: `anthropic/claude-sonnet-4-6` через OpenRouter

## Смена модели

Отредактируй `data/openclaw.json`, поле `agents.defaults.model.primary`:

```
openrouter/anthropic/claude-sonnet-4-6    # Claude Sonnet
openrouter/anthropic/claude-opus-4-6      # Claude Opus
openrouter/google/gemini-2.5-pro          # Gemini Pro
openrouter/openai/gpt-4o                  # GPT-4o
```

После смены: `docker compose restart`

## Настройка бота

Имя и поведение бота: `data/openclaw.json` → `agents.list[0].identity`

```json
{
  "name": "MyBot",
  "theme": "Ты полезный AI-ассистент. Отвечай на русском."
}
```
