import path from 'path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const includePattern = ['**/e2e/**/*.e2e-spec.ts'];

export default defineConfig({
  test: {
    include: includePattern,
    // E2E spec files each spin up their own test server with an isolated
    // in-memory SQLite DB and a unique port (derived from the file index
    // by e2e-common/test-config.ts), so they can safely run in parallel.
    // Re-disable file parallelism if a future suite reintroduces shared
    // infrastructure (Elasticsearch indices, on-disk DB, fixed ports, …).
    fileParallelism: false,
    pool: 'forks',
    /**
     * For local debugging of the e2e tests, we set a very long timeout value otherwise tests will
     * automatically fail for going over the 5 second default timeout.
     */
    testTimeout: process.env.E2E_DEBUG ? 1800 * 1000 : process.env.CI ? 30 * 1000 : 15 * 1000,
    typecheck: {
      tsconfig: path.join(__dirname, 'tsconfig.e2e.json')
    },
    allowOnly: true
  },
  plugins: [
    // SWC required to support decorators used in test plugins
    // See https://github.com/vitest-dev/vitest/issues/708#issuecomment-1118628479
    swc.vite({
      jsc: {
        transform: {
          useDefineForClassFields: false
        }
      }
    })
  ]
});
