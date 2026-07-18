import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

// Several suites spawn real OS processes: the reviewer supervisor
// launches node two levels deep, and the browser and LSP suites start
// their own servers. On a many-core machine vitest's fork pool would
// run enough of these at once to saturate the CPU, starving those
// child processes until they blow their timeouts and the suite goes
// flaky. Cap the pool so the process-heavy suites are not
// oversubscribed. The cap scales down on smaller machines and never
// drops below one worker; capping also runs the whole suite faster
// here, since the thrash it removes cost more than the lost
// parallelism.
const MAX_WORKERS = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		clearMocks: true,
		maxWorkers: MAX_WORKERS,
		minWorkers: 1,
		coverage: {
			provider: "v8",
			include: ["extensions/**/*.ts", "lib/**/*.ts"],
			exclude: ["**/index.ts", "**/types.ts"],
			reporter: ["text", "html"],
		},
	},
	resolve: {
		// Pi 0.74's loader rewrites the @sinclair/typebox
		// imports onto its bundled `typebox` package at
		// runtime. Mirror that mapping for vitest so the
		// same imports work in tests without a separate
		// alias in every file.
		alias: {
			"@mariozechner/pi-ai": "@earendil-works/pi-ai",
			"@mariozechner/pi-coding-agent": "@earendil-works/pi-coding-agent",
			"@mariozechner/pi-tui": "@earendil-works/pi-tui",
			"@sinclair/typebox/value": "typebox/value",
			"@sinclair/typebox/compile": "typebox/compile",
			"@sinclair/typebox": "typebox",
		},
	},
});
