import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express, {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { ExtractPdfDocumentResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const execFileAsync = promisify(execFile);
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_PROCESSING_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const bodyParser = express.raw({
  type: "application/pdf",
  limit: MAX_PDF_BYTES,
});
const extractorPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "scripts/extract_pdf.py",
);

type ExtractorResponse =
  | {
      error: string;
      status: number;
    }
  | {
      pageCount: number;
      extractedText: string;
      blocks: unknown[];
      mainContentStart: {
        confidence: "high" | "review" | "not_found";
        candidates: {
          sequence: number;
          pageIndex: number;
          offset: number;
          heading: string;
        }[];
      };
      summary: {
        skippedIndexPages: number;
        removedPageNumberLines: number;
        removedAuthorBylines: number;
        imageCount: number;
        tableCount: number;
      };
    };

function safeFileName(rawFileName: string | undefined): string {
  const sanitized = (rawFileName ?? "document.pdf")
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  return sanitized || "document.pdf";
}

function parsePdfBody(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  bodyParser(req, res, (error?: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (
      error instanceof Error &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      res.status(413).json({ error: "This PDF is larger than the 12 MB limit." });
      return;
    }

    res.status(400).json({ error: "The PDF upload could not be read." });
  });
}

router.post(
  "/documents/extract",
  parsePdfBody,
  async (req, res): Promise<void> => {
    if (!req.is("application/pdf") || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Choose a PDF file to extract." });
      return;
    }

    const pdfBuffer = req.body as Buffer;
    if (
      pdfBuffer.length === 0 ||
      !pdfBuffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))
    ) {
      res.status(400).json({ error: "This file is not a valid PDF." });
      return;
    }

    const fileName = safeFileName(req.header("x-file-name"));
    let temporaryDirectory: string | undefined;

    try {
      temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "plain-language-lab-"),
      );
      const inputPath = path.join(temporaryDirectory, "document.pdf");
      await writeFile(inputPath, pdfBuffer, { flag: "wx", mode: 0o600 });

      const { stdout } = await execFileAsync(
        "python3",
        [extractorPath, inputPath],
        {
          timeout: MAX_PROCESSING_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
      );

      const extracted = JSON.parse(stdout.trim()) as ExtractorResponse;
      if ("error" in extracted) {
        const status =
          extracted.status === 400 ||
          extracted.status === 413 ||
          extracted.status === 422
            ? extracted.status
            : 422;
        res.status(status).json({ error: extracted.error });
        return;
      }

      const response = ExtractPdfDocumentResponse.parse({
        fileName,
        ...extracted,
      });
      res.json(response);
    } catch (error) {
      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;

      if (errorCode === "ETIMEDOUT") {
        res.status(422).json({
          error: "This PDF took too long to inspect. Try a shorter PDF.",
        });
        return;
      }

      if (errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        res.status(413).json({
          error: "This PDF contains too much extracted content to preview at once.",
        });
        return;
      }

      req.log.error({ err: error }, "PDF extraction failed");
      res.status(422).json({
        error: "This PDF could not be processed. Try another PDF.",
      });
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          (error: unknown) => {
            req.log.warn({ err: error }, "Could not remove temporary PDF files");
          },
        );
      }
    }
  },
);

export default router;
