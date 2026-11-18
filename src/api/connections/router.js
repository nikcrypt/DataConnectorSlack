import { Router } from "express";
import { sendError } from "../middleware.js";

export function createConnectionsRouter() {
  const router = Router();

  router.post("/", (req, res) => {
    return sendError(res, 501, "NOT_IMPLEMENTED", "Connection registration is not implemented yet.");
  });

  return router;
}
