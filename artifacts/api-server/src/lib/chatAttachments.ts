import type { Request, RequestHandler } from "express";
import multer from "multer";
import path from "node:path";
import type { GrokChatAttachment } from "./xai";

export const MAX_CHAT_ATTACHMENT_FILES = 3;
export const MAX_CHAT_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

const mimeTypesByExtension: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".csv": ["text/csv", "text/plain", "application/csv"],
  ".jpg": ["image/jpeg", "image/jpg"],
  ".jpeg": ["image/jpeg", "image/jpg"],
  ".png": ["image/png"],
};

const canonicalMimeTypeByExtension: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export class ChatAttachmentError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413,
  ) {
    super(message);
    this.name = "ChatAttachmentError";
  }
}

const parseMultipartFiles = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CHAT_ATTACHMENT_FILE_BYTES,
    files: MAX_CHAT_ATTACHMENT_FILES,
    fields: 3,
    fieldSize: 256 * 1024,
    parts: MAX_CHAT_ATTACHMENT_FILES + 3,
  },
}).array("files", MAX_CHAT_ATTACHMENT_FILES);

export const parseChatAttachmentUploads: RequestHandler = (req, res, next) => {
  parseMultipartFiles(req, res, (error?: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      const tooLarge = [
        "LIMIT_FILE_SIZE",
        "LIMIT_FILE_COUNT",
        "LIMIT_PART_COUNT",
      ].includes(error.code);
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge
          ? "Attach up to three files, each no larger than 10 MB."
          : "The attachment upload is invalid.",
      });
      return;
    }

    next(error);
  });
};

function safeFilename(originalname: string): string {
  const basename = originalname.replace(/\\/g, "/").split("/").pop() ?? "";
  return basename
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 160);
}

function validateFileSignature(
  buffer: Buffer,
  extension: string,
  filename: string,
): void {
  if (extension === ".pdf" && !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new ChatAttachmentError(`${filename} is not a valid PDF file.`, 400);
  }
  if (
    (extension === ".jpg" || extension === ".jpeg") &&
    !(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
  ) {
    throw new ChatAttachmentError(`${filename} is not a valid JPEG image.`, 400);
  }
  if (
    extension === ".png" &&
    !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new ChatAttachmentError(`${filename} is not a valid PNG image.`, 400);
  }
  if ([".txt", ".md", ".csv"].includes(extension)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (text.includes("\0")) throw new Error("Binary content is not supported.");
    } catch {
      throw new ChatAttachmentError(
        `${filename} must contain valid UTF-8 text.`,
        400,
      );
    }
  }
}

export function getChatAttachmentFiles(req: Request): GrokChatAttachment[] {
  const files = Array.isArray(req.files)
    ? (req.files as Express.Multer.File[])
    : [];
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
    throw new ChatAttachmentError(
      "Attachments must total no more than 20 MB.",
      413,
    );
  }

  return files.map((file) => {
    const filename = safeFilename(file.originalname);
    const extension = path.extname(filename).toLowerCase();
    const acceptedMimeTypes = mimeTypesByExtension[extension];
    if (!filename || !acceptedMimeTypes) {
      throw new ChatAttachmentError(
        "Use PDF, TXT, Markdown, CSV, JPG, or PNG files.",
        400,
      );
    }

    const suppliedMimeType = file.mimetype.toLowerCase().split(";")[0];
    if (
      suppliedMimeType &&
      suppliedMimeType !== "application/octet-stream" &&
      !acceptedMimeTypes.includes(suppliedMimeType)
    ) {
      throw new ChatAttachmentError(
        `${filename} does not match its file extension.`,
        400,
      );
    }

    validateFileSignature(file.buffer, extension, filename);
    return {
      buffer: file.buffer,
      filename,
      mimeType: canonicalMimeTypeByExtension[extension],
    };
  });
}
