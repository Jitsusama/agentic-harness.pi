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

/** Everything that drives a real browser. */
const BROWSER_TESTS = "tests/browser/**/*.test.ts";

// Pi's loader rewrites the @sinclair/typebox imports onto its
// bundled `typebox` package at runtime. Mirror that mapping for
// vitest so the same imports work in tests without a separate
// alias in every file.
//
// Named once and given to each project rather than set at the
// root: a project does not inherit the root's resolve, and the
// half of the suite that imports typebox stopped resolving the
// moment the projects were introduced.
const ALIAS = {
	"@sinclair/typebox/value": "typebox/value",
	"@sinclair/typebox/compile": "typebox/compile",
	"@sinclair/typebox": "typebox",
};

export default defineConfig({
	test: {
		environment: "node",
		clearMocks: true,
		// Only the ceiling is ours to set: vitest 4 dropped the floor
		// option and sizes the pool itself underneath the cap. The
		// "never below one worker" part of the note above is the
		// Math.max on the cap, which still holds.
		maxWorkers: MAX_WORKERS,
		projects: [
			{
				resolve: { alias: ALIAS },
				test: {
					name: "unit",
					include: ["tests/**/*.test.ts"],
					exclude: [BROWSER_TESTS],
					// Says which pi install this process belongs to before
					// anything asks, so an upgrade of the pi running the
					// session cannot fail tests that never spawn anything.
					setupFiles: [
						"./tests/setup/pi-install.ts",
						"./tests/setup/xdg-sandbox.ts",
					],
					maxWorkers: MAX_WORKERS,
				},
			},
			{
				resolve: { alias: ALIAS },
				test: {
					name: "browser",
					include: [BROWSER_TESTS],
					// One at a time. Each of these files launches its own
					// Chrome, so letting the pool run four at once put seven
					// browsers on the machine and lost a race the emulation
					// suite documents: under that much contention Chrome can
					// run a page's first script before an override it was
					// already sent has landed. That failed only in the full
					// suite and never alone, which is the worst shape of
					// flake to debug. The cost is a slower browser lane; the
					// alternative is a suite that reports races nobody
					// driving one browser will ever meet.
					fileParallelism: false,
					maxWorkers: 1,
				},
			},
		],
		coverage: {
			provider: "v8",
			include: ["extensions/**/*.ts", "lib/**/*.ts"],
			exclude: ["**/index.ts", "**/types.ts"],
			reporter: ["text", "html"],
		},
	},
	// The three pi packages used to be aliased here too, from the
	// old @mariozechner names onto the current ones. The code
	// imports the current names now, so there is nothing left to
	// rewrite. The typebox mapping that remains lives on each
	// project, in ALIAS above.
	resolve: { alias: ALIAS },
});
