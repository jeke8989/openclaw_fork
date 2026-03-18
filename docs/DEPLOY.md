# Быстрый деплой OpenClaw Telegram-бота

## Требования

- Ubuntu 22.04+ сервер
- Node.js >= 22.16
- pnpm 10.23.0
- Подписка Claude Max (или API ключ Anthropic)
- Telegram Bot Token (через @BotFather)

## 1. Подготовка сервера

```bash
# Установить Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Обновить до последней 22.x
npm install -g n && n 22
ln -sf /usr/local/bin/node /usr/bin/node

# Установить pnpm и pm2
npm install -g pnpm@10.23.0 pm2

# Клонировать репо
cd /opt
git clone https://github.com/jeke8989/openclaw_fork.git openclaw
cd /opt/openclaw

# Установить зависимости (ВАЖНО: --force нужен для zod v4)
echo 'node-linker=hoisted' >> .npmrc
pnpm install --force

# Собрать
pnpm build
```

## 2. Настройка Anthropic OAuth (Claude Max подписка)

### Вариант A: OAuth через Claude CLI (рекомендуется для подписки Max)

```bash
# Установить Claude CLI (если нет)
npm install -g @anthropic-ai/claude-code

# Запустить авторизацию
claude auth login
```

Откроется ссылка — перейди по ней в браузере, авторизуйся в Claude Max.

**Если сервер без браузера (headless):**

1. Запусти `BROWSER=echo claude auth login` — скопируй ссылку
2. Открой ссылку в любом браузере, авторизуйся
3. На странице с кодом нажми кнопку подтверждения

Затем скопируй credentials в директорию агента:

```bash
mkdir -p ~/.openclaw/agents/main/agent

python3 -c "
import json
with open('/root/.claude/.credentials.json') as f:
    creds = json.load(f)
oauth = creds['claudeAiOauth']
profiles = {
    'version': 1,
    'profiles': {
        'anthropic:claude-cli': {
            'type': 'oauth',
            'provider': 'anthropic',
            'access': oauth['accessToken'],
            'refresh': oauth['refreshToken'],
            'expires': oauth['expiresAt']
        }
    }
}
with open('/root/.openclaw/agents/main/agent/auth-profiles.json', 'w') as f:
    json.dump(profiles, f, indent=2)
print('OK')
"
```

### Вариант B: API ключ (оплата за токены)

```bash
# Просто добавь в .env
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.openclaw/.env
```

## 3. Конфигурация бота

```bash
mkdir -p ~/.openclaw/agents/main/sessions ~/.openclaw/credentials ~/.openclaw/workspace

# Создать .env
cat > ~/.openclaw/.env << 'EOF'
TELEGRAM_BOT_TOKEN=ВАШ_ТОКЕН_ОТ_BOTFATHER
OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
EOF

# Создать конфиг
cat > ~/.openclaw/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {"primary": "anthropic/claude-sonnet-4-6"},
      "maxConcurrent": 4
    },
    "list": [{
      "id": "main",
      "identity": {
        "name": "Ваш Бот",
        "theme": "Ты AI-ассистент. Общайся на русском. Будь полезным и дружелюбным."
      }
    }]
  },
  "tools": {"profile": "messaging"},
  "commands": {"native": "auto", "nativeSkills": "auto", "restart": true},
  "session": {"dmScope": "per-channel-peer"},
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "allowFrom": ["ADMIN_TELEGRAM_ID"],
      "customCommands": [
        {"command": "invite", "description": "Создать ссылку-приглашение"},
        {"command": "users", "description": "Список пользователей"},
        {"command": "block", "description": "Заблокировать пользователя"},
        {"command": "unblock", "description": "Разблокировать пользователя"},
        {"command": "role", "description": "Узнать свою роль"}
      ]
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "custom",
    "customBindHost": "0.0.0.0",
    "auth": {"mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}"}
  },
  "plugins": {"entries": {"telegram": {"enabled": true}}}
}
EOF

chmod 600 ~/.openclaw/openclaw.json ~/.openclaw/.env
```

**Замени:**

- `ВАШ_ТОКЕН_ОТ_BOTFATHER` — токен бота
- `ADMIN_TELEGRAM_ID` — Telegram ID админа (узнать: @userinfobot)
- `Ваш Бот` — имя бота
- `theme` — описание поведения бота

## 4. Запуск

```bash
cd /opt/openclaw
pm2 start dist/index.js --name openclaw -- gateway --verbose
pm2 save
pm2 startup
```

## 5. Проверка

```bash
# Healthcheck
curl http://127.0.0.1:18789/healthz

# Логи
pm2 logs openclaw --lines 30

# Статус
pm2 status
```

## 6. Управление пользователями

- Админ (первый ID в `allowFrom`) имеет доступ к командам:
  - `/invite` — ссылка для приглашения
  - `/users` — список пользователей
  - `/block <id>` — заблокировать
  - `/unblock <id>` — разблокировать
  - `/role` — узнать роль

- Новые пользователи получают pairing code → админ подтверждает через `/pair`

## 7. CI/CD (GitHub Actions)

Добавь секреты в GitHub → Settings → Secrets → Actions:

- `SERVER_HOST` — IP сервера
- `SERVER_PASSWORD` — пароль root

При push в main — автодеплой.

## Решение проблем

| Проблема                                  | Решение                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `Cannot find package zod`                 | `rm -rf node_modules && pnpm install --force`                      |
| `gateway.bind=lan, no private LAN IP`     | Поменять bind на `custom`, customBindHost на `0.0.0.0`             |
| `No API key found for provider anthropic` | Скопировать auth-profiles.json в `~/.openclaw/agents/main/agent/`  |
| `telegram plugin disabled`                | Добавить `"plugins": {"entries": {"telegram": {"enabled": true}}}` |
| `Config invalid: Unrecognized key`        | Запустить `node dist/index.js doctor --fix`                        |
