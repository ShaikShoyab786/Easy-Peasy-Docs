export type ChatStreamCompletion = {
  content: string;
  items?: unknown[];
};

type ChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "done"; content: string; items?: unknown[] }
  | { type: "status"; message: string }
  | { type: "error"; error: string };

export async function requestChatStream(
  url: string,
  body: unknown,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
  onUploadProgress?: (percentage: number) => void,
  onStatus?: (message: string) => void,
): Promise<ChatStreamCompletion> {
  const isMultipart = typeof FormData !== "undefined" && body instanceof FormData;
  if (isMultipart) {
    return requestMultipartChatStream(url, body, onDelta, signal, onUploadProgress, onStatus);
  }

  let response: Response;
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };
  headers["Content-Type"] = "application/json";
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(body),
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
    } else if (event.type === "status" && typeof event.message === "string") {
      onStatus?.(event.message);
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

function requestMultipartChatStream(
  url: string,
  body: FormData,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
  onUploadProgress?: (percentage: number) => void,
  onStatus?: (message: string) => void,
): Promise<ChatStreamCompletion> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let responseOffset = 0;
    let lineBuffer = "";
    let dataLines: string[] = [];
    let completion: ChatStreamCompletion | null = null;
    let streamError = "";

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortRequest);
      if (error) reject(error);
      else if (streamError) reject(new Error(streamError));
      else if (!completion) {
        reject(new Error("The connection ended before the reply finished. Your message is still here; try again."));
      } else resolve(completion);
    };
    const abortRequest = () => {
      xhr.abort();
      finish(new Error("The reply was interrupted. Your message is still here; try again."));
    };
    const processEvent = () => {
      if (!dataLines.length) return;
      const data = dataLines.join("\n");
      dataLines = [];
      let event: ChatStreamEvent;
      try {
        event = JSON.parse(data) as ChatStreamEvent;
      } catch {
        finish(new Error("The assistant returned an invalid stream event. Please try again."));
        return;
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
      } else if (event.type === "status" && typeof event.message === "string") {
        onStatus?.(event.message);
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
    const consumeResponse = (final = false) => {
      const text = xhr.responseText.slice(responseOffset);
      responseOffset = xhr.responseText.length;
      lineBuffer += text;
      let newline = lineBuffer.indexOf("\n");
      while (newline >= 0) {
        processLine(lineBuffer.slice(0, newline).replace(/\r$/, ""));
        lineBuffer = lineBuffer.slice(newline + 1);
        newline = lineBuffer.indexOf("\n");
      }
      if (final) {
        if (lineBuffer) processLine(lineBuffer.replace(/\r$/, ""));
        processEvent();
      }
    };

    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onUploadProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onprogress = () => consumeResponse();
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        try {
          const payload: unknown = JSON.parse(xhr.responseText);
          const message = payload && typeof payload === "object" &&
            "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `The assistant request failed (${xhr.status}).`;
          finish(new Error(message));
        } catch {
          finish(new Error(`The assistant request failed (${xhr.status}).`));
        }
        return;
      }
      if (!xhr.getResponseHeader("content-type")?.includes("text/event-stream")) {
        finish(new Error("The assistant connection returned an unexpected response. Please try again."));
        return;
      }
      consumeResponse(true);
      finish();
    };
    xhr.onerror = () => finish(new Error("The assistant connection failed. Please try again."));
    xhr.onabort = () => finish(new Error("The reply was interrupted. Your message is still here; try again."));
    signal.addEventListener("abort", abortRequest, { once: true });
    if (signal.aborted) {
      abortRequest();
      return;
    }
    xhr.send(body);
  });
}
