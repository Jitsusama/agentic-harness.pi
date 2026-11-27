/**
 * A reload onto a tree outside any host waits on that tree's checks: one
 * that fails them, or whose run is stopped while they run, queues
 * nothing, and a second request while a tree is being checked is
 * refused rather than running a second set beside the first.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PACKAGE_NAME } from "../../../extensions/reload-workflow/lifecycle.ts";
import {
	ALREADY_CHECKING,
	type ReloadChecks,
	requestReload,
	STOPPED_RELOAD,
} from "../../../extensions/reload-workflow/transitions.ts";
import { hosted } from "../../../lib/core/session/host.ts";
import type { LoadReport } from "../../../lib/internal/reload/load-check.ts";
import type { PackageSettings } from "../../../lib/internal/reload/settings.ts";
import { reloadSlot } from "../../../lib/internal/reload/slot.ts";
import type { Ran, Runner } from "../../../lib/internal/reload/tree-check.ts";

let root: string;
let tree: string;

/** Settings naming an install kept as pi-packages keeps it, in versions/. */
function installed(): PackageSettings {
	const version = join(root, "package", "versions", "v1");
	mkdirSync(version, { recursive: true });
	writeFileSync(
		join(version, "package.json"),
		JSON.stringify({ name: PACKAGE_NAME }),
	);
	return {
		read: () => ["git:example.com/the-package"],
		write: async () => {},
		rootOf: () => version,
	};
}

/** A load check that passes, as a tree that loads cleanly answers it. */
const loads = (): Promise<LoadReport> =>
	Promise.resolve({ ok: true, failures: [], commands: 12 });

/** A runner whose tsc ends as told, and whose git and vitest pass. */
function runner(tsc: Partial<Ran>, during?: () => void): Runner {
	return (command, args) => {
		const end = { code: 0, stdout: "", stderr: "", hung: false };
		if (command.endsWith("tsc")) {
			during?.();
			return Promise.resolve({ ...end, ...tsc });
		}
		const out = args.find((arg) => arg.startsWith("--outputFile="));
		if (out !== undefined) {
			writeFileSync(
				out.slice("--outputFile=".length),
				JSON.stringify({ numPassedTests: 3, testResults: [] }),
			);
		}
		return Promise.resolve(end);
	};
}

/** Ask for a reload onto the tree, or the install given null, saying its progress into `said`. */
function ask(
	checks: ReloadChecks,
	said: string[] = [],
	onto: string | null = tree,
): Promise<string> {
	return requestReload(
		"try it",
		onto ?? undefined,
		installed(),
		(text) => said.push(text),
		checks,
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "checked-tree-"));
	tree = join(root, "tree");
	const bin = join(tree, "node_modules", ".bin");
	mkdirSync(bin, { recursive: true });
	for (const name of ["tsc", "vitest"]) {
		writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
		chmodSync(join(bin, name), 0o755);
	}
	expect(hosted(), "these cases run outside any host").toBeUndefined();
});

afterEach(() => {
	const slot = reloadSlot();
	slot.request = undefined;
	slot.checking = false;
	rmSync(root, { recursive: true, force: true });
});

it("queues a tree that passes, saying each step and how long it may take", async () => {
	const said: string[] = [];
	const answer = await ask({ load: loads, tree: { run: runner({}) } }, said);
	expect(said.slice(1)).toEqual([
		expect.stringMatching(/^Typechecking .*, for up to 5 minutes$/),
		expect.stringMatching(
			/^Running the tests .*'s changes reach, for up to 15 minutes$/,
		),
	]);
	expect(answer).toContain(
		"As it stood when checked, it loads in a pi of its own: 12 commands, no extension failed. It passes its typecheck and the 3 tests its changes reach.",
	);
	expect(reloadSlot().request?.tree).toBe(tree);
	expect(reloadSlot().checking).toBe(false);
});

it("refuses a tree that fails its typecheck, naming why, and queues nothing", async () => {
	const failing = runner({
		code: 2,
		stdout: "lib/a.ts(1,1): error TS2304: Cannot find name 'x'.\n",
	});
	await expect(ask({ load: loads, tree: { run: failing } })).rejects.toThrow(
		/fails a check\. Its typecheck failed:\n- lib\/a\.ts:1: TS2304 Cannot find name 'x'\.\nNothing was reloaded\./,
	);
	expect(reloadSlot().request).toBeUndefined();
	expect(reloadSlot().checking).toBe(false);
});

it("refuses once its run is stopped during the tree's checks, and queues nothing", async () => {
	const stop = new AbortController();
	const stopped = runner({ code: null, stopped: true }, () => stop.abort());
	await expect(
		ask({ signal: stop.signal, load: loads, tree: { run: stopped } }),
	).rejects.toThrow(STOPPED_RELOAD);
	expect(reloadSlot().request).toBeUndefined();
});

it("refuses once its run is stopped during the load check, starting no typecheck", async () => {
	const stop = new AbortController();
	let typechecked = false;
	const load = (): Promise<LoadReport> => {
		stop.abort();
		return loads();
	};
	const run = runner({}, () => {
		typechecked = true;
	});
	await expect(
		ask({ signal: stop.signal, load, tree: { run } }),
	).rejects.toThrow(STOPPED_RELOAD);
	expect(typechecked).toBe(false);
	expect(reloadSlot().request).toBeUndefined();
});

it("refuses a second request while a tree is being checked, and takes one again after", async () => {
	let release = (): void => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const load = async (): Promise<LoadReport> => {
		await held;
		return loads();
	};
	const first = ask({ load, tree: { run: runner({}) } });
	await expect(ask({ load: loads, tree: { run: runner({}) } })).rejects.toThrow(
		ALREADY_CHECKING,
	);
	release();
	await expect(first).resolves.toContain("Reload queued");
	reloadSlot().request = undefined;
	await expect(
		ask({ load: loads, tree: { run: runner({}) } }),
	).resolves.toContain("Reload queued");
});

it("refuses a reload onto the install while a tree is being checked, so the tree's answer can't replace it", async () => {
	let release = (): void => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const load = async (): Promise<LoadReport> => {
		await held;
		return loads();
	};
	const first = ask({ load, tree: { run: runner({}) } });
	await expect(ask({}, [], null)).rejects.toThrow(ALREADY_CHECKING);
	release();
	await first;
	expect(reloadSlot().request?.tree).toBe(tree);
});

it("hands its run's signal to the load and every check, over any given in the checks' options, and keeps their progress", async () => {
	const stop = new AbortController();
	const other = new AbortController();
	const heard: (AbortSignal | undefined)[] = [];
	const load = (_at: string, signal?: AbortSignal): Promise<LoadReport> => {
		heard.push(signal);
		return loads();
	};
	const passing = runner({});
	const run: Runner = (command, args, cwd, env, timeoutMs, signal) => {
		heard.push(signal);
		return passing(command, args, cwd, env, timeoutMs, signal);
	};
	const steps: string[] = [];
	await ask({
		signal: stop.signal,
		load,
		tree: {
			run,
			signal: other.signal,
			onStep: (step) => steps.push(step),
		},
	});
	expect(heard.length).toBeGreaterThanOrEqual(3);
	for (const signal of heard) expect(signal).toBe(stop.signal);
	expect(steps).toEqual(["typecheck", "tests"]);
});
