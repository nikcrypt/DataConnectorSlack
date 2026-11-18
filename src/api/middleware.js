import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export function requestContext(req, res, next) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  res.setHeader("Cache-Control", "no-store");
  let logged = false;

  function logRequest() {
    if (logged) return;
    logged = true;
    // Do not log URLs, headers or bodies: they can contain credentials or JQL.
    console.info(JSON.stringify({
      event: "api_request",
      requestId,
      method: req.method,
      status: res.writableFinished ? res.statusCode : null,
      aborted: !res.writableFinished,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  }

  res.once("finish", logRequest);
  res.once("close", logRequest);
  next();
}

export function sendError(res, status, code, message) {
  return res.status(status).json({
    error: { code, message, requestId: res.locals.requestId },
  });
}

export function requireDatabase(database) {
  return function checkDatabase(req, res, next) {
    if (!database) {
      return sendError(res, 503, "DATABASE_UNAVAILABLE", "This endpoint requires a configured MongoDB database.");
    }
    next();
  };
}

export function notFound(req, res) {
  sendError(res, 404, "NOT_FOUND", "API endpoint not found.");
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    console.error(JSON.stringify({ event: "api_error_after_headers", requestId: res.locals.requestId }));
    res.destroy();
    return;
  }

  if (error.code === "CORS_ORIGIN_DENIED") {
    return sendError(res, 403, "CORS_ORIGIN_DENIED", "This frontend origin is not allowed.");
  }
  if (error.code === "INVALID_LOGIN_INPUT") {
    return sendError(res, 400, "INVALID_LOGIN_INPUT", "Provide a valid email (up to 254 characters) and a non-empty password (up to 1024 bytes).");
  }
  if (error.code === "AUTH_CONFIGURATION_ERROR") {
    console.error(JSON.stringify({ event: "api_auth_configuration_error", requestId: res.locals.requestId }));
    return sendError(res, 503, "AUTH_UNAVAILABLE", "Sign-in is temporarily unavailable. Contact the administrator.");
  }
  if (error.type === "entity.parse.failed") {
    return sendError(res, 400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
  if (error.type === "entity.too.large") {
    return sendError(res, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds the configured size limit.");
  }
  if (error.type === "encoding.unsupported" || error.type === "charset.unsupported") {
    return sendError(res, 415, "UNSUPPORTED_ENCODING", "Use uncompressed JSON with a supported character encoding.");
  }
  if (error.type === "request.aborted" || error.type === "request.size.invalid") {
    return sendError(res, 400, "INVALID_REQUEST", "Request body was incomplete or invalid.");
  }

  // Parser and downstream error messages may contain submitted secrets.
  console.error(JSON.stringify({ event: "api_error", requestId: res.locals.requestId }));
  return sendError(res, 500, "INTERNAL_ERROR", "The request could not be completed.");
}
