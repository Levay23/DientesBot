import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { isSystemMaintenance, MAINTENANCE_MESSAGE, MAINTENANCE_TITLE } from "../lib/maintenance";

const router: IRouter = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isSystemMaintenance()) return next();

  const path = req.path;
  if (path === "/healthz" || path.startsWith("/healthz")) return next();

  res.status(503).json({
    error: MAINTENANCE_TITLE,
    message: MAINTENANCE_MESSAGE,
    maintenance: true,
  });
});

export default router;
