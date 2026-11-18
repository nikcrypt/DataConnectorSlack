import { authenticate, isValidEmail, loadUsers } from "../../settings/rbac.js";
import { loadAuthConfig } from "../config.js";
import { createSessionStore } from "./sessionStore.js";

export async function createAuthService(config = loadAuthConfig()) {
  async function readUsers() {
    try {
      return await loadUsers({ initialize: false, filePath: config.usersFile });
    } catch {
      const error = new Error("Local authentication requires an existing users file with valid hashed accounts. Check API_AUTH_USERS_FILE.");
      error.code = "AUTH_CONFIGURATION_ERROR";
      throw error;
    }
  }

  // Validate provisioning before allocating a session store. Never seed accounts here.
  await readUsers();
  const sessions = await createSessionStore(config);

  async function authenticateCredentials(email, password) {
    if (!isValidEmail(email)
      || typeof password !== "string" || !password.length || Buffer.byteLength(password, "utf8") > 1024) {
      const error = new Error("Provide a valid email (up to 254 characters) and a non-empty password (up to 1024 bytes).");
      error.code = "INVALID_LOGIN_INPUT";
      throw error;
    }
    const users = await readUsers();
    return authenticate(email, password, { users, loginField: "email" });
  }

  return { authenticateCredentials, sessions };
}
