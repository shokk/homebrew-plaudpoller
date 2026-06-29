
import { PlaudConfig, PlaudAuth } from './src/core/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  const email = process.env.PLAUD_EMAIL;
  const password = process.env.PLAUD_PASSWORD;
  const region = (process.env.PLAUD_REGION ?? 'us') as 'us' | 'eu';
  const configDir = process.env.PLAUD_CONFIG_DIR ?? path.join(os.homedir(), '.plaudpoller');

  if (!email || !password) {
    throw new Error('PLAUD_EMAIL and PLAUD_PASSWORD environment variables are required.');
  }

  const config = new PlaudConfig(configDir);
  config.saveCredentials({ email, password, region });
  console.log('Credentials saved to Keychain (service: plaudpoller)');

  const auth = new PlaudAuth(config);
  const token = await auth.getToken();
  console.log(`Login OK. Token prefix: ${token.slice(0, 12)}...`);
}

export { main };

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`Login failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
