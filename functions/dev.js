// Local test server. Start the Firestore emulator first, then:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-agentmail node functions/dev.js
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
  const [k, ...v] = line.split('=');
  if (k && !process.env[k]) process.env[k] = v.join('=');
}
const { app } = await import('./index.js');
const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Agent Mail dev server on http://localhost:${port}`));
