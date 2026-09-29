/**
 * Escape reaches a tree provider through the work tool.
 *
 * The broker and every provider take the caller's signal, and a cut of
 * a large repo is minutes, so a tool that kept its signal to itself
 * left the person waiting on a cut nothing they pressed could end.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	registerTreeProvider,
	type TreeProvider,
	unregisterTreeProvider,
} from "@jitsusama/agentic-harness.core/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../extensions/work-integration/broker.ts";
import workIntegration from "../../extensions/work-integration/index.ts";
import { disposeRepo, freshRepo, git } from "../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "./support/review-extension.ts";

/** Settle within `ms`, or say it was still running. */
function within<T>(work: Promise<T>, ms: number): Promise<T | "still running"> {
	return Promise.race([
		work,
		new Promise<"still running">((resolve) =>
			setTimeout(() => resolve("still running"), ms),
		),
	]);
}

/** Whether a process is still alive. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH: nothing by that pid, which is the answer being asked for.
		return false;
	}
}

/** Wait until a process is gone, polling. */
async function dies(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

/** Wait until a file exists, polling. */
async function appears(path: string, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (existsSync(path) && readFileSync(path, "utf8").trim() !== "") {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

const REPO = "test:elsewhere/stoppable";

let root: string;
let savedState: string | undefined;
const handed: { call: string; signal?: AbortSignal }[] = [];

/** A provider serving one made-up repo, cutting a real git checkout. */
const RECORDING: TreeProvider = {
	id: "recording-work",
	specificity: 1_000,
	appliesTo: (repo) => repo.key === REPO,
	ensure: async (_request, options) => {
		handed.push({
			call: "ensure",
			...(options?.signal ? { signal: options.signal } : {}),
		});
		const path = join(root, "cut");
		mkdirSync(path, { recursive: true });
		execFileSync("git", ["init", "-q", path]);
		return { path };
	},
	release: async (_held, options) => {
		handed.push({
			call: "release",
			...(options?.signal ? { signal: options.signal } : {}),
		});
	},
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-tree-signal-"));
	savedState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(root, "state");
	handed.length = 0;
	forgetTreeBroker();
});
afterEach(() => {
	unregisterTreeProvider(RECORDING.id);
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	rmSync(root, { recursive: true, force: true });
});

describe("the work tool's signal reaching the tree provider", () => {
	it("is handed to the cut and to the release", async () => {
		const stub = activateWith(workIntegration);
		registerTreeProvider(RECORDING);
		const work = toolNamed(stub, "work");
		const { signal } = new AbortController();

		const cut = (await work.execute(
			"call-1",
			{ action: "tree", repo: REPO, purpose: "stoppable", branch: "stop-me" },
			signal,
			undefined,
			HEADLESS,
		)) as { details?: { ok?: boolean; key?: string } };
		expect(cut.details?.ok).toBe(true);

		const released = (await work.execute(
			"call-2",
			{ action: "release", tree: cut.details?.key },
			signal,
			undefined,
			HEADLESS,
		)) as { details?: { ok?: boolean } };
		expect(released.details?.ok).toBe(true);

		expect(handed).toEqual([
			{ call: "ensure", signal },
			{ call: "release", signal },
		]);
	});
});

describe("stopping a cut the built-in git provider is making", () => {
	let source: string | undefined;
	let hookPid: number | undefined;

	afterEach(async () => {
		if (hookPid !== undefined && alive(hookPid))
			process.kill(hookPid, "SIGKILL");
		hookPid = undefined;
		if (source) await disposeRepo(source);
		source = undefined;
	});

	it("ends git and what it started, not only the wait on it", async () => {
		// A post-checkout hook that never finishes stands in for anything a
		// cut can block on: a slow checkout, a credential helper, an LFS
		// smudge. Stopped, the hook has to die with git, since a process
		// left behind is the cut still running with nobody waiting on it.
		source = await freshRepo("work-stop-source");
		await git(source, "branch", "hooked");
		const pidFile = join(root, "hook.pid");
		const hooks = join(root, "hooks");
		mkdirSync(hooks);
		writeFileSync(
			join(hooks, "post-checkout"),
			`#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`,
		);
		chmodSync(join(hooks, "post-checkout"), 0o755);
		await git(source, "config", "core.hooksPath", hooks);

		const stub = activateWith(workIntegration);
		const work = toolNamed(stub, "work");
		const stop = new AbortController();
		const cutting = work.execute(
			"call-1",
			{
				action: "tree",
				repo: "test:hooked/source",
				checkout: source,
				purpose: "stoppable",
				branch: "hooked",
			},
			stop.signal,
			undefined,
			HEADLESS,
		);
		cutting.catch(() => undefined);

		expect(await appears(pidFile, 10_000)).toBe(true);
		hookPid = Number(readFileSync(pidFile, "utf8").trim());
		stop.abort();

		expect(
			await within(
				cutting.then(() => "answered"),
				5_000,
			),
		).toBe("answered");
		expect(await dies(hookPid, 2_000)).toBe(true);
	}, 20_000);
});
