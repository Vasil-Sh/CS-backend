import { describe, expect, it } from 'vitest';
import { errorKey } from './serverErrors';

describe('server errors', () => {
  it('errors of one kind share a key (numbers, ids, urls, quoted values blanked)', () => {
    expect(errorKey('console', 'Circuit breaker failure #3 for https://a.b/x?id=1'))
      .toBe(errorKey('console', 'Circuit breaker failure #17 for https://c.d/y'));
    expect(errorKey('api', 'User "bob" not found 5f3a9c2e1b')).toBe(errorKey('api', 'User "alice" not found 77aa88bb99'));
  });
  it('different messages or sources stay apart', () => {
    expect(errorKey('api', 'Timeout')).not.toBe(errorKey('console', 'Timeout'));
    expect(errorKey('api', 'Timeout')).not.toBe(errorKey('api', 'Refused'));
  });
});
