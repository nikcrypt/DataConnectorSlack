import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";

const MAGIC = "DCENV1";

const args = process.argv.slice(2);
const command = args[0];

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

async function main() {
  if (command !== "encrypt" && command !== "decrypt") {
    console.log(`Usage:
  npm run env:encrypt
  npm run env:decrypt

Passphrase: type it when asked, or set ENV_MASTER_KEY for that command only.
Do not store the passphrase in .env or in the repo.`);
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(flag("--in") || (command === "encrypt" ? ".env" : ".env.enc"));
  const outputPath = path.resolve(flag("--out") || (command === "encrypt" ? ".env.enc" : ".env"));
  const force = args.includes("--force");

  if (command === "decrypt" && !force && inputPath !== outputPath) {
    const exists = await fileExists(outputPath);
    if (exists) {
      throw new Error(`${path.basename(outputPath)} already exists. Run npm run env:decrypt -- --force to replace it.`);
    }
  }

  const passphrase = await readPassphrase(command);
  const source = await readFile(inputPath);

  if (command === "encrypt") {
    const encrypted = encryptBuffer(source, passphrase);
    await writeFile(outputPath, encrypted);
    console.log(`Encrypted ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);
    console.log("Plain .env is unchanged. Delete it only after you have stored the passphrase somewhere else.");
    return;
  }

  const plain = decryptBuffer(source.toString("utf8"), passphrase);
  await writeFile(outputPath, plain);
  console.log(`Decrypted ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);
}

function encryptBuffer(plaintext, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    MAGIC,
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
    "",
  ].join("\n");
}

function decryptBuffer(encoded, passphrase) {
  const lines = encoded.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0] !== MAGIC || lines.length < 5) {
    throw new Error("File is not an encrypted env file");
  }
  const salt = Buffer.from(lines[1], "base64");
  const iv = Buffer.from(lines[2], "base64");
  const tag = Buffer.from(lines[3], "base64");
  const ciphertext = Buffer.from(lines.slice(4).join("\n"), "base64");
  try {
    const key = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Could not decrypt. The passphrase does not match this file.");
  }
}

async function readPassphrase(command) {
  const fromEnv = process.env.ENV_MASTER_KEY;
  if (fromEnv) {
    if (!fromEnv.trim()) throw new Error("ENV_MASTER_KEY is empty");
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    throw new Error("Set ENV_MASTER_KEY for this command, or run it in a terminal to type the passphrase");
  }
  const first = await askHidden(command === "encrypt" ? "Encryption passphrase: " : "Passphrase: ");
  if (!first) throw new Error("Passphrase cannot be empty");
  if (command === "encrypt") {
    const second = await askHidden("Repeat passphrase: ");
    if (first !== second) throw new Error("Passphrases do not match");
  }
  return first;
}

function askHidden(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.stdoutMuted = false;
    const original = rl._writeToOutput.bind(rl);
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    rl._writeToOutput = function write(stringToWrite) {
      if (rl.stdoutMuted) return;
      original(stringToWrite);
      rl.stdoutMuted = true;
    };
  });
}

function flag(name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) return null;
  return args[index + 1];
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
