import express from "express";
import { createServer } from "http";
import path from "path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "url";
import { isAssistantMessages, requestBotanyReply } from "../shared/botany-assistant";
import { searchOfficialManufacturerProducts } from "../shared/manufacturer-search";
import { createWikiKnowledgeSource } from "../shared/wiki-knowledge";

const assistantRequestCounts = new Map<string, { count: number; resetAt: number }>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.get("/api/manufacturer-products", (req, res, next) => {
    const query = req.query.q;
    if (typeof query !== "string" || query.trim().length < 2 || query.trim().length > 80) {
      res.status(400).json({ error: "La recherche doit contenir entre 2 et 80 caractères." });
      return;
    }
    searchOfficialManufacturerProducts(query)
      .then((result) => res.set("Cache-Control", "no-store").json(result))
      .catch(next);
  });

  app.get("/api/wiki-sources", (_req, res, next) => {
    readdir(path.join(staticPath, "knowledge"))
      .then((filenames) => {
        const sources = filenames.flatMap((filename) => {
          const source = createWikiKnowledgeSource(filename);
          return source ? [source] : [];
        }).sort((first, second) => first.title.localeCompare(second.title, "fr"));
        res.set("Cache-Control", "no-store").json(sources);
      })
      .catch(next);
  });

  app.post("/api/botany-assistant", express.json({ limit: "8mb" }), async (req, res) => {
    if (!isAssistantMessages(req.body) || req.body.messages.at(-1)?.role !== "user") {
      res.status(400).json({ error: "La conversation doit contenir jusqu’à 12 messages valides et se terminer par une question. La photo éventuelle doit être une image JPEG, PNG ou WebP valide." });
      return;
    }

    const now = Date.now();
    const clientAddress = req.socket.remoteAddress ?? "unknown";
    const rateLimit = assistantRequestCounts.get(clientAddress);
    if (rateLimit && rateLimit.resetAt > now && rateLimit.count >= 10) {
      res.status(429).json({ error: "Limite temporaire atteinte. Réessayez dans quelques minutes." });
      return;
    }
    if (!rateLimit || rateLimit.resetAt <= now) {
      assistantRequestCounts.set(clientAddress, { count: 1, resetAt: now + 5 * 60 * 1000 });
    } else {
      rateLimit.count += 1;
    }
    if (assistantRequestCounts.size > 1000) {
      for (const [address, entry] of assistantRequestCounts) {
        if (entry.resetAt <= now) assistantRequestCounts.delete(address);
      }
    }

    const result = await requestBotanyReply(req.body.messages, req.body.imageDataUrl);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.set("Cache-Control", "no-store").json({ reply: result.reply });
  });

  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
