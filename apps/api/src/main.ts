import { createApp } from './app.js';
import { requestParentSecrets } from './modules/orchestration/secrets.js';

async function bootstrap() {
  const port = Number(process.env.OPCAI_API_PORT ?? 4318);
  const app = await createApp();
  await app.listen({ port, host: '127.0.0.1' });

  // When spawned as the desktop's forked child, ask the Electron main process
  // for the decrypted model/search secrets snapshot (never persisted).
  await requestParentSecrets().catch(() => undefined);

  const close = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

void bootstrap();
