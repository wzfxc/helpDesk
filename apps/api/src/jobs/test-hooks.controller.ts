import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { Clock, FakeClock, SystemClock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { zod } from '../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { JobHandlers } from './handlers.js';

const ClockAdjustSchema = z.object({
  advanceDays: z.number().min(0).max(365).optional(),
  reset: z.boolean().optional(),
});
type ClockAdjust = z.infer<typeof ClockAdjustSchema>;

/**
 * Test-only hooks for E2E scenarios (e.g. simulating the 3-day auto-close delay).
 * Always returns 404 unless ENABLE_TEST_HOOKS=true.
 */
@ApiExcludeController()
@Public()
@Controller('__test')
export class TestHooksController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly handlers: JobHandlers,
  ) {}

  private assertEnabled(): void {
    if (!this.config.ENABLE_TEST_HOOKS) throw notFound();
  }

  @Post('clock')
  @HttpCode(200)
  adjustClock(@Body(zod(ClockAdjustSchema)) body: ClockAdjust): { now: string } {
    this.assertEnabled();
    if (this.clock instanceof SystemClock) {
      if (body.reset) this.clock.reset();
      if (body.advanceDays !== undefined) this.clock.advance(body.advanceDays * 86_400_000);
    } else if (this.clock instanceof FakeClock) {
      if (body.reset) this.clock.set(new Date());
      if (body.advanceDays !== undefined) this.clock.advance(body.advanceDays * 86_400_000);
    }
    return { now: this.clock.now().toISOString() };
  }

  @Post('auto-close')
  @HttpCode(200)
  async runAutoClose(): Promise<{ closed: number }> {
    this.assertEnabled();
    const closed = await this.handlers.autoClose();
    return { closed };
  }
}

