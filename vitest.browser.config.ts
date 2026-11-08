import { defineConfig } from "vitest/config";

// The browser lane's own config, apart from vitest.config.ts, whose
// projects leave tests/core/browser out: these drive a real Chrome, so
// in the default lane they would slow every `pnpm test` and fail on a
// machine with none. Run with `pnpm test:browser`; it needs a Chrome,
// named by CHROME_PATH or found where Chrome usually lives, and fails
// before any test runs where there is none.
export default defineConfig({
	test: {
		globalSetup: ["./tests/setup/chrome-present.ts"],
		include: ["tests/core/browser/**/*.test.ts"],
	},
});
