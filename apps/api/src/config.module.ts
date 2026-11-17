import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, loadConfig, type AppConfig } from './config.js';

@Global()
@Module({})
export class ConfigModule {
  static forRoot(overrides: Partial<AppConfig> = {}): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: { ...loadConfig(), ...overrides } }],
      exports: [APP_CONFIG],
    };
  }
}
