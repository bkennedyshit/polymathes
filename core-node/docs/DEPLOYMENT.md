# Deployment

## Local Workstation

```bash
# Install
npm install -g @polymath/gateway
# Or from source:
git clone <repo> && cd core-node && pnpm install && pnpm build

# First run creates config
polymath

# Edit config
$EDITOR ~/.polymath/config.toml

# Run
polymath agent --repl
```

Requirements: Node.js ≥ 22, ~80 MB disk.

## Headless Server

Run Polymath as a background service without the REPL. The gateway HTTP server starts automatically.

```bash
polymath &
# Or use a process manager:
pm2 start polymath --name polymath
```

The gateway listens on the configured port (default 18789). Connect transports (Telegram, Discord) by enabling them in config.

## Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY dist/ ./dist/
COPY package.json ./
RUN npm install --omit=dev
ENV POLYMATH_HOME=/data
VOLUME /data
EXPOSE 18789
CMD ["node", "dist/polymath.mjs"]
```

Build and run:
```bash
docker build -t polymath .
docker run -d -p 18789:18789 -v polymath-data:/data polymath
```

Mount your config at `/data/config.toml`.

## systemd (Linux)

```ini
# /etc/systemd/system/polymath.service
[Unit]
Description=Polymath Agent Runtime
After=network.target

[Service]
Type=simple
User=polymath
ExecStart=/usr/local/bin/polymath
Restart=on-failure
RestartSec=5
Environment=POLYMATH_HOME=/home/polymath/.polymath

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now polymath
```

## launchd (macOS)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.polymath.agent</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/polymath</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/polymath.log</string>
  <key>StandardErrorPath</key><string>/tmp/polymath.err</string>
</dict>
</plist>
```

```bash
cp com.polymath.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.polymath.agent.plist
```
