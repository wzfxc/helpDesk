/** Injectable time source so tests can move time (auto-close, SLA scans, orphan cleanup). */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock extends Clock {
  private current: number;

  constructor(start: Date | string = '2025-01-06T09:00:00.000Z') {
    super();
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
