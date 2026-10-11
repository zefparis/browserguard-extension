import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  // Match the production build defaults; __BG_DEV__ is true so tests can
  // exercise the dev local-storage fallback via __testSetDevBuild.
  define: {
    __DEBUG__: 'false',
    __BG_API_BASE__: '"https://api.hcs-u7.org/hv"',
    __BG_STEPUP_BASE__: '"https://challenge.hcs-u7.org"',
    __BG_DEV__: 'true',
  },
});
