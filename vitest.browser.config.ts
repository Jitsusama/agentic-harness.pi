import { defineConfig } from "vitest/config";
import { RERUN_EVERYTHING } from "./vitest.config.ts";

// The browser lane's own config, apart from vitest.config.ts, whose
// projects leave tests/core/browser out: these drive a real Chrome, so
// in the default lane they would slow every `pnpm test` and fail on a
// machine with none. Run with `pnpm test:browser`; it needs a Chrome,
// named by CHROME_PATH or found where Chrome usually lives, and fails
// before any test runs where there is none. `pnpm check` runs the files
// a change reaches, `pnpm test:browser:changed`, and none for a change
// that reaches none, so a machine with no Chrome fails only then.
export default defineConfig({
	test: {
		forceRerunTriggers: RERUN_EVERYTHING,
		globalSetup: ["./tests/setup/chrome-present.ts"],
		include: ["tests/core/browser/**/*.test.ts"],
	},
});
