export type AssistantRole = "user" | "assistant";
export type AssistantMessage = { role: AssistantRole; content: string };
export const MAX_DIAGNOSTIC_IMAGE_DATA_URL_LENGTH = 5_500_000;

type AssistantResult = { ok: true; reply: string } | { ok: false; status: number; error: string };

export function isAssistantMessages(value: unknown): value is { messages: AssistantMessage[]; imageDataUrl?: string } {
  if (!value || typeof value !== "object" || !("messages" in value) || !Array.isArray(value.messages)) return false;
  const messages: unknown[] = value.messages;
  const hasValidImage = !("imageDataUrl" in value) || value.imageDataUrl === undefined
    || (typeof value.imageDataUrl === "string" && isDiagnosticImageDataUrl(value.imageDataUrl));
  return hasValidImage && messages.length > 0 && messages.length <= 12 && messages.every((message) =>
    Boolean(message && typeof message === "object" && "role" in message && "content" in message
      && (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string" && message.content.trim().length > 0 && message.content.length <= 2000));
}

function isDiagnosticImageDataUrl(value: string) {
  return value.length <= MAX_DIAGNOSTIC_IMAGE_DATA_URL_LENGTH
    && /^data:image\/(?:jpeg|png|webp);base64,(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(value);
}

function getAssistantReply(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("choices" in value) || !Array.isArray(value.choices)) return null;
  const choice = value.choices[0];
  if (!choice || typeof choice !== "object" || !("message" in choice)) return null;
  const message = choice.message;
  if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") return null;
  return message.content.trim() || null;
}

export async function requestBotanyReply(messages: AssistantMessage[], imageDataUrl?: string): Promise<AssistantResult> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 503, error: "Assistant IA indisponible : configurez AI_API_KEY sur le serveur." };
  }

  let upstream: Response;
  try {
    upstream = await fetch(process.env.AI_API_URL ?? "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: process.env.AI_MODEL ?? "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "Tu es un assistant expert en botanique et horticulture responsable. Réponds en français, clairement et avec nuance. Distingue les faits vérifiés des hypothèses, pose des questions de clarification si le contexte manque et ne prétends pas diagnostiquer avec certitude. Pour toute plante, privilégie les pratiques légales, les sources officielles, la sécurité des personnes et des animaux, et les recommandations adaptées au contexte fourni. N’invente ni sources ni certitudes; indique quand l’utilisateur doit consulter un botaniste, un laboratoire ou une source réglementaire locale. Lorsqu’une image est jointe pour un diagnostic, examine les parties visibles (silhouette et stade apparent, feuilles/tiges/fleurs/fruits, symptômes et répartition, nuisibles visibles), puis donne les indices observables, 2 à 4 causes possibles classées avec leur degré d’incertitude, les vérifications simples et prudentes à faire, des mesures immédiates à faible risque et les signes d’alerte justifiant l’aide d’un spécialiste. Ne déduis jamais une carence précise ou un pathogène avec certitude d’une photo seule et ne recommande pas de pesticide sans identification fiable et vérification de l’étiquette et de la réglementation locale. Si du texte apparaît dans l’image (étiquette, notes, mesures), retranscris-le sous la rubrique « Texte lu (OCR visuel) », marque les passages incertains et demande de vérifier les valeurs importantes; ne prétends pas qu’un OCR séparé a été exécuté. Pour un diagnostic plus fiable, demande si nécessaire des photos nettes de la plante entière et des gros plans recto-verso des feuilles, ainsi que l’espèce, le support, les arrosages récents et les conditions mesurées. Structure ce diagnostic sous les rubriques « Observations visibles », « Texte lu (OCR visuel) », « Causes possibles », « Vérifications utiles », « Actions prudentes » et « Limites du diagnostic ».",
          },
          ...messages.map((message, index) => index === messages.length - 1 && message.role === "user" && imageDataUrl
            ? {
                ...message,
                content: [
                  { type: "text", text: message.content },
                  { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
                ],
              }
            : message),
        ],
      }),
    });
  } catch {
    return { ok: false, status: 502, error: "Le fournisseur IA est injoignable ou a dépassé le délai autorisé." };
  }

  if (!upstream.ok) {
    return { ok: false, status: 502, error: `Le fournisseur IA a refusé la requête (HTTP ${upstream.status}). Vérifiez sa configuration.` };
  }
  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return { ok: false, status: 502, error: "Le fournisseur IA a renvoyé une réponse illisible." };
  }
  const reply = getAssistantReply(payload);
  if (!reply) {
    return { ok: false, status: 502, error: "La réponse du fournisseur IA ne contient aucun texte exploitable." };
  }
  return { ok: true, reply };
}
