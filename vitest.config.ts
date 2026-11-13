import { cpus } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The files whose change reaches every test, so `--changed` runs them all.
 *
 * Named by absolute path rather than left to vitest's default globs
 * (`**\/package.json/**`), because a glob's `**` does not cross a folder
 * whose name starts with a dot, and every tree the work broker cuts
 * sits under `~/.local/state`. There a dependency bump matched nothing
 * and `pnpm test:changed` ran no tests at all. The setup folder is here
 * too, since no test imports a setup file, so the import graph never
 * reaches one. The browser lane's config reads it too, so the gate's
 * browser run follows the same files.
 */
export const RERUN_EVERYTHING = [
	"package.json",
	"pnpm-lock.yaml",
	"vitest.config.ts",
	"vitest.browser.config.ts",
	"tests/setup/**",
].map((file) => join(import.meta.dirname, file));

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
	"tests/lib/subagent/runpi/handed-over.test.ts",
	"tests/extensions/review-starts-a-round-it-will-not-wait-for.test.ts",
	"tests/extensions/subagent-workflow/fleet-outlives-its-session.test.ts",
	"tests/lib/internal/reload/load-check.test.ts",
	"tests/lib/internal/reload/stale-rejections.test.ts",
	"tests/core/package/heavy-dependencies-load-on-use.test.ts",
	"tests/package/hosted-loads-add-no-process-listeners.test.ts",
	"tests/lib/internal/priority/fetched-git.test.ts",
	"tests/lib/internal/priority/push-hooks.test.ts",
	"tests/lib/internal/fence-sockets.test.ts",
	"tests/scripts/host-join.test.ts",
	"tests/scripts/pi-carry.test.ts",
	"tests/scripts/pi-host.test.ts",
	"tests/scripts/spawn-decide.test.ts",
	"tests/host/service/killed-host.test.ts",
	"tests/host/engine/hosted-agent.test.ts",
	"tests/host/engine/engine.test.ts",
	"tests/host/parity/parity.test.ts",
	"tests/host/soak/soak.test.ts",
	"tests/host/end-to-end/sealed-host.test.ts",
	"tests/host/end-to-end/killed-busy.test.ts",
	"tests/host/end-to-end/listed-busy.test.ts",
	"tests/host/end-to-end/release-all.test.ts",
	"tests/host/end-to-end/release-parked.test.ts",
	"tests/host/end-to-end/screens.test.ts",
	"tests/host/end-to-end/keys.test.ts",
	"tests/host/end-to-end/screen-slots.test.ts",
	"tests/host/end-to-end/screen-faults.test.ts",
	"tests/host/end-to-end/panel-sizes.test.ts",
	"tests/host/end-to-end/gate-chords.test.ts",
	"tests/host/end-to-end/budgets.test.ts",
	"tests/host/end-to-end/cutover.test.ts",
	"tests/host/end-to-end/mesh.test.ts",
	"tests/host/end-to-end/pausing.test.ts",
	"tests/host/end-to-end/restart.test.ts",
	"tests/host/end-to-end/rollback.test.ts",
	"tests/host/end-to-end/spawn.test.ts",
	"tests/host/end-to-end/steer.test.ts",
	"tests/host/end-to-end/subagents.test.ts",
	"tests/host/end-to-end/subagent-key.test.ts",
	"tests/host/end-to-end/attach-client.test.ts",
	"tests/host/end-to-end/follow-install.test.ts",
	"tests/host/end-to-end/screen-reload.test.ts",
	"tests/host/end-to-end/quit.test.ts",
	"tests/host/end-to-end/park.test.ts",
	"tests/host/end-to-end/footer.test.ts",
	"tests/host/end-to-end/early-attach.test.ts",
	"tests/host/end-to-end/commands.test.ts",
	"tests/host/end-to-end/host-command.test.ts",
	"tests/host/end-to-end/launched-spawn.test.ts",
	"tests/host/end-to-end/job-carry.test.ts",
	"tests/host/end-to-end/fleet-carry.test.ts",
	"tests/host/end-to-end/launcher-verbs.test.ts",
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
		forceRerunTriggers: RERUN_EVERYTHING,
		globalSetup: ["./tests/setup/temp-root.ts"],
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
					// The browser tests have a lane of their own,
					// vitest.browser.config.ts, since they need a real Chrome.
					exclude: [...PROCESS_TESTS, "tests/core/browser/**"],
					// Says which pi install this process belongs to before
					// anything asks, so an upgrade of the pi running the
					// session cannot fail tests that never spawn anything.
					setupFiles: [
						"./tests/setup/pi-install.ts",
						"./tests/setup/xdg-sandbox.ts",
						"./tests/setup/signal-stamp.ts",
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
