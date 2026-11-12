/**
 * host-gate.sh as review_offer merge runs it: bash running the script as
 * it stands, in a clone of a bare origin, with the commit to merge as its
 * last word. Each case commits a change on a branch and keeps, or doesn't
 * keep, a test:host run for it the way host-test-there.sh does.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../lib/internal/record.ts";
import {
	bareOrigin,
	cloneAt,
	folder,
	removeAll,
} from "../lib/internal/carry/support/machines.ts";
import { git } from "../support/git-fixture.ts";

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "host-gate.sh");
/** The runner a refusal names: the one beside the gate, not the branch's. */
const RUNNER = join(dirname(SCRIPT), "host-test-there.sh");

const made: string[] = [];
afterEach(() => removeAll(made));

/** A harness clone, a state folder and a proven runtime of its own. */
async function harness() {
	const origin = await bareOrigin(made);
	const checkout = await cloneAt(origin, join(folder(made, "clone"), "h"));
	const state = folder(made, "state");
	const runtime = folder(made, "runtime");
	return { checkout, state, runtime };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Commits `file` on a branch of its own, answering the commit. */
async function change(on: Harness, file: string): Promise<string> {
	await git(on.checkout, "checkout", "-q", "-B", "work", "origin/main");
	const path = join(on.checkout, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${file}\n`);
	await git(on.checkout, "add", file);
	await git(on.checkout, "commit", "-q", "-m", `change ${file}`);
	return git(on.checkout, "rev-parse", "HEAD");
}

/** Keeps a run at `sha` as host-test-there.sh does. */
function kept(
	on: Harness,
	sha: string,
	run: { status: string; runtime?: string; files?: string },
): void {
	const record = join(on.state, "agentic-harness.pi", "host-tests", sha);
	mkdirSync(record, { recursive: true });
	writeFileSync(join(record, "status"), `${run.status}\n`);
	writeFileSync(join(record, "runtime"), `${run.runtime ?? on.runtime}\n`);
	writeFileSync(join(record, "log"), "the run's log\n");
	if (run.files !== undefined)
		writeFileSync(join(record, "files"), `${run.files}\n`);
}

/** What the gate answers for `sha`: its exit code and what it said. */
async function gate(
	on: Harness,
	sha: string,
): Promise<{ code: number; said: string }> {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: on.state,
		XDG_STATE_HOME: on.state,
		PI_HOST_RUNTIME: on.runtime,
	};
	try {
		const { stdout, stderr } = await run("bash", [SCRIPT, sha], {
			cwd: on.checkout,
			env,
		});
		return { code: 0, said: stdout + stderr };
	} catch (error) {
		if (!isRecord(error)) throw error;
		const { code, stdout, stderr } = error;
		return {
			code: typeof code === "number" ? code : -1,
			said: `${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}`,
		};
	}
}

describe("host-gate.sh", () => {
	it("lets a change that touches nothing hosts run merge without a run", async () => {
		const on = await harness();
		const sha = await change(on, "docs/notes.md");

		const answer = await gate(on, sha);

		expect(answer).toEqual({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("refuses a change to the host with no run, naming what clears it", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");

		const answer = await gate(on, sha);

		expect(answer.code).toBe(1);
		expect(answer.said).toContain(`nothing ran test:host at ${sha}`);
		expect(answer.said).toContain(`git checkout ${sha} && bash ${RUNNER}`);
	});

	it.each([
		"extensions/subagent-workflow/index.ts",
		"extensions/job-workflow/outbox.ts",
		"lib/mesh/address.ts",
	])("refuses a change to %s, which the host cases drive, with no run", async (file) => {
		const on = await harness();
		const sha = await change(on, file);

		const answer = await gate(on, sha);

		expect(answer.code).toBe(1);
		expect(answer.said).toContain(`nothing ran test:host at ${sha}`);
	});

	it("lets a change to an extension no host case drives merge without a run", async () => {
		const on = await harness();
		const sha = await change(on, "extensions/mermaid-widget/index.ts");

		const answer = await gate(on, sha);

		expect(answer).toEqual({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("lets a change to the host merge once test:host passed at it", async () => {
		const on = await harness();
		const sha = await change(on, "lib/ui/panel-screen.ts");
		kept(on, sha, { status: "0" });

		const answer = await gate(on, sha);

		expect(answer).toEqual({
			code: 0,
			said: expect.stringContaining(`test:host passed at ${sha}`),
		});
	});

	it("refuses a run that failed, saying a fix or, for a flake, a rerun clears it", async () => {
		const on = await harness();
		const sha = await change(on, "lib/core/session/slot.ts");
		kept(on, sha, { status: "1" });

		const answer = await gate(on, sha);

		expect(answer.code).toBe(1);
		expect(answer.said).toContain(`test:host at ${sha} exited 1`);
		expect(answer.said).toContain("fix it in a new commit");
		expect(answer.said).toContain(`again at ${sha} if a case only flaked`);
		expect(answer.said).not.toContain(`git checkout ${sha}`);
	});

	it("refuses a run of only some files", async () => {
		const on = await harness();
		const sha = await change(on, "tests/host/end-to-end/keys.test.ts");
		kept(on, sha, { status: "0", files: "tests/host/end-to-end/keys.test.ts" });

		const answer = await gate(on, sha);

		expect(answer.code).toBe(1);
		expect(answer.said).toContain("ran only some files");
	});

	it("refuses a run on another runtime than the proven one", async () => {
		const on = await harness();
		const sha = await change(on, "package.json");
		kept(on, sha, { status: "0", runtime: "/nix/store/elsewhere" });

		const answer = await gate(on, sha);

		expect(answer.code).toBe(1);
		expect(answer.said).toContain("not the proven");
	});

	it("refuses a pass kept for an earlier commit of the same branch", async () => {
		const on = await harness();
		const earlier = await change(on, "host/service/program.ts");
		kept(on, earlier, { status: "0" });
		const path = join(on.checkout, "host", "service", "program.ts");
		writeFileSync(path, "changed again\n");
		await git(on.checkout, "commit", "-q", "-am", "change it again");
		const later = await git(on.checkout, "rev-parse", "HEAD");

		const answer = await gate(on, later);

		expect(answer.code).toBe(1);
		expect(answer.said).toContain(`nothing ran test:host at ${later}`);
	});
});
