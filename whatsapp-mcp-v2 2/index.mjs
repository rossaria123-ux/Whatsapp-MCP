import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import twilio from "twilio";
import * as z from "zod/v4";
import config from "./config.mjs";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── Build MCP server ─────────────────────────────────────────────────────────
function buildServer() {
  const server = new McpServer({
    name: "whatsapp-assistant",
    version: "1.0.0",
  });

  const contactKeys = Object.keys(config.contacts);

  // Tool 1: Send WhatsApp message
  server.registerTool(
    "send_whatsapp_message",
    {
      title: "Send WhatsApp message",
      description:
        `Send a WhatsApp message to one of ${config.owner.name}'s contacts. ` +
        `Use when asked to message, text, ping, notify, or reach someone. ` +
        `Available contacts: ${contactKeys.join(", ")}.`,
      inputSchema: {
        contact_key: z
          .enum(contactKeys)
          .describe(`Who to message. One of: ${contactKeys.join(", ")}`),
        message: z
          .string()
          .describe("The message body to send, written professionally on behalf of the owner."),
      },
    },
    async ({ contact_key, message }) => {
      console.log(`[TOOL] send_whatsapp_message called: contact=${contact_key} message="${message}"`);
      console.log(`[ENV] TWILIO_ACCOUNT_SID=${process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.slice(0,10)+'...' : 'MISSING'}`);
      console.log(`[ENV] TWILIO_AUTH_TOKEN=${process.env.TWILIO_AUTH_TOKEN ? 'SET' : 'MISSING'}`);
      console.log(`[ENV] TWILIO_WHATSAPP_NUMBER=${process.env.TWILIO_WHATSAPP_NUMBER || 'MISSING'}`);

      const contact = config.contacts[contact_key];
      if (!contact) {
        console.error(`[ERROR] Contact "${contact_key}" not found`);
        return {
          content: [{ type: "text", text: `Contact "${contact_key}" not found.` }],
          isError: true,
        };
      }
      console.log(`[SEND] From: ${process.env.TWILIO_WHATSAPP_NUMBER} To: ${contact.whatsapp}`);
      try {
        const result = await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: contact.whatsapp,
          body: message,
        });
        console.log(`[SENT] SID: ${result.sid} To ${contact.name}: "${message}"`);
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${contact.name}: "${message}"`,
            },
          ],
        };
      } catch (err) {
        console.error(`[TWILIO ERROR] ${err.message}`);
        console.error(`[TWILIO ERROR] Code: ${err.code} Status: ${err.status}`);
        return {
          content: [{ type: "text", text: `Failed to send: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: List contacts
  server.registerTool(
    "list_contacts",
    {
      title: "List contacts",
      description: "List all available contacts with their names and roles.",
      inputSchema: {},
    },
    async () => {
      const list = Object.entries(config.contacts)
        .map(([key, c]) => `• ${key}: ${c.name}${c.role ? ` (${c.role})` : ""}`)
        .join("\n");
      return {
        content: [{ type: "text", text: `Available contacts:\n${list}` }],
      };
    }
  );

  // Tool 3: Set reminder
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
        content: [
          {
            type: "text",
            text: `Reminder set: ${task} (${contact_name}) at ${time}`,
          },
        ],
      };
    }
  );

  return server;
}

// ─── HTTP server with session management ─────────────────────────────────────
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
  res.json({ status: "WhatsApp MCP server running", owner: config.owner.name });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp MCP server on port ${PORT}`));
