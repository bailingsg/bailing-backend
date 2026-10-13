import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { setupApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  setupApp(app);

  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const host = config.get<string>('host') ?? '0.0.0.0';
  const port = config.get<number>('port') ?? 4000;

  await app.listen(port, host);
  logger.log(`Bailing API listening on http://${host}:${port}/api/v1`);
  logger.log(`Environment: ${config.get<string>('env')}`);
}

void bootstrap();
