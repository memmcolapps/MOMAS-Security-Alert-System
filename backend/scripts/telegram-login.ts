// One-time interactive login that produces the TELEGRAM_SESSION string for
// the MTProto listener. Run locally (it prompts for the code Telegram sends
// to your account), then put the printed value in the server env.
//
//   TELEGRAM_API_ID=… TELEGRAM_API_HASH=… bun run scripts/telegram-login.ts
//
// Get api_id/api_hash at https://my.telegram.org → "API development tools".

import readline from "node:readline/promises";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const apiId = parseInt(
  process.env.TELEGRAM_API_ID || (await rl.question("api_id: ")),
  10,
);
const apiHash =
  process.env.TELEGRAM_API_HASH || (await rl.question("api_hash: "));

if (!apiId || !apiHash) {
  console.error("api_id and api_hash are required");
  process.exit(1);
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 3,
});

await client.start({
  phoneNumber: () => rl.question("Phone number (intl format, e.g. +234…): "),
  password: () => rl.question("2FA password (enter if none): "),
  phoneCode: () => rl.question("Login code Telegram sent you: "),
  onError: (err) => console.error(err),
});

console.log("\nAdd this to your environment:\n");
console.log(`TELEGRAM_SESSION=${client.session.save()}`);
await client.disconnect();
process.exit(0);
