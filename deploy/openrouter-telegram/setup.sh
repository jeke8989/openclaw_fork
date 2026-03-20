#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  OpenClaw Telegram Bot - Quick Setup"
echo "============================================"
echo ""

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "Docker not found. Install: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  echo "Docker Compose not found. Install: https://docs.docker.com/compose/install/"
  exit 1
fi

# Read values
if [ -f .env ]; then
  echo "Found .env file, loading values..."
  source .env
fi

if [ -z "$TELEGRAM_ADMIN_ID" ]; then
  echo "Telegram ID (send /start to @userinfobot):"
  read -r TELEGRAM_ADMIN_ID
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "Telegram bot token (from @BotFather):"
  read -r TELEGRAM_BOT_TOKEN
fi

if [ -z "$ANTHROPIC_SETUP_TOKEN" ]; then
  echo ""
  echo "Anthropic setup-token (run 'claude setup-token' in terminal):"
  read -r ANTHROPIC_SETUP_TOKEN
fi

if [ -z "$OPENROUTER_API_KEY" ]; then
  echo "OpenRouter API key - fallback (https://openrouter.ai/keys):"
  read -r OPENROUTER_API_KEY
fi

# Generate gateway token
GATEWAY_TOKEN=$(openssl rand -hex 32)

# Write .env
cat > .env << EOF
TELEGRAM_ADMIN_ID=${TELEGRAM_ADMIN_ID}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
ANTHROPIC_SETUP_TOKEN=${ANTHROPIC_SETUP_TOKEN}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
EOF
echo ".env saved"

# Create data dir
mkdir -p data/agents/main/agent

# Generate auth-profiles.json with Anthropic setup-token
EXPIRES_AT=$(python3 -c "import time; print(int((time.time() + 365 * 86400) * 1000))" 2>/dev/null || echo "1773900000000")
cat > data/agents/main/agent/auth-profiles.json << EOF
{
  "version": 1,
  "profiles": {
    "anthropic:manual": {
      "type": "token",
      "provider": "anthropic",
      "token": "${ANTHROPIC_SETUP_TOKEN}",
      "expires": ${EXPIRES_AT}
    }
  }
}
EOF
echo "auth-profiles.json generated (Anthropic setup-token)"

# Generate config — primary: Anthropic, fallback: OpenRouter
cat > data/openclaw.json << EOF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6"
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "identity": {
          "name": "Assistant",
          "theme": "You are a helpful AI assistant. Respond in the user's language.\n\nCOMMAND /reauth (admin only):\nWhen admin sends /reauth:\n1. Reply: Run 'claude setup-token' on your Mac and send me the token.\n2. When admin sends the token, write it to auth-profiles.json and confirm.\n\nCOMMAND /setmodel (admin only):\nWhen admin sends /setmodel <name>:\n1. Read /home/node/.openclaw/openclaw.json\n2. Change agents.defaults.model.primary to the model name\n3. Write back and confirm.\nNew model takes effect on next message without restart."
        }
      }
    ]
  },
  "tools": {
    "profile": "messaging"
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true
  },
  "session": {
    "dmScope": "per-channel-peer"
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "allowFrom": ["${TELEGRAM_ADMIN_ID}"],
      "groupPolicy": "allowlist",
      "customCommands": [
        {"command": "invite", "description": "Create invite link"},
        {"command": "users", "description": "List users"},
        {"command": "block", "description": "Block user"},
        {"command": "unblock", "description": "Unblock user"},
        {"command": "reauth", "description": "Update Anthropic token"},
        {"command": "setmodel", "description": "Switch AI model"}
      ]
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "custom",
    "customBindHost": "0.0.0.0",
    "auth": {
      "mode": "token",
      "token": "${GATEWAY_TOKEN}"
    }
  },
  "plugins": {
    "entries": {
      "telegram": {
        "enabled": true
      }
    }
  }
}
EOF
echo "openclaw.json generated"

# Build and start
echo ""
echo "Building and starting..."
docker compose up -d --build

echo ""
echo "============================================"
echo "  Bot is running!"
echo "============================================"
echo ""
echo "  Primary:  Anthropic (Claude subscription)"
echo "  Fallback: OpenRouter (minimax-m2.5)"
echo ""
echo "  Send /start to your bot in Telegram"
echo "  Gateway: http://localhost:18789"
echo "  Token:   ${GATEWAY_TOKEN}"
echo ""
echo "  Logs:    docker compose logs -f"
echo "  Stop:    docker compose down"
echo "  Restart: docker compose restart"
echo ""
