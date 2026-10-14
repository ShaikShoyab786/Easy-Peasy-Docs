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

const DOCUMENT_CONTEXT_ONLY_INSTRUCTION =
  "Answer the user's question using only the supplied document evidence. Do not use outside knowledge, assumptions, or other conversation details as evidence. If the evidence does not contain the answer, say that it is not specified in the document. Do not guess.";

export type GrokChatAttachment = {
  buffer: Uint8Array;
  filename: string;
  mimeType: string;
};

export type GrokInputAttachment =
  | { type: "input_file"; file_id: string }
  | { type: "input_image"; image_url: string };

const CAPACITY_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
const CAPACITY_RETRY_MESSAGE =
  "xAI servers are experiencing high load. Retrying in a moment...";

export class GrokChatError extends Error {
  constructor(
    message: string,
    readonly statusCode: 502 | 503,
    readonly upstreamStatus?: number,
    readonly retryableCapacity = false,
  ) {
    super(message);
    this.name = "GrokChatError";
  }
}

export async function prepareGrokAttachments(
  apiKey: string,
  attachments: GrokChatAttachment[],
  signal?: AbortSignal,
  keepFilesPermanently = false,
): Promise<{ parts: GrokInputAttachment[]; uploadedFileIds: string[] }> {
  const parts: GrokInputAttachment[] = [];
  const uploadedFileIds: string[] = [];

  try {
    for (const attachment of attachments) {
      if (attachment.mimeType.startsWith("image/")) {
        parts.push({
          type: "input_image",
          image_url: `data:${attachment.mimeType};base64,${Buffer.from(attachment.buffer).toString("base64")}`,
        });
        continue;
      }

      const form = new FormData();
      // Omit expires_after for Knowledge Hub files so xAI retains them permanently.
      if (!keepFilesPermanently) form.append("expires_after", "3600");
      form.append("purpose", "assistants");
      form.append(
        "file",
        new Blob([new Uint8Array(attachment.buffer)], { type: attachment.mimeType }),
        attachment.filename,
      );

      let response: Response;
      try {
        response = await fetch(`${XAI_API_BASE}/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
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
            ? "An attachment took too long to upload. Please try again."
            : "The assistant could not upload an attachment. Please try again.",
          503,
        );
      }

      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new GrokChatError(
          response.status === 429
            ? "The assistant is busy right now. Please try again shortly."
            : "The assistant could not process an attachment. Please try again.",
          response.status >= 500 || response.status === 429 ? 503 : 502,
          response.status,
        );
      }

      const fileId =
        isRecord(payload) && typeof payload.id === "string" ? payload.id : null;
      if (!fileId) {
        throw new GrokChatError(
          "The assistant returned an invalid attachment reference. Please try again.",
          502,
        );
      }
      uploadedFileIds.push(fileId);
      parts.push({ type: "input_file", file_id: fileId });
    }
  } catch (error) {
    await deleteGrokAttachments(apiKey, uploadedFileIds);
    throw error;
  }

  return { parts, uploadedFileIds };
}

export async function uploadGrokFile(
  apiKey: string,
  attachment: GrokChatAttachment,
  signal?: AbortSignal,
): Promise<string> {
  const uploaded = await prepareGrokAttachments(apiKey, [attachment], signal, true);
  const fileId = uploaded.uploadedFileIds[0];
  if (!fileId) {
    throw new GrokChatError(
      "The assistant returned an invalid attachment reference. Please try again.",
      502,
    );
  }
  return fileId;
}

export async function deleteGrokAttachments(
  apiKey: string,
  fileIds: string[],
): Promise<number> {
  const results = await Promise.allSettled(
    fileIds.map((fileId) =>
      fetch(`${XAI_API_BASE}/files/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      }),
    ),
  );

  return results.filter(
    (result) => result.status === "rejected" || !result.value.ok,
  ).length;
}

function modelInput(
  history: AssistantHistoryMessage[],
  attachments: GrokInputAttachment[],
  documentContextOnly = false,
  documentContext?: string,
): Array<{
  role: AssistantHistoryMessage["role"] | "developer";
  content: string | Array<{ type: string; text?: string; file_id?: string; image_url?: string }>;
}> {
  let latestUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  const messages = history.map((message, index) =>
    attachments.length > 0 && index === latestUserIndex
      ? {
          role: message.role,
          content: [
            { type: "input_text", text: message.content },
            ...attachments,
          ],
        }
      : message,
  );
  return documentContextOnly
    ? [{
        role: "developer",
        content: documentContext
          ? `${DOCUMENT_CONTEXT_ONLY_INSTRUCTION}\n\nRetrieved document passages (with source page where available):\n${documentContext}`
          : DOCUMENT_CONTEXT_ONLY_INSTRUCTION,
      }, ...messages]
    : messages;
}

function extractXaiErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.code === "string") return payload.code;
  if (isRecord(payload.error) && typeof payload.error.code === "string") {
    return payload.error.code;
  }
  if (
    isRecord(payload.response) &&
    isRecord(payload.response.error) &&
    typeof payload.response.error.code === "string"
  ) {
    return payload.response.error.code;
  }
  return undefined;
}

function extractXaiStatus(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  const response = isRecord(payload.response) ? payload.response : undefined;
  const error = isRecord(payload.error) ? payload.error : undefined;
  const nestedError =
    response && isRecord(response.error) ? response.error : undefined;
  for (const value of [
    payload.status,
    payload.status_code,
    error?.status,
    error?.status_code,
    response?.status_code,
    nestedError?.status,
    nestedError?.status_code,
  ]) {
    const status = typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value)
        ? Number(value)
        : undefined;
    if (status !== undefined) return status;
  }
  return undefined;
}

function isRetryableCapacityError(status: number, payload: unknown): boolean {
  if (status === 429) return true;
  const message = [
    extractXaiErrorMessage(payload) ?? "",
    extractXaiErrorCode(payload) ?? "",
  ].join(" ");
  return /model.{0,40}at capacity|capacity.{0,40}model|model_capacity|overloaded|rate[_ -]?limit|too many requests/i.test(message);
}

type CapacityRetryState = { retries: number };

async function waitForCapacityRetry(
  retryState: CapacityRetryState,
  signal: AbortSignal | undefined,
  onCapacityRetry?: (retryNumber: number, message: string) => void,
): Promise<boolean> {
  if (retryState.retries >= CAPACITY_RETRY_DELAYS_MS.length) return false;

  const retryNumber = retryState.retries + 1;
  onCapacityRetry?.(retryNumber, CAPACITY_RETRY_MESSAGE);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, CAPACITY_RETRY_DELAYS_MS[retryState.retries]);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException("The chat stream was aborted.", "AbortError"));
    };
    if (!signal) return;
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
  retryState.retries += 1;
  return true;
}

async function fetchResponseWithCapacityRetry(
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  onCapacityRetry?: (retryNumber: number, message: string) => void,
  retryState: CapacityRetryState = { retries: 0 },
): Promise<Response> {
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${XAI_API_BASE}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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

    if (response.ok) return response;
    const failurePayload: unknown = await response.clone().json().catch(() => null);
    if (!isRetryableCapacityError(response.status, failurePayload)) return response;
    if (!(await waitForCapacityRetry(retryState, signal, onCapacityRetry))) {
      throw new GrokChatError(
        "xAI servers are still experiencing high load or rate limits. Please try again shortly.",
        503,
        response.status,
      );
    }
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
  if (isRecord(payload.response)) {
    const responseError = payload.response.error;
    if (typeof responseError === "string") return responseError;
    if (isRecord(responseError) && typeof responseError.message === "string") {
      return responseError.message;
    }
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
  attachments: GrokInputAttachment[] = [],
  documentContextOnly = false,
  onCapacityRetry?: (retryNumber: number, message: string) => void,
  documentContext?: string,
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

  const response = await fetchResponseWithCapacityRetry(
    apiKey,
    {
      model: discovery.model,
      input: modelInput(history, attachments, documentContextOnly, documentContext),
      store: false,
    },
    undefined,
    onCapacityRetry,
  );

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new GrokChatError(
      response.status >= 500 || response.status === 401 || response.status === 403
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
  attachments: GrokInputAttachment[] = [],
  documentContextOnly = false,
  onCapacityRetry?: (retryNumber: number, message: string) => void,
  documentContext?: string,
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

  const retryState: CapacityRetryState = { retries: 0 };
  for (;;) {
    const response = await fetchResponseWithCapacityRetry(
      apiKey,
      {
        model: discovery.model,
        input: modelInput(history, attachments, documentContextOnly, documentContext),
        store: false,
        stream: true,
      },
      signal,
      onCapacityRetry,
      retryState,
    );

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
      const upstreamStatus = extractXaiStatus(payload);
      const retryableCapacity =
        reply.length === 0 &&
        isRetryableCapacityError(upstreamStatus ?? 0, payload);
      throw new GrokChatError(
        extractXaiErrorMessage(payload) ??
          "The assistant could not finish the reply. Please try again.",
        retryableCapacity ? 503 : 502,
        upstreamStatus,
        retryableCapacity,
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
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof GrokChatError && error.retryableCapacity) {
      if (await waitForCapacityRetry(retryState, signal, onCapacityRetry)) {
        continue;
      }
      throw new GrokChatError(
        "xAI servers are still experiencing high load or rate limits. Please try again shortly.",
        503,
        error.upstreamStatus,
      );
    }
    throw error;
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
}

export { XAI_API_BASE };
