import { Router } from "express";
import { requireDatabase } from "../middleware.js";
import { getDashboardSummary } from "./dashboardService.js";

export function createDashboardRouter(database) {
  const router = Router();

  router.get("/summary", requireDatabase(database), async (req, res) => {
    const summary = await getDashboardSummary(database);
    res.status(200).json({
      data: summary,
      requestId: res.locals.requestId,
    });
  });

  router.get("/activity", (req, res) => {
    res.status(200).json({
      data: { series: [], buckets: [] },
      requestId: res.locals.requestId,
    });
  });

  return router;
}
