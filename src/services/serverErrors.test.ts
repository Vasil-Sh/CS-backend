import { describe, it, expect } from 'vitest';
import { severityOf } from './serverErrors';

describe('severityOf', () => {
  it('database drop is critical', () => expect(severityOf('console', 'Connection terminated unexpectedly').severity).toBe('critical'));
  it('api 500 is critical and names the status', () => {
    const r = severityOf('api', 'x is undefined', 500);
    expect(r.severity).toBe('critical');
    expect(r.hint).toContain('500');
  });
  it('parser refresh failure is a warning', () => expect(severityOf('console', '[liquipedia] Force refresh failed: 429').severity).toBe('warning'));
  it('plain log line is info', () => expect(severityOf('console', 'something odd').severity).toBe('info'));
});
