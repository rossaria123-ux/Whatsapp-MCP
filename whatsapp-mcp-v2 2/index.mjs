import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import fetch from "node-fetch";
import * as z from "zod/v4";
import config from "./config.mjs";

const WAPPFLY_BASE = "https://wappfly.com/api";
const WAPPFLY_TOKEN = process.env.WAPPFLY_API_TOKEN;

// ─── Send via Wappfly ─────────────────────────────────────────────────────────
async function wapplySend(toNumber, text) {
  // Convert number to JID format: 6281234567@s.whatsapp.net
  const digits = toNumber.replace(/\D/g, "");
  const jid = `${digits}@s.whatsapp.net`;

  console.log(`[WAPPFLY] Sending to ${jid}: "${text}"`);

  const res = await fetch(`${WAPPFLY_BASE}/messages/send`, {
    method: "POST",
    headers: {
      "X-API-Token": WAPPFLY_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: jid, text }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  console.log(`[WAPPFLY] Queued: msg_id=${data.msg_id}`);
  return data;
}

// ─── Fuzzy contact lookup ─────────────────────────────────────────────────────
function findContact(query) {
  const q = query.toLowerCase().trim();
  if (config.contacts[q]) return { key: q, ...config.contacts[q] };
  for (const [key, contact] of Object.entries(config.contacts)) {
    const searchable = [
      key,
      contact.name.toLowerCase(),
      ...(contact.aliases || []).map(a => a.toLowerCase()),
    ];
    if (searchable.some(s => s.includes(q) || q.includes(s))) {
      return { key, ...contact };
    }
  }
  return null;
}

function buildServer() {
  const server = new McpServer({
    name: "messaging-assistant",
    version: "1.0.0",
  });

  const contactKeys = Object.keys(config.contacts);
  const contactList = Object.entries(config.contacts)
    .map(([key, c]) => `${key} (${c.name}${c.aliases?.length ? ", aka: " + c.aliases.join(", ") : ""})`)
    .join("; ");

  server.registerTool(
    "send_whatsapp_message",
    {
      title: "Send WhatsApp message",
      description:
        `Send a WhatsApp message to one of ${config.owner.name}'s contacts. ` +
        `You can use any name, nickname or alias. Contacts: ${contactList}.`,
      inputSchema: {
        contact_query: z.string().describe("Name, nickname, or alias of who to message."),
        message: z.string().describe("The message body to send."),
      },
    },
    async ({ contact_query, message }) => {
      console.log(`[TOOL] send_whatsapp_message: query="${contact_query}" message="${message}"`);

      const contact = findContact(contact_query);
      if (!contact) {
        return {
          content: [{ type: "text", text: `Contact "${contact_query}" not found. Available: ${contactKeys.join(", ")}` }],
          isError: true,
        };
      }

      try {
        // Strip the whatsapp: prefix if present
        const number = contact.whatsapp.replace("whatsapp:", "").replace("+", "");
        await wapplySend(number, message);
        return {
          content: [{ type: "text", text: `Message sent to ${contact.name}: "${message}"` }],
        };
      } catch (err) {
        console.error(`[WAPPFLY ERROR] ${err.message}`);
        return {
          content: [{ type: "text", text: `Failed to send: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_contacts",
    {
      title: "List contacts",
      description: "List all available contacts with their names and aliases.",
      inputSchema: {},
    },
    async () => {
      const list = Object.entries(config.contacts)
        .map(([key, c]) => `• ${c.name}${c.aliases?.length > 1 ? ` (also: ${c.aliases.slice(1).join(", ")})` : ""}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `Available contacts:\n${list}` }],
      };
    }
  );

  server.registerTool(
    "set_reminder",
    {
      title: "Set reminder",
      description: "Log a reminder to follow up with a contact.",
      inputSchema: {
        contact_name: z.string().describe("Who the reminder is about"),
        time: z.string().describe("When to remind, e.g. 'tomorrow at 10am'"),
        task: z.string().describe("What to do"),
      },
    },
    async ({ contact_name, time, task }) => {
      console.log(`[REMINDER] ${time}: ${task} — re: ${contact_name}`);
      return {
        content: [{ type: "text", text: `Reminder set: ${task} (${contact_name}) at ${time}` }],
      };
    }
  );

  return server;
}

const app = createMcpExpressApp({ host: "0.0.0.0" });
const transports = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  try {
    let transport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
          console.log(`[SESSION] Initialized: ${id}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          console.log(`[SESSION] Closed: ${transport.sessionId}`);
        }
      };
      const server = buildServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: missing or invalid session" },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[ERROR]", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.get("/", (_req, res) => {
  res.json({ status: "WhatsApp MCP server running (Wappfly)", owner: config.owner.name });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp MCP server on port ${PORT}`));
