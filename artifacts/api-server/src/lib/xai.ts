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
  signal?: AbortSignal,
): Promise<GrokModelDiscovery> {
  const response = await fetch(`${XAI_API_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
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
        input: history.map(({ role, content }) => ({ role, content })),
        store: false,
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

export async function streamGrokChatReply(
  apiKey: string,
  history: AssistantHistoryMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let discovery: GrokModelDiscovery;
  try {
    discovery = await discoverGrokModel(apiKey, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
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
        input: history.map(({ role, content }) => ({ role, content })),
        store: false,
        stream: true,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
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
    const failurePayload: unknown = await response.json().catch(() => null);
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

  if (!response.body) {
    throw new GrokChatError(
      "The assistant connection ended before a reply started. Please try again.",
      502,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let reply = "";
  let completed = false;

  const processEvent = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];

    if (data === "[DONE]") {
      completed = true;
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new GrokChatError(
        "The assistant returned an invalid response. Please try again.",
        502,
      );
    }

    if (!isRecord(payload) || typeof payload.type !== "string") return;
    if (
      payload.type === "response.output_text.delta" &&
      typeof payload.delta === "string"
    ) {
      reply += payload.delta;
      onDelta(payload.delta);
      return;
    }
    if (payload.type === "response.completed") {
      completed = true;
      return;
    }
    if (payload.type === "error" || payload.type === "response.failed") {
      throw new GrokChatError(
        extractXaiErrorMessage(payload) ??
          "The assistant could not finish the reply. Please try again.",
        502,
      );
    }
  };

  const processLine = (line: string) => {
    if (!line) {
      processEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== "data") return;
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    dataLines.push(value);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        processLine(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer.replace(/\r$/, ""));
    processEvent();
  } finally {
    reader.releaseLock();
  }

  if (signal?.aborted) {
    throw new DOMException("The chat stream was aborted.", "AbortError");
  }
  if (!completed) {
    throw new GrokChatError(
      "The connection ended before the assistant finished. Please try again.",
      502,
    );
  }
  if (!reply.trim()) {
    throw new GrokChatError(
      "The assistant returned an empty reply. Please try again.",
      502,
    );
  }
  return reply;
}

export { XAI_API_BASE };
