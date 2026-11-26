/**
 * Makes TG_SESSION for reading private Telegram channels (run once on your computer, not on the server):
 *   TG_API_ID=… TG_API_HASH=… npx tsx scripts/tgLogin.ts
 * TG_API_ID / TG_API_HASH: my.telegram.org → API development tools. Use a separate Telegram account, not your personal one.
 * It asks for the phone number, the code Telegram sends and (if the account has one) the 2FA password — you type them here, in your terminal.
 * Then it prints the session string: put it into Railway as TG_SESSION (it is a login — keep it secret).
 */
import { createInterface } from 'readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const id = Number(process.env.TG_API_ID), hash = process.env.TG_API_HASH || '';
if (!id || !hash) { console.error('Set TG_API_ID and TG_API_HASH first (my.telegram.org → API development tools).'); process.exit(1); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(''), id, hash, { connectionRetries: 3 });
await client.start({
  phoneNumber: () => rl.question('Phone number (+380…): '),
  phoneCode: () => rl.question('Code from Telegram: '),
  password: () => rl.question('2FA password (empty if none): '),
  onError: (e) => console.error(e.message),
});
console.log('\nTG_SESSION =\n' + String(client.session.save()) + '\n\nAdd it in Railway → Variables, together with TG_API_ID and TG_API_HASH.');
rl.close();
await client.disconnect();
process.exit(0);
