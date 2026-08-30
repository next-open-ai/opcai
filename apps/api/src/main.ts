import { createApp } from './app.js';

async function bootstrap() {
  const port = Number(process.env.OPCAI_API_PORT ?? 4318);
  const app = await createApp();
  await app.listen({ port, host: '127.0.0.1' });

  const close = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

void bootstrap();
