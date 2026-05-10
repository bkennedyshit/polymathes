# Channel Setup

## Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow prompts to name it
3. Copy the bot token
4. Set in config: `channels.telegram.token = "YOUR_TOKEN"`
5. Start Polymath — it begins polling for messages

## Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot tab → Reset Token → copy it
3. Under OAuth2 → URL Generator, select `bot` scope + `Send Messages` / `Read Message History` permissions
4. Use the generated URL to invite the bot to your server
5. Set in config: `channels.discord.token = "YOUR_TOKEN"`

## Signal

1. Install [signal-cli](https://github.com/AsamK/signal-cli):
   ```bash
   # Linux
   wget https://github.com/AsamK/signal-cli/releases/latest/download/signal-cli-Linux.tar.gz
   tar xf signal-cli-Linux.tar.gz -C /opt
   ln -s /opt/signal-cli-*/bin/signal-cli /usr/local/bin/
   ```
2. Register or link a phone number:
   ```bash
   signal-cli -u +1YOURNUM register
   signal-cli -u +1YOURNUM verify CODE
   ```
3. Set in config: `channels.signal.number = "+1YOURNUM"`
4. Polymath spawns signal-cli in JSON-RPC mode automatically
