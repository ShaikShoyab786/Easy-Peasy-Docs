const XAI_API_BASE = "https://api.x.ai/v1";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

export type GrokModelDiscovery = {
  model: string | null;
  upstreamStatus?: number;
  upstreamMessage?: string;
  responseKeys?: string[];
  advertisedModels?: string[];
};

export type AssistantHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export class GrokChatError extends Error {
  constructor(
    message: string,
    readonly statusCode: 502 | 503,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "GrokChatError";
  }
}

export function extractXaiErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const error = payload.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload.detail === "string") {
    return payload.detail;
  }

  return undefined;
}

export function extractXaiResponseText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    return null;
  }

  const textParts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (
        isRecord(content) &&
        content.type === "output_text" &&
        typeof content.text === "string"
      ) {
        textParts.push(content.text);
      }
    }
  }

  const result = textParts.join("\n").trim();
  return result.length > 0 ? result : null;
}

function modelVersion(id: string): number[] {
  const match = id.match(/^grok-(\d+(?:\.\d+)?)/i);
  return match
    ? match[1].split(".").map((part) => Number.parseInt(part, 10))
    : [];
}

export async function discoverGrokModel(
  apiKey: string,
): Promise<GrokModelDiscovery> {
  const response = await fetch(`${XAI_API_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const failurePayload: unknown = await response.json().catch(() => null);
    return {
      model: null,
      upstreamStatus: response.status,
      upstreamMessage: extractXaiErrorMessage(failurePayload)?.slice(0, 300),
    };
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return {
      model: null,
      responseKeys: isRecord(payload) ? Object.keys(payload) : [],
    };
  }

  const models = payload.data.filter(
    (item): item is JsonRecord =>
      isRecord(item) &&
      typeof item.id === "string" &&
      item.id.toLowerCase().startsWith("grok-") &&
      !/(image|imagine|video|voice)/i.test(item.id),
  );
  const latestAliasModels = models.filter(
    (model) =>
      Array.isArray(model.aliases) &&
      model.aliases.some(
        (alias) => typeof alias === "string" && alias.endsWith("-latest"),
      ),
  );
  const candidates = latestAliasModels.length > 0 ? latestAliasModels : models;
  candidates.sort((left, right) => {
    const leftVersion = modelVersion(String(left.id));
    const rightVersion = modelVersion(String(right.id));
    for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index += 1) {
      const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  });

  return {
    model: typeof candidates[0]?.id === "string" ? candidates[0].id : null,
    advertisedModels: models
      .slice(0, 10)
      .map((item) => (typeof item.id === "string" ? item.id : "unknown")),
  };
}

const CHAT_SYSTEM_PROMPT = [
  "You are the Easy Peasy Docs assistant.",
  "Help users understand policies and other dense writing in clear, practical language.",
  "Preserve important conditions, exceptions, dates, amounts, and other details.",
  "Answer from the conversation. If a user asks about a document that has not been included in the chat, ask them to paste the relevant text.",
].join(" ");

export async function generateGrokChatReply(
  apiKey: string,
  history: AssistantHistoryMessage[],
): Promise<string> {
  let discovery: GrokModelDiscovery;
  try {
    discovery = await discoverGrokModel(apiKey);
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GrokChatError(
      timedOut
        ? "The assistant service took too long to respond. Please try again."
        : "The assistant service is temporarily unavailable. Please try again.",
      503,
    );
  }

  if (!discovery.model) {
    throw new GrokChatError(
      "The assistant service is temporarily unavailable. Please try again.",
      503,
      discovery.upstreamStatus,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${XAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: discovery.model,
        input: [
          { role: "system", content: CHAT_SYSTEM_PROMPT },
          ...history.map(({ role, content }) => ({ role, content })),
        ],
        store: false,
        max_output_tokens: 1200,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GrokChatError(
      timedOut
        ? "The assistant took too long to reply. Please try again."
        : "The assistant service is temporarily unavailable. Please try again.",
      503,
    );
  }

  if (!response.ok) {
    throw new GrokChatError(
      response.status === 429
        ? "The assistant is busy right now. Please try again shortly."
        : response.status >= 500 || response.status === 401 || response.status === 403
          ? "The assistant service is temporarily unavailable. Please try again."
          : "The assistant could not generate a reply. Please try again.",
      response.status >= 500 ||
        response.status === 401 ||
        response.status === 403 ||
        response.status === 429
        ? 503
        : 502,
      response.status,
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  const reply = extractXaiResponseText(payload);
  if (!reply) {
    throw new GrokChatError(
      "The assistant returned an empty reply. Please try again.",
      502,
    );
  }
  return reply;
}

export { XAI_API_BASE };
