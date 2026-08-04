import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { LoginBody } from "@workspace/api-zod";
import { createHmac } from "crypto";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function getSecret(): string {
  return process.env.SESSION_SECRET ?? "dientes-fijos-secret-key-2024";
}

// ─── Simple signed token: base64(payload).signature ──────────────────────────
export function createToken(userId: number): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ts: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    
    const expected = createHmac("sha256", getSecret()).update(payload).digest("base64url");
    
    // Simple comparison first to rule out length issues with timingSafeEqual
    if (sig !== expected) return null;

    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof decoded.uid === "number" ? decoded.uid : null;
  } catch (err) {
    console.error("Token verification error:", err);
    return null;
  }
}

export function extractToken(req: any): string | undefined {
  const authHeader = req.headers["authorization"] as string | undefined;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  // Permite <audio>/<img>/<video src="...?token="> que no envían Authorization
  const q = req.query?.token;
  if (typeof q === "string" && q.trim()) return q.trim();
  if (Array.isArray(q) && typeof q[0] === "string") return q[0].trim();
  return undefined;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { email, password } = parsed.data;

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.trim()));
    if (!user || user.passwordHash !== password) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    (req.session as any).userId = user.id;

    const token = createToken(user.id);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt },
      token,
    });
  } catch (err) {
    logger.error({ err, email }, "Error en login — base de datos no disponible");
    res.status(503).json({ error: "Servicio temporalmente no disponible. Intenta de nuevo en unos minutos." });
  }
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  req.session.destroy(() => {});
  res.json({ message: "Logged out" });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const token = extractToken(req);
  let userId = token ? verifyToken(token) : null;
  const viaToken = !!userId;

  if (!userId) {
    userId = (req.session as any).userId as number | undefined ?? null;
  }

  if (!userId) {
    res.status(401).json({ 
      error: "No autorizado", 
      details: token ? "Token inválido o expirado" : "Sesión no encontrada",
      hasToken: !!token
    });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "Usuario no encontrado", viaToken });
    return;
  }

  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt });
});

export default router;
