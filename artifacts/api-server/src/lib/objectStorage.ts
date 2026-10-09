import { randomUUID } from "crypto";
import { Readable } from "stream";
import { File, Storage } from "@google-cloud/storage";

import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectPermission,
  type ObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
export const KNOWLEDGE_DOCUMENT_UPLOAD_URL_TTL_SECONDS = 15 * 60;

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in Object Storage and set PUBLIC_OBJECT_SEARCH_PATHS.",
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in Object Storage and set PRIVATE_OBJECT_DIR.",
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const { bucketName, objectName } = parseObjectPath(
        `${searchPath}/${filePath}`,
      );
      const file = objectStorageClient.bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }
    return null;
  }

  async downloadObject(
    file: File,
    cacheTtlSec = 3600,
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";
    const webStream = Readable.toWeb(file.createReadStream()) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type":
        (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
      "X-Content-Type-Options": "nosniff",
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }
    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const { bucketName, objectName } = parseObjectPath(
      `${privateObjectDir}/uploads/${objectId}`,
    );
    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  async getKnowledgeDocumentUploadTarget(
    ownerId: string,
    documentId: string,
  ): Promise<{ uploadUrl: string; objectPath: string }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(ownerId)) {
      throw new Error("Invalid authenticated user identifier.");
    }
    const relativePath = `uploads/knowledge-hub/${ownerId}/${documentId}`;
    const { bucketName, objectName } = parseObjectPath(
      `${this.getPrivateObjectDir()}/${relativePath}`,
    );
    const uploadUrl = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: KNOWLEDGE_DOCUMENT_UPLOAD_URL_TTL_SECONDS,
    });
    return { uploadUrl, objectPath: `/objects/${relativePath}` };
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }
    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const { bucketName, objectName } = parseObjectPath(
      `${entityDir}${parts.slice(1).join("/")}`,
    );
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return file;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const rawObjectPath = new URL(rawPath).pathname;
    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }
    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }
    return `/objects/${rawObjectPath.slice(objectEntityDir.length)}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }
    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }
  return {
    bucketName: pathParts[1],
    objectName: pathParts.slice(2).join("/"),
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL (status ${response.status}); verify the Replit Object Storage setup.`,
    );
  }
  const result = (await response.json()) as { signed_url?: string };
  if (!result.signed_url) {
    throw new Error("Object Storage returned no signed URL.");
  }
  return result.signed_url;
}
