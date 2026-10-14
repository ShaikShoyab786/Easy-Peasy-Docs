import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, knowledgeDocumentsTable } from "@workspace/db";
import { indexKnowledgeDocument, searchKnowledgeDocumentChunks } from "../src/lib/knowledgeDocumentIndex";
import { deleteGrokAttachments, discoverGrokModel, extractXaiResponseText, prepareGrokAttachments } from "../src/lib/xai";

const API = "https://api.x.ai/v1";
const FIXTURE = path.join(process.cwd(), "test/fixtures/knowledge-rag-evaluation.txt");
const CASES = [
  { question: "What was Northstar's net revenue in FY2024?", expected: "$1.84 million" },
  { question: "Which department had the largest FY2025 budget increase, and how much was it?", expected: "Product, $115,000" },
  { question: "What was the employee-retention rate in FY2025?", expected: "Not specified in the report." },
];
const INSTRUCTION =
  "Answer using only the supplied document evidence. If the evidence does not contain the answer, say it is not specified. Do not guess.";

type ResponseResult = {
  answer: string;
  inputTokens: number;
  outputTokens: number;
};
type JudgeResult = { correctness: number; groundedness: number; note: string };
type CaseResult = {
  question: string;
  expected: string;
  rag: ResponseResult & { evidence: string; judge: JudgeResult };
  legacy: ResponseResult & { judge: JudgeResult };
};

async function requestResponse(apiKey: string, model: string, input: unknown[]): Promise<ResponseResult> {
  const response = await fetch(`${API}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, store: false }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`xAI Responses request failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
  }
  const answer = extractXaiResponseText(payload);
  const usage = payload && typeof payload === "object" && "usage" in payload
    ? (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage
    : undefined;
  if (!answer || typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
    throw new Error("xAI response was missing answer text or token usage; evaluation cannot be scored.");
  }
  return { answer, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function parseJudge(answer: string): { correctness: number; groundedness: number; note: string } {
  const json = answer.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`Groundedness judge did not return JSON: ${answer.slice(0, 300)}`);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (
    typeof parsed.correctness !== "number" ||
    typeof parsed.groundedness !== "number" ||
    typeof parsed.note !== "string"
  ) {
    throw new Error("Groundedness judge returned an invalid score.");
  }
  return {
    correctness: Math.max(1, Math.min(5, parsed.correctness)),
    groundedness: Math.max(1, Math.min(5, parsed.groundedness)),
    note: parsed.note,
  };
}

async function judgeAnswer(
  apiKey: string,
  model: string,
  question: string,
  evidence: string,
  answer: string,
): Promise<JudgeResult> {
  const result = await requestResponse(apiKey, model, [
    {
      role: "developer",
      content:
        "Evaluate the answer only against the provided evidence. Score correctness and groundedness from 1 (poor) to 5 (fully supported). Penalize unsupported claims and failure to abstain when evidence is missing. Return only JSON with numeric correctness, numeric groundedness, and a brief note.",
    },
    {
      role: "user",
      content: JSON.stringify({ question, evidence, answer }),
    },
  ]);
  return parseJudge(result.answer);
}

async function main() {
  if (process.env.NODE_ENV === "production" || process.env.RAG_EVAL_ALLOW_DB_WRITE !== "1") {
    throw new Error("Run only against development data, with RAG_EVAL_ALLOW_DB_WRITE=1.");
  }
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) throw new Error("XAI_API_KEY is not configured.");
  const sourceBytes = await readFile(FIXTURE);
  const source = sourceBytes.toString("utf8");
  const discovery = await discoverGrokModel(apiKey);
  if (!discovery.model) throw new Error("No xAI chat model is available for evaluation.");

  const id = randomUUID();
  const ownerId = `rag-eval-${id}`;
  const objectPath = `/evaluation-only/${id}`;
  let uploadedFileIds: string[] = [];
  let documentCreated = false;
  try {
    await db.insert(knowledgeDocumentsTable).values({
      id,
      ownerId,
      fileName: path.basename(FIXTURE),
      contentType: "text/plain",
      byteSize: sourceBytes.byteLength,
      objectPath,
      status: "ready",
    });
    documentCreated = true;

    const legacy = await prepareGrokAttachments(apiKey, [{
      buffer: sourceBytes,
      filename: path.basename(FIXTURE),
      mimeType: "text/plain",
    }]);
    uploadedFileIds = legacy.uploadedFileIds;

    const indexing = await indexKnowledgeDocument({
      apiKey,
      documentId: id,
      ownerId,
      fileName: path.basename(FIXTURE),
      contentType: "text/plain",
      bytes: sourceBytes,
    });

  const legacyFile = legacy.parts.find((part) => part.type === "input_file");
  if (!legacyFile) throw new Error("xAI did not return a temporary legacy file reference.");
  const cases: CaseResult[] = [];
    for (const testCase of CASES) {
      const passages = await searchKnowledgeDocumentChunks({
        apiKey,
        documentId: id,
        ownerId,
        query: testCase.question,
        limit: 8,
      });
      const ragEvidence = passages.map((passage) =>
        `[${passage.contentKind}${passage.sourcePage ? `, page ${passage.sourcePage}` : ""}]\n${passage.content}`,
      ).join("\n\n---\n\n");
      const rag = await requestResponse(apiKey, discovery.model, [
        {
          role: "developer",
          content: ragEvidence
            ? `${INSTRUCTION}\n\nRetrieved document passages (with source page where available):\n${ragEvidence}`
            : INSTRUCTION,
        },
        { role: "user", content: testCase.question },
      ]);
      const legacyResult = await requestResponse(apiKey, discovery.model, [
        { role: "developer", content: INSTRUCTION },
        {
          role: "user",
          content: [
            { type: "input_text", text: testCase.question },
            legacyFile,
          ],
        },
      ]);
      const [ragJudge, legacyJudge] = await Promise.all([
        judgeAnswer(apiKey, discovery.model, testCase.question, ragEvidence, rag.answer),
        judgeAnswer(apiKey, discovery.model, testCase.question, source, legacyResult.answer),
      ]);
      cases.push({
        ...testCase,
        rag: { ...rag, evidence: ragEvidence, judge: ragJudge },
        legacy: { ...legacyResult, judge: legacyJudge },
      });
    }

    const sum = (key: "inputTokens" | "outputTokens", pathName: "rag" | "legacy") =>
      cases.reduce((total, item) => total + item[pathName][key], 0);
    const ragInput = sum("inputTokens", "rag");
    const legacyInput = sum("inputTokens", "legacy");
    const report = {
      model: discovery.model,
      fixture: path.basename(FIXTURE),
      index: indexing,
      cases,
      totals: {
        ragInputTokens: ragInput,
        legacyInputTokens: legacyInput,
        inputTokenSavingsPercent: legacyInput
          ? Math.round((1 - ragInput / legacyInput) * 1000) / 10
          : null,
        ragOutputTokens: sum("outputTokens", "rag"),
        legacyOutputTokens: sum("outputTokens", "legacy"),
        ragAverageCorrectness: cases.reduce((n, item) => n + item.rag.judge.correctness, 0) / cases.length,
        legacyAverageCorrectness: cases.reduce((n, item) => n + item.legacy.judge.correctness, 0) / cases.length,
        ragAverageGroundedness: cases.reduce((n, item) => n + item.rag.judge.groundedness, 0) / cases.length,
        legacyAverageGroundedness: cases.reduce((n, item) => n + item.legacy.judge.groundedness, 0) / cases.length,
      },
      note: "Judge scores are model-assisted; review answers and evidence manually before changing rollout behavior.",
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (uploadedFileIds.length) {
      const failedDeletes = await deleteGrokAttachments(apiKey, uploadedFileIds);
      if (failedDeletes) console.error(`Cleanup: ${failedDeletes} temporary xAI file(s) could not be deleted.`);
    }
    if (documentCreated) await db.delete(knowledgeDocumentsTable).where(
      and(
        eq(knowledgeDocumentsTable.id, id),
        eq(knowledgeDocumentsTable.ownerId, ownerId),
      ),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 1;
});
