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
});
