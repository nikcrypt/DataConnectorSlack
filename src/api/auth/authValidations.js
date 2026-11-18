import { sendError } from "../middleware.js";

export function validateAuthOrigin(origins) {
  const allowedOrigins = new Set(origins);
  return function requireTrustedOrigin(req, res, next) {
    if (!allowedOrigins.has(req.get("Origin"))) {
      return sendError(res, 403, "AUTH_ORIGIN_DENIED", "Login and logout require an allowed Origin header.");
    }
    next();
  };
}

export function validateLoginBody(req, res, next) {
  const body = req.body;
  if (!body || Array.isArray(body) || typeof body !== "object"
    || Object.keys(body).some((key) => key !== "email" && key !== "password")) {
    return sendError(res, 400, "INVALID_LOGIN_INPUT", "Provide a JSON object containing only email and password.");
  }
  next();
}

export function validateLogoutBody(req, res, next) {
  if (req.body !== undefined && (!req.body || typeof req.body !== "object"
    || Array.isArray(req.body) || Object.keys(req.body).length !== 0)) {
    return sendError(res, 400, "INVALID_LOGOUT_INPUT", "Logout does not accept request fields.");
  }
  next();
}
