import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

// Several suites spawn real OS processes: the reviewer supervisor
// launches node two levels deep, and the LSP suite starts its own
// servers. On a many-core machine vitest's fork pool would run
// enough of these at once to saturate the CPU, starving those
// child processes until they blow their timeouts and the suite goes
// flaky. Cap the pool so the process-heavy suites are not
// oversubscribed. The cap scales down on smaller machines and never
// drops below one worker; capping also runs the whole suite faster
// here, since the thrash it removes cost more than the lost
// parallelism.
const MAX_WORKERS = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));

/**
 * Everything that spawns a real operating system process.
 *
 * Their own lane because they cannot share the unit lane's
 * parallelism, and until they were separated they lost to it. A
 * supervisor test is node spawning a script spawning a child, so a
 * handful of them running beside four workers of ordinary tests
 * starves exactly the children they are watching, and the failure
 * reads as a reviewer that would not spawn rather than as a machine
 * that was too busy. Two cases failed that way for weeks, both green
 * whenever anybody ran them alone, which is the signature.
 *
 * Run one file at a time. Named individually rather than matched by
 * a pattern, because what belongs here is not a directory: it is the
 * handful of suites that spawn node from node, and a rule broad
 * enough to catch them by shape would catch every test that shells
 * out to git.
 */
const PROCESS_TESTS = [
	"tests/lib/subagent/runpi/supervisor.test.ts",
	"tests/lib/subagent/runpi/detached.test.ts",
	"tests/lib/subagent/runpi/parent-exit.test.ts",
	"tests/extensions/review-starts-a-round-it-will-not-wait-for.test.ts",
	"tests/extensions/subagent-workflow/fleet-outlives-its-session.test.ts",
];

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
					exclude: PROCESS_TESTS,
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
					name: "process",
					include: PROCESS_TESTS,
					setupFiles: [
						"./tests/setup/pi-install.ts",
						"./tests/setup/xdg-sandbox.ts",
					],
					// One at a time, and one worker. The point is not to be
					// quick here: it is that a test watching a grandchild
					// process is measuring the machine as much as the code, so
					// it must not be measuring the rest of the suite too.
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
