# Remote Access

Polymath runs locally but can be exposed securely for Telegram webhooks, mobile access, or multi-machine setups.

## Tailscale Tunnel

The simplest option for private access across devices.

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Polymath is now reachable at http://<tailscale-ip>:18789
# from any device on your tailnet.
```

For HTTPS with a Tailscale certificate:
```bash
tailscale cert <machine-name>.<tailnet>.ts.net
# Configure a reverse proxy (caddy/nginx) with the cert
```

## Cloudflare Tunnel

Zero-trust access without opening ports.

```bash
# Install cloudflared
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Create tunnel
cloudflared tunnel create polymath
cloudflared tunnel route dns polymath polymath.yourdomain.com

# Config: ~/.cloudflared/config.yml
# tunnel: <tunnel-id>
# credentials-file: ~/.cloudflared/<tunnel-id>.json
# ingress:
#   - hostname: polymath.yourdomain.com
#     service: http://localhost:18789
#   - service: http_status:404

# Run
cloudflared tunnel run polymath
```

Set your Telegram webhook to `https://polymath.yourdomain.com/webhook/telegram`.

## ngrok (Quick Testing)

For development or quick Telegram webhook testing.

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 18789
```

Copy the HTTPS URL and set it as your Telegram webhook:
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<ngrok-url>/webhook/telegram"
```

Note: ngrok URLs change on restart (unless you have a paid plan). Use Cloudflare Tunnel or Tailscale for persistent setups.

## Telegram Webhook Setup

1. Expose Polymath via one of the methods above
2. Set the webhook:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<your-domain>/webhook/telegram"
   ```
3. Verify:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
   ```

## Security Notes

- Always use the bearer token for API access (auto-generated at first run)
- The pairing system prevents unauthorized Telegram/Discord users from interacting
- Consider IP allowlisting in Cloudflare for the gateway endpoints
- Tailscale provides device-level auth — no additional config needed
