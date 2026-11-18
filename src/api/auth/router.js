import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { sendError } from "../middleware.js";
import { readSessionToken, requireAuth } from "./requireAuth.js";
import { validateAuthOrigin, validateLoginBody, validateLogoutBody } from "./authValidations.js";

export function createAuthRouter(auth, config, corsOrigins) {
  const router = Router();
  const requireTrustedOrigin = validateAuthOrigin(corsOrigins);
  const { maxAge, ...clearCookieOptions } = config.cookieOptions;

  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimitWindowMs,
    limit: config.loginRateLimitMax,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler(req, res) {
      sendError(res, 429, "LOGIN_RATE_LIMIT_EXCEEDED", "Too many login attempts. Try again later.");
    },
  });

  function sendSession(res, session) {
    return res.status(200).json({
      data: {
        user: {
          username: session.username,
          displayName: session.displayName,
          email: session.email,
          role: session.role,
          permissions: session.permissions,
        },
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      requestId: res.locals.requestId,
    });
  }

  router.post("/login", requireTrustedOrigin, loginLimiter, validateLoginBody, async (req, res) => {
    const user = await auth.authenticateCredentials(req.body.email, req.body.password);
    if (!user) {
      return sendError(res, 401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }

    // Replace this browser's previous session only after credentials are verified.
    await auth.sessions.destroySession(readSessionToken(req, config.cookieName));
    const session = await auth.sessions.createSession(user);
    res.cookie(config.cookieName, session.token, {
      ...config.cookieOptions,
      maxAge: Math.max(0, session.expiresAt - Date.now()),
    });
    return sendSession(res, session);
  });

  router.post("/logout", requireTrustedOrigin, validateLogoutBody, async (req, res) => {
    await auth.sessions.destroySession(readSessionToken(req, config.cookieName));
    res.clearCookie(config.cookieName, clearCookieOptions);
    return res.status(200).json({
      data: { message: "Logged out." },
      requestId: res.locals.requestId,
    });
  });

  router.get("/me", requireAuth(auth, config), (req, res) => sendSession(res, res.locals.session));
  return router;
}
