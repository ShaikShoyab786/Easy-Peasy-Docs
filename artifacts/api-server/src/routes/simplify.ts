import { Router, type IRouter } from "express";
import { SimplifyTextBody, SimplifyTextResponse } from "@workspace/api-zod";
import {
  DocumentSimplificationError,
  getDocumentCharacterCount,
  simplifyDocumentInChunks,
  type DocumentSimplificationProgress,
} from "../lib/document-simplifier";
import { PLAIN_LANGUAGE_OUTPUT_GUIDANCE } from "../lib/plain-language-format";
import {
  createDocumentSimplificationJob,
  DocumentJobCapacityError,
  getDocumentSimplificationJob,
  getDocumentSimplificationJobEventsAfter,
  publishDocumentSimplificationJobEvent,
  setDocumentSimplificationJobStatus,
  subscribeToDocumentSimplificationJob,
  type DocumentSimplificationJobEvent,
} from "../lib/document-simplification-jobs";

const router: IRouter = Router();
const XAI_API_BASE = "https://api.x.ai/v1";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function extractOutputText(payload: unknown): string | null {
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
  const bottomLineHeading = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?bottom[ \t]+line(?:\*\*)?:?(?:\*\*)?[ \t]*$/im.exec(
    result,
  );
  const withoutBottomLine = bottomLineHeading
    ? result.slice(0, bottomLineHeading.index).trim()
    : result;
  return withoutBottomLine.length > 0 ? withoutBottomLine : null;
}

function extractErrorMessage(payload: unknown): string | undefined {
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

function modelVersion(id: string): number[] {
  const match = id.match(/^grok-(\d+(?:\.\d+)?)/i);
  return match
    ? match[1].split(".").map((part) => Number.parseInt(part, 10))
    : [];
}

type ModelDiscovery = {
  model: string | null;
  upstreamStatus?: number;
  upstreamMessage?: string;
  responseKeys?: string[];
  advertisedModels?: string[];
};

async function discoverGrokModel(apiKey: string): Promise<ModelDiscovery> {
  const response = await fetch(`${XAI_API_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const failurePayload: unknown = await response.json().catch(() => null);

    return {
      model: null,
      upstreamStatus: response.status,
      upstreamMessage: extractErrorMessage(failurePayload)?.slice(0, 300),
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

  const model =
    typeof candidates[0]?.id === "string" ? candidates[0].id : null;

  return {
    model,
    advertisedModels: models
      .slice(0, 10)
      .map((item) => (typeof item.id === "string" ? item.id : "unknown")),
  };
}

function sendJobEvent(
  res: import("express").Response,
  event: DocumentSimplificationJobEvent,
): void {
  res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
}

function startDocumentSimplificationWorker({
  jobId,
  apiKey,
  sourceText,
  prompt,
  tables,
  log,
}: {
  jobId: string;
  apiKey: string;
  sourceText: string;
  prompt: string;
  tables: NonNullable<ReturnType<typeof SimplifyTextBody.parse>["tables"]>;
  log: { warn: (context: object, message: string) => void; error: (context: object, message: string) => void };
}): void {
  void (async () => {
    let completedSections = 0;
    let totalSections = 0;
    try {
      publishDocumentSimplificationJobEvent(jobId, {
        type: "stage",
        stage: "model",
        message: "Preparing the rewrite.",
      });
      const discovery = await discoverGrokModel(apiKey);
      if (!discovery.model) {
        log.warn(
          {
            upstreamStatus: discovery.upstreamStatus,
            upstreamMessage: discovery.upstreamMessage,
            advertisedModels: discovery.advertisedModels,
          },
          "Could not discover a Grok text model for a PDF job",
        );
        throw new DocumentSimplificationError(
          discovery.upstreamMessage &&
            /incorrect api key|invalid api key/i.test(discovery.upstreamMessage)
            ? "xAI rejected XAI_API_KEY. Check the configured xAI secret."
            : "No Grok text model is available through the xAI API.",
          503,
        );
      }

      publishDocumentSimplificationJobEvent(jobId, {
        type: "stage",
        stage: "rewrite",
        message: "Rewriting the document in ordered sections.",
      });
      const result = await simplifyDocumentInChunks({
        apiKey,
        model: discovery.model,
        sourceText,
        prompt,
        tables,
        onProgress: (event: DocumentSimplificationProgress) => {
          if (event.type === "started") {
            totalSections = event.totalSections;
          }
          if (event.type === "section_completed") {
            completedSections = event.completedSections;
          }
          publishDocumentSimplificationJobEvent(jobId, event);
        },
      });

      publishDocumentSimplificationJobEvent(jobId, {
        type: "completed",
        result: result.result,
        tables: result.tables,
        unchangedTables: result.unchangedTables,
        model: discovery.model,
      });
      setDocumentSimplificationJobStatus(jobId, "completed");
    } catch (error) {
      const message =
        error instanceof DocumentSimplificationError
          ? error.message
          : error instanceof Error && error.name === "TimeoutError"
            ? "Grok took too long to prepare this rewrite. Please try again."
            : "Could not complete the PDF rewrite. Check your connection and try again.";
      log.error(
        {
          err: error,
          jobId,
          completedSections,
          totalSections,
        },
        "PDF simplification job failed",
      );
      publishDocumentSimplificationJobEvent(jobId, {
        type: "failed",
        message,
        completedSections,
        totalSections,
      });
      setDocumentSimplificationJobStatus(jobId, "failed");
    }
  })();
}

router.post("/documents/simplification-jobs", (req, res): void => {
  const parsed = SimplifyTextBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.sourceText.trim() || !parsed.data.prompt.trim()) {
    res.status(400).json({ error: "Add text and a prompt before generating." });
    return;
  }

  const { sourceText, prompt } = parsed.data;
  const tables = parsed.data.tables ?? [];
  if (getDocumentCharacterCount(sourceText, tables) > 100_000) {
    res.status(413).json({
      error: "The prepared PDF content exceeds the 100,000-character limit.",
    });
    return;
  }

  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) {
    res.status(503).json({
      error: "Add XAI_API_KEY to Replit Secrets, then retry generation.",
    });
    return;
  }

  let job;
  try {
    job = createDocumentSimplificationJob();
  } catch (error) {
    if (error instanceof DocumentJobCapacityError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }

  const log = req.log;
  res.status(202).json({ jobId: job.id, status: "queued" });
  setImmediate(() => {
    startDocumentSimplificationWorker({
      jobId: job.id,
      apiKey,
      sourceText,
      prompt,
      tables,
      log,
    });
    setDocumentSimplificationJobStatus(job.id, "running");
  });
});

router.get("/documents/simplification-jobs/:jobId/events", (req, res): void => {
  const jobId = Array.isArray(req.params.jobId)
    ? req.params.jobId[0]
    : req.params.jobId;
  const job = getDocumentSimplificationJob(jobId);
  if (!job) {
    res.status(404).json({ error: "This simplification job was not found or has expired." });
    return;
  }

  const lastEventHeader = req.get("Last-Event-ID");
  const parsedLastEventId = Number.parseInt(lastEventHeader ?? "0", 10);
  let cursor = Number.isFinite(parsedLastEventId) && parsedLastEventId > 0
    ? parsedLastEventId
    : 0;
  let closed = false;
  let buffering = true;
  const pending: DocumentSimplificationJobEvent[] = [];
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 2500\n\n");

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
  };
  const writeEvent = (event: DocumentSimplificationJobEvent) => {
    if (closed || event.id <= cursor) return;
    sendJobEvent(res, event);
    cursor = event.id;
    if (event.type === "completed" || event.type === "failed") {
      cleanup();
      res.end();
    }
  };
  unsubscribe = subscribeToDocumentSimplificationJob(jobId, (event) => {
    if (buffering) pending.push(event);
    else writeEvent(event);
  });

  for (const event of getDocumentSimplificationJobEventsAfter(jobId, cursor)) {
    if (closed) break;
    sendJobEvent(res, event);
    cursor = event.id;
  }
  buffering = false;
  pending.sort((left, right) => left.id - right.id).forEach(writeEvent);

  if (!closed && (job.status === "completed" || job.status === "failed")) {
    cleanup();
    res.end();
  } else if (!closed) {
    heartbeat = setInterval(() => {
      if (!closed) res.write(": keep-alive\n\n");
    }, 15_000);
    res.on("close", cleanup);
  }
});

router.post("/simplify", async (req, res): Promise<void> => {
  const parsed = SimplifyTextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Add text and a prompt before generating." });
    return;
  }

  const { sourceText, prompt } = parsed.data;
  if (!sourceText.trim() || !prompt.trim()) {
    res.status(400).json({ error: "Add text and a prompt before generating." });
    return;
  }

  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) {
    res.status(503).json({
      error: "Add XAI_API_KEY to Replit Secrets, then retry generation.",
    });
    return;
  }

  try {
    const discovery = await discoverGrokModel(apiKey);
    if (!discovery.model) {
      req.log.warn(
        {
          upstreamStatus: discovery.upstreamStatus,
          upstreamMessage: discovery.upstreamMessage,
          responseKeys: discovery.responseKeys,
          advertisedModels: discovery.advertisedModels,
        },
        "Could not discover a Grok text model",
      );
      res.status(503).json({
        error:
          discovery.upstreamMessage &&
          /incorrect api key|invalid api key/i.test(discovery.upstreamMessage)
            ? "xAI rejected XAI_API_KEY. Replace it with a key from the xAI Console API Keys page."
            : "No Grok text model is available through the xAI API.",
      });
      return;
    }
    const model = discovery.model;

    if (parsed.data.documentMode) {
      try {
        const documentResult = await simplifyDocumentInChunks({
          apiKey,
          model,
          sourceText,
          prompt,
          tables: parsed.data.tables ?? [],
        });
        res.json(
          SimplifyTextResponse.parse({
            ...documentResult,
            model,
          }),
        );
      } catch (error) {
        if (error instanceof DocumentSimplificationError) {
          req.log.warn(
            { statusCode: error.statusCode },
            "PDF simplification could not produce a complete safe result",
          );
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    const upstream = await fetch(`${XAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: `${sourceText}\n\nUSER REQUEST:\n${prompt}\n\n${PLAIN_LANGUAGE_OUTPUT_GUIDANCE}`,
        store: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok) {
      const failurePayload: unknown = await upstream.json().catch(() => null);
      const upstreamMessage = extractErrorMessage(failurePayload);
      req.log.warn(
        { upstreamStatus: upstream.status, upstreamMessage },
        "Grok API returned an unsuccessful response",
      );

      if (upstream.status === 429) {
        res
          .status(503)
          .json({ error: "Grok is rate-limited right now. Try again shortly." });
        return;
      }

      if (
        upstream.status === 401 ||
        upstream.status === 403 ||
        (upstreamMessage && /incorrect api key|invalid api key/i.test(upstreamMessage))
      ) {
        res.status(503).json({
          error:
            "xAI rejected XAI_API_KEY. Replace it with a key from the xAI Console API Keys page.",
        });
        return;
      }

      res.status(502).json({
        error: "Grok could not generate a result. Try again or shorten the text.",
      });
      return;
    }

    const payload: unknown = await upstream.json();
    const result = extractOutputText(payload);
    if (!result) {
      req.log.error("Grok API response did not contain generated text");
      res.status(502).json({
        error: "Grok returned an empty result. Please try again.",
      });
      return;
    }

    res.json(SimplifyTextResponse.parse({ result, model }));
  } catch (error) {
    req.log.error({ err: error }, "Grok API request failed");

    if (error instanceof Error && error.name === "TimeoutError") {
      res
        .status(503)
        .json({ error: "Grok took too long to respond. Please try again." });
      return;
    }

    res.status(503).json({
      error: "Could not reach Grok. Check your connection and try again.",
    });
  }
});

export default router;
