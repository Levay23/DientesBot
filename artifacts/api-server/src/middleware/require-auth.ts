import type { Request, Response, NextFunction } from "express";
import { extractToken, verifyToken } from "../routes/auth";

export type AuthedRequest = Request & { userId: number };

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  let userId = token ? verifyToken(token) : null;
  if (!userId) {
    userId = (req.session as { userId?: number }).userId ?? null;
  }
  if (!userId) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }
  (req as AuthedRequest).userId = userId;
  next();
}

export function getUserId(req: Request): number {
  return (req as AuthedRequest).userId;
}
