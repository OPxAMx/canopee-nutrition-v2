import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
import { isAssistantMessages, requestBotanyReply } from "./shared/botany-assistant";
import { searchOfficialManufacturerProducts } from "./shared/manufacturer-search";
import { createWikiKnowledgeSource } from "./shared/wiki-knowledge";

// =============================================================================
// Manus Debug Collector - Vite Plugin
// Writes browser logs directly to files, trimmed when exceeding size limit
// =============================================================================

const PROJECT_ROOT = import.meta.dirname;
const LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024; // 1MB per log file
const TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6); // Trim to 60% to avoid constant re-trimming

type LogSource = "browserConsole" | "networkRequests" | "sessionReplay";

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function trimLogFile(logPath: string, maxSize: number) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }

    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines: string[] = [];
    let keptBytes = 0;

    // Keep newest lines (from end) that fit within 60% of maxSize
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}\n`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }

    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
    /* ignore trim errors */
  }
}

function writeToLogFile(source: LogSource, entries: unknown[]) {
  if (entries.length === 0) return;

  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);

  // Format entries with timestamps
  const lines = entries.map((entry) => {
    const ts = new Date().toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });

  // Append to log file
  fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");

  // Trim if exceeds max size
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}

/**
 * Vite plugin to collect browser debug logs
 * - POST /__manus__/logs: Browser sends logs, written directly to files
 * - Files: browserConsole.log, networkRequests.log, sessionReplay.log
 * - Auto-trimmed when exceeding 1MB (keeps newest entries)
 */
function vitePluginManusDebugCollector(): Plugin {
  return {
    name: "manus-debug-collector",

    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true,
            },
            injectTo: "head",
          },
        ],
      };
    },

    configureServer(server: ViteDevServer) {
      // POST /__manus__/logs: Browser sends logs (written directly to files)
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }

        const handlePayload = (payload: any) => {
          // Write logs directly to files
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };

        const reqBody = (req as { body?: unknown }).body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    },
  };
}

function vitePluginStorageProxy(): Plugin {
  return {
    name: "manus-storage-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/manus-storage", async (req, res) => {
        const key = req.url?.replace(/^\//, "");
        if (!key) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing storage key");
          return;
        }

        const forgeBaseUrl = (process.env.BUILT_IN_FORGE_API_URL || "").replace(/\/+$/, "");
        const forgeKey = process.env.BUILT_IN_FORGE_API_KEY;

        if (!forgeBaseUrl || !forgeKey) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Storage proxy not configured");
          return;
        }

        try {
          const forgeUrl = new URL("v1/storage/presign/get", forgeBaseUrl + "/");
          forgeUrl.searchParams.set("path", key);

          const forgeResp = await fetch(forgeUrl, {
            headers: { Authorization: `Bearer ${forgeKey}` },
          });

          if (!forgeResp.ok) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Storage backend error");
            return;
          }

          const { url } = (await forgeResp.json()) as { url: string };
          if (!url) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Empty signed URL");
            return;
          }

          res.writeHead(307, { Location: url, "Cache-Control": "no-store" });
          res.end();
        } catch {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Storage proxy error");
        }
      });
    },
  };
}

function vitePluginManufacturerSearch(): Plugin {
  return {
    name: "official-manufacturer-product-search",
    configureServer(server) {
      server.middlewares.use("/api/manufacturer-products", async (req, res, next) => {
        if (req.method !== "GET") return next();
        const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("q")?.trim() ?? "";
        if (query.length < 2 || query.length > 80) {
          res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ error: "La recherche doit contenir entre 2 et 80 caractères." }));
          return;
        }
        const result = await searchOfficialManufacturerProducts(query);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(result));
      });
    },
  };
}

function vitePluginBotanyAssistant(): Plugin {
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  return {
    name: "botany-assistant-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/botany-assistant", (req, res, next) => {
        if (req.method !== "POST") return next();
        const now = Date.now();
        const address = req.socket.remoteAddress ?? "unknown";
        const current = requestCounts.get(address);
        if (current && current.resetAt > now && current.count >= 10) {
          res.writeHead(429, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ error: "Limite temporaire atteinte. Réessayez dans quelques minutes." }));
          return;
        }
        if (!current || current.resetAt <= now) requestCounts.set(address, { count: 1, resetAt: now + 5 * 60 * 1000 });
        else current.count += 1;
        if (requestCounts.size > 1000) {
          for (const [client, entry] of requestCounts) {
            if (entry.resetAt <= now) requestCounts.delete(client);
          }
        }
        let body = "";
        let bodySize = 0;
        let oversized = false;
        req.on("data", (chunk: Buffer) => {
          bodySize += chunk.length;
          if (bodySize <= 8 * 1024 * 1024) body += chunk.toString();
          else oversized = true;
        });
        req.on("end", () => {
          const respond = (status: number, payload: unknown) => {
            res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(payload));
          };
          if (oversized) {
            respond(413, { error: "La requête dépasse la limite de 8 Mo. Réduisez la taille de l’image puis réessayez." });
            return;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(body);
          } catch {
            respond(400, { error: "Le contenu de la requête doit être du JSON valide." });
            return;
          }
          if (!isAssistantMessages(payload) || payload.messages.at(-1)?.role !== "user") {
            respond(400, { error: "La conversation doit contenir jusqu’à 12 messages valides et se terminer par une question. La photo éventuelle doit être une image JPEG, PNG ou WebP valide." });
            return;
          }
          void requestBotanyReply(payload.messages, payload.imageDataUrl).then((result) => {
            if (!result.ok) respond(result.status, { error: result.error });
            else respond(200, { reply: result.reply });
          }).catch(() => respond(502, { error: "Une erreur empêche de joindre le fournisseur IA." }));
        });
      });
    },
  };
}

function vitePluginWikiKnowledge(): Plugin {
  return {
    name: "wiki-knowledge-index",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/wiki-sources", (req, res, next) => {
        if (req.method !== "GET") return next();
        try {
          const directory = path.join(PROJECT_ROOT, "client", "public", "knowledge");
          const sources = fs.readdirSync(directory).flatMap((filename) => {
            const source = createWikiKnowledgeSource(filename);
            return source ? [source] : [];
          }).sort((first, second) => first.title.localeCompare(second.title, "fr"));
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(sources));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ error: "Impossible de lire client/public/knowledge." }));
        }
      });
    },
  };
}

const plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector(), vitePluginStorageProxy(), vitePluginManufacturerSearch(), vitePluginBotanyAssistant(), vitePluginWikiKnowledge()];

export default defineConfig(({ mode }) => {
  const assistantEnv = loadEnv(mode, PROJECT_ROOT, "AI_");
  for (const key of ["AI_API_KEY", "AI_API_URL", "AI_MODEL"]) {
    if (process.env[key] === undefined && assistantEnv[key] !== undefined) process.env[key] = assistantEnv[key];
  }
  return {
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
      },
    },
    envDir: path.resolve(import.meta.dirname),
    root: path.resolve(import.meta.dirname, "client"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port: 3000,
      strictPort: false, // Will find next available port if 3000 is busy
      host: true,
      allowedHosts: [
        ".manuspre.computer",
        ".manus.computer",
        ".manus-asia.computer",
        ".manuscomputer.ai",
        ".manusvm.computer",
        "localhost",
        "127.0.0.1",
      ],
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },
  };
});
