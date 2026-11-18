import { sendError } from "../middleware.js";

export function readSessionToken(req, cookieName) {
  const cookies = (req.headers.cookie || "").split(";");
  const matches = cookies.map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(cookieName.length + 1);
  return /^[a-f0-9]{48}$/.test(token) ? token : null;
}

export function requireAuth(auth, config) {
  return async function authenticateRequest(req, res, next) {
    const token = readSessionToken(req, config.cookieName);
    const session = await auth.sessions.getSession(token);
    if (!session) {
      return sendError(res, 401, "UNAUTHENTICATED", "Please sign in to continue.");
    }
    res.locals.session = session;
    next();
  };
}
