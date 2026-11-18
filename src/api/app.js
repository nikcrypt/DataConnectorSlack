import express from "express";
import helmet from "helmet";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { loadApiConfig } from "./config.js";
import { requestContext, sendError, notFound, errorHandler } from "./middleware.js";
import { createAuthRouter } from "./auth/router.js";
import { requireAuth } from "./auth/requireAuth.js";
import { createDashboardRouter } from "./dashboard/router.js";
import { createExtractionsRouter } from "./extractions/router.js";
import { createConnectionsRouter } from "./connections/router.js";

export function createApp(config = loadApiConfig(), auth, authConfig, database) {
  if (!auth || !authConfig) throw new Error("API authentication must be initialized before creating the app.");
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(helmet());

  const allowedOrigins = new Set(config.corsOrigins);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      const error = new Error("Frontend origin is not allowed.");
      error.code = "CORS_ORIGIN_DENIED";
      callback(error);
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Request-ID", "Retry-After", "RateLimit", "RateLimit-Policy"],
    credentials: true,
    preflightContinue: true,
    maxAge: 600,
  }));

  app.use(rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler(req, res) {
      sendError(res, 429, "RATE_LIMIT_EXCEEDED", "Too many requests. Try again later.");
    },
  }));

  app.use((req, res, next) => {
    if (req.method === "OPTIONS") return res.sendStatus(204);
    const hasBody = Number(req.headers["content-length"] || 0) > 0
      || req.headers["transfer-encoding"] !== undefined;
    if (hasBody && !req.is("application/json")) {
      return sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Use Content-Type: application/json.");
    }
    next();
  });
  app.use(express.json({ limit: config.bodyLimitBytes, strict: true, inflate: false }));

  app.get("/api/v1/health", (req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.use("/api/v1/auth", createAuthRouter(auth, authConfig, config.corsOrigins));
  const authenticate = requireAuth(auth, authConfig);
  app.use("/api/v1/dashboard", authenticate, createDashboardRouter(database));
  app.use("/api/v1/extractions", authenticate, createExtractionsRouter());
  app.use("/api/v1/connections", authenticate, createConnectionsRouter());

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
