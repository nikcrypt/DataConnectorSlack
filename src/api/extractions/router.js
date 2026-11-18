import { Router } from "express";

export function createExtractionsRouter() {
  const router = Router();

  router.get("/", (req, res) => {
    res.status(200).json({
      data: { items: [], nextCursor: null, hasMore: false },
      requestId: res.locals.requestId,
    });
  });

  router.get("/:runId", (req, res) => {
    res.status(200).json({
      data: null,
      requestId: res.locals.requestId,
    });
  });

  return router;
}
