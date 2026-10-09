export type ChatStreamCompletion = {
  content: string;
  items?: unknown[];
};

type ChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "done"; content: string; items?: unknown[] }
  | { type: "error"; error: string };

export async function requestChatStream(
  url: string,
  body: unknown,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
): Promise<ChatStreamCompletion> {
  let response: Response;
  const isMultipart = typeof FormData !== "undefined" && body instanceof FormData;
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };
  if (!isMultipart) headers["Content-Type"] = "application/json";
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: isMultipart ? body : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new Error("The reply was interrupted. Your message is still here; try again.");
    }
    throw error;
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `The assistant request failed (${response.status}).`;
    throw new Error(message);
  }

  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("The assistant connection returned an unexpected response. Please try again.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let completion: ChatStreamCompletion | null = null;
  let streamError = "";

  const processEvent = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];

    let event: ChatStreamEvent;
    try {
      event = JSON.parse(data) as ChatStreamEvent;
    } catch {
      throw new Error("The assistant returned an invalid stream event. Please try again.");
    }

    if (event.type === "delta" && typeof event.content === "string") {
      onDelta(event.content);
    } else if (
      event.type === "done" &&
      typeof event.content === "string" &&
      (!("items" in event) || Array.isArray(event.items))
    ) {
      completion = { content: event.content, items: event.items };
    } else if (event.type === "error" && typeof event.error === "string") {
      streamError = event.error;
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
    if (field === "data") {
      dataLines.push(separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, ""));
    }
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
    if (signal.aborted) {
      throw new Error("The reply was interrupted. Your message is still here; try again.");
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (streamError) throw new Error(streamError);
  if (!completion) {
    throw new Error("The connection ended before the reply finished. Your message is still here; try again.");
  }
  return completion;
}
