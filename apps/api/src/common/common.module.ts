import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from './clock.js';
import { RateLimiter } from './rate-limiter.js';

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }, RateLimiter],
  exports: [Clock, RateLimiter],
})
export class CommonModule {}
