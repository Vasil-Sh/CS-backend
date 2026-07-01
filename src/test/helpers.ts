/**
 * Test helpers for route integration tests.
 * Provides a mock DB and Hono app instance for route testing.
 */
import { Hono } from 'hono';
import { vi } from 'vitest';

/**
 * Creates a clean Hono app with all standard middleware.
 * Use for testing route modules in isolation.
 */
export function createTestApp(): Hono {
  const app = new Hono();

  // Minimal middleware for test (no rate limiting, no CORS checks)
  app.use('*', async (c, next) => {
    // Inject mock user for auth tests
    await next();
  });

  return app;
}

/**
 * Mock database helper — returns a proxy that tracks calls.
 * Route tests should mock specific db methods per test.
 */
export function mockDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

/**
 * Create a mock JWT token for testing.
 */
export function mockAuthUser(overrides: Record<string, unknown> = {}) {
  return {
    userId: 1,
    username: 'testuser',
    role: 'user' as const,
    ...overrides,
  };
}
