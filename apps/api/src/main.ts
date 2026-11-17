import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(), { bodyParser: false });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}

void bootstrap();
