import { Router, type IRouter } from "express";
import { SimplifyTextBody, SimplifyTextResponse } from "@workspace/api-zod";

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

    const upstream = await fetch(`${XAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: `${sourceText}\n\n${prompt}\n\nDo not include a section titled "Bottom line."`,
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
