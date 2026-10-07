import { Router, type IRouter } from "express";
import { SimplifyTextBody, SimplifyTextResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const GROK_MODEL = "grok-4.7";

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
  return result.length > 0 ? result : null;
}

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

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "The Grok API key is not configured." });
    return;
  }

  try {
    const upstream = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        input: `${sourceText}\n\n${prompt}`,
        store: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!upstream.ok) {
      const failurePayload: unknown = await upstream.json().catch(() => null);
      const errorDetails = isRecord(failurePayload) ? failurePayload.error : null;
      const nestedError = isRecord(errorDetails) ? errorDetails : null;
      const upstreamMessage =
        typeof errorDetails === "string"
          ? errorDetails
          : nestedError && typeof nestedError.message === "string"
            ? nestedError.message
            : isRecord(failurePayload) &&
                typeof failurePayload.message === "string"
              ? failurePayload.message
              : isRecord(failurePayload) &&
                  typeof failurePayload.detail === "string"
                ? failurePayload.detail
                : undefined;

      req.log.warn(
        {
          upstreamStatus: upstream.status,
          upstreamCode:
            nestedError && typeof nestedError.code === "string"
              ? nestedError.code
              : undefined,
          upstreamMessage: upstreamMessage?.slice(0, 300),
        },
        "Grok API returned an unsuccessful response",
      );

      if (upstream.status === 429) {
        res
          .status(503)
          .json({ error: "Grok is rate-limited right now. Try again shortly." });
        return;
      }

      if (upstream.status === 401 || upstream.status === 403) {
        res.status(502).json({
          error: "Grok could not authenticate the request. Check the xAI API key.",
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

    res.json(SimplifyTextResponse.parse({ result, model: GROK_MODEL }));
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
