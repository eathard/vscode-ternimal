// vitest.config.ts — unit-test runner config. Pure-logic suites live next to
// their sources (`foo.test.ts`); server/process-bound suites stay under
// scripts/verify-*.mjs (see docs/verification-standard.md).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'relay/src/**/*.test.mjs'],
  },
});
