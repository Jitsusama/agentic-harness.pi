import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		clearMocks: true,
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
			"@sinclair/typebox/value": "typebox/value",
			"@sinclair/typebox/compile": "typebox/compile",
			"@sinclair/typebox": "typebox",
		},
	},
});
