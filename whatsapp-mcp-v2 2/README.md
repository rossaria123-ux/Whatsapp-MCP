# WhatsApp MCP Server for Claude.ai

Gives Claude.ai the ability to send WhatsApp messages directly from any conversation.
Built on the official MCP SDK — works with Claude.ai, Claude Desktop, and Claude mobile.

---

## Setup (3 steps)

### 1. Edit config.mjs
Add the owner's name and contacts:
```js
contacts: {
  gerry: {
    name: "Gerry Widjaja",
    whatsapp: "whatsapp:+628XXXXXXXXX",
    role: "Capitol Group",
  },
}
```

### 2. Deploy to Railway
1. Push this folder to GitHub
2. railway.app → New Project → Deploy from GitHub
3. Add environment variables from `.env.example`
4. Copy your Railway URL: `https://your-app.up.railway.app`

### 3. Connect to Claude.ai
1. Open claude.ai → Customize → Connectors
2. Click "+" → "Add custom connector"
3. Paste your Railway URL + `/mcp`  e.g. `https://your-app.up.railway.app/mcp`
4. Click Add

Enable the connector per conversation via the "+" button → Connectors.

---

## Usage in Claude.ai

> "Message Fitz and tell him the NDA is ready"
> "Who are my contacts?"
> "Remind me to call Gerry tomorrow at 10am"

---

## Available tools

| Tool | What it does |
|---|---|
| `send_whatsapp_message` | Sends a WhatsApp to a contact via Twilio |
| `list_contacts` | Lists all contacts from config.mjs |
| `set_reminder` | Logs a reminder (connect node-cron to fire notifications) |

---

## Adding contacts
Edit `config.mjs`, push to GitHub — Railway redeploys in ~30 seconds.
