import "dotenv/config";
import { GoogleDriveClient } from "./GoogleDriveClient.js";

const client = GoogleDriveClient.fromEnv();
const tokens = await client.login();
console.log(
  JSON.stringify(
    {
      ok: true,
      scope: tokens.scope || null,
      expiresAt: new Date(tokens.expiresAt).toISOString(),
      savedTo: "data/google-auth.json",
    },
    null,
    2
  )
);
