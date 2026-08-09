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

/**
 * Everything that drives a real browser.
 *
 * These live in their own project because they cannot share the
 * unit lane's parallelism, and `pnpm test` runs only the unit
 * project rather than both. That is not a way of skipping them: CI
 * has a dedicated browser job which runs this same lane with
 * `PI_RACE_TESTS=1`, so it is a strict superset of what including
 * them here would do.
 *
 * The duplication was expensive and invisible. The browser lane runs
 * one file at a time by necessity, and measured 223s of a 302s
 * suite, so every change in the repo paid for a serial Chrome lane
 * twice over: once in the vitest job and again in the browser job
 * beside it. The unit lane alone is 4698 tests in 26 seconds.
 */
const BROWSER_TESTS = "tests/browser/**/*.test.ts";

/**
 * Everything that spawns a real operating system process.
 *
 * Their own lane for the reason the browser tests have one, and
 * arrived at the same way: they cannot share the unit lane's
 * parallelism, and until they were separated they lost to it. A
 * supervisor test is node spawning a script spawning a child, so a
 * handful of them running beside four workers of ordinary tests
 * starves exactly the children they are watching, and the failure
 * reads as a reviewer that would not spawn rather than as a machine
 * that was too busy. Two cases failed that way for weeks, both green
 * whenever anybody ran them alone, which is the signature.
 *
 * Run one file at a time, and run by `pnpm test`, unlike the browser
 * lane: these are seconds rather than minutes, and they cover the
 * paths where being wrong costs a running model nobody can reach.
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
					exclude: [BROWSER_TESTS, ...PROCESS_TESTS],
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
			{
				resolve: { alias: ALIAS },
				test: {
					name: "browser",
					include: [BROWSER_TESTS],
					// Four at a time, which was previously one.
					//
					// This used to run serially, because four workers put
					// seven browsers on the machine and lost a race the
					// emulation suite documents: under that contention Chrome
					// can run a page's first script before an override it was
					// already sent has landed.
					//
					// Seven was the tell. Four workers cannot make seven
					// browsers, and they did because the browser lane was
					// then also running inside the unit job, so browser
					// workers competed with unit workers for the machine. The
					// duplication was the cause and the serial lane was the
					// symptom's dressing; with the lanes no longer overlapping
					// four workers means four browsers.
					//
					// Measured after that change, with PI_RACE_TESTS=1 so the
					// documented race guard actually runs: the lane went from
					// 275.89s to 70.35s and the whole suite from about five
					// minutes to 94s, with 4889 tests passing and no race,
					// three runs in a row.
					//
					// The cap is the shared one rather than a flat four, so a
					// two-core CI runner still runs this one browser at a
					// time. Four browsers is right for a developer's machine
					// and would be the old oversubscription on a small one.
					fileParallelism: true,
					maxWorkers: MAX_WORKERS,
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
