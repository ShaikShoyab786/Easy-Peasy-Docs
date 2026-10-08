import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";

export type AuthenticatedRequest = Request & { authUserId: string };

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = getAuth(req);
  const candidate = auth?.sessionClaims?.userId || auth?.userId;
  const userId = typeof candidate === "string" ? candidate : null;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  (req as AuthenticatedRequest).authUserId = userId;
  next();
}

export function getAuthenticatedUserId(req: Request): string {
  const userId = (req as Partial<AuthenticatedRequest>).authUserId;
  if (!userId) {
    throw new Error("Authenticated user context is missing.");
  }
  return userId;
}
