/**
 * host-gate.sh as review_offer merge runs it: bash running the script as
 * it stands, in a clone of a bare origin, with the commit to merge as its
 * last word. Each case commits a change on a branch and has a stand-in
 * nix-offload say what its keeper kept as passed at that commit, the way
 * `nix-offload passed ran` does, or say it runs no keeper. The tools the
 * words name come from a profile of the test's own, as from the
 * account's and the system's on a machine.
 */

import { execFile } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
const SCRIPTS = join(import.meta.dirname, "..", "..", "scripts");
const GATE = join(SCRIPTS, "host-gate.sh");
const RUNNER = join(SCRIPTS, "host-test-there.sh");
/** The tools test:host's words name, each a program in a store folder. */
const TOOLS = ["bash", "mycelium", "fd", "rg", "script"] as const;
/** What nix-offload exits with where the machine runs no keeper. */
const NO_KEEPER = 69;
/** What host-test-there.sh exits with when nothing ran. */
const NOTHING_RAN = 75;
/** A word the agent fence lets out (PLAIN_WORD in offload-exemption.ts). */
const PLAIN = /^[A-Za-z0-9._/@:=+^*-]+$/;

const made: string[] = [];
afterEach(() => removeAll(made));

/** A stand-in nix-offload saying what `keeper` holds for each commit. */
const OFFLOAD = `#!/usr/bin/env bash
[[ "$1 $2" == "passed ran" ]] || exit 64
[[ -e "$FAKE_KEEPER/none" ]] && exit ${NO_KEEPER}
cat "$FAKE_KEEPER/$3" 2> /dev/null
exit 0
`;

/**
 * A harness clone, a state folder, a proven runtime, a profile of tools
 * and a stand-in nix-offload whose keeper's record is a folder.
 */
async function harness() {
	const origin = await bareOrigin(made);
	const checkout = await cloneAt(origin, join(folder(made, "clone"), "h"));
	const state = folder(made, "state");
	const runtime = folder(made, "runtime");
	mkdirSync(join(runtime, "lib", "node_modules", "pi-monorepo"), {
		recursive: true,
	});
	const store = folder(made, "store");
	const profile = folder(made, "profile");
	const tools: Record<string, string> = {};
	for (const tool of TOOLS) {
		const bin = join(store, `0000-${tool}`, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, tool), "");
		chmodSync(join(bin, tool), 0o755);
		symlinkSync(join(bin, tool), join(profile, tool));
		tools[tool] = realpathSync(join(store, `0000-${tool}`));
	}
	const bin = folder(made, "bin");
	writeFileSync(join(bin, "nix-offload"), OFFLOAD);
	chmodSync(join(bin, "nix-offload"), 0o755);
	const keeper = folder(made, "keeper");
	return { checkout, state, runtime, profile, tools, bin, keeper };
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

/** The words test:host runs as on this harness's machine, after `--`. */
function testHost(on: Harness, runtime = on.runtime): string[] {
	const tool = (name: string) => on.tools[name] ?? "";
	const path = ["mycelium", "fd", "rg", "script"]
		.map((name) => `${tool(name)}/bin`)
		.join(":");
	return [
		`${tool("bash")}/bin/bash`,
		"scripts/host-run.sh",
		runtime,
		`${tool("mycelium")}/bin/mycelium`,
		path,
	];
}

/** Keeps a passing run of `words` at `sha`, as nix-offload's keeper does. */
function kept(on: Harness, sha: string, words: string[]): void {
	const line = JSON.stringify({
		copies: [on.runtime],
		dir: null,
		ended: 1_700_000_000,
		ran: words,
	});
	writeFileSync(join(on.keeper, sha), `${line}\n`, { flag: "a" });
}

/** What `script` answers in `on`'s checkout: its exit code and what it said. */
async function answer(
	on: Harness,
	script: string,
	words: string[],
	home = on.state,
): Promise<{ code: number; out: string; said: string }> {
	const env: NodeJS.ProcessEnv = {
		PATH: `${on.bin}:${process.env.PATH ?? ""}`,
		HOME: home,
		XDG_STATE_HOME: on.state,
		PI_HOST_RUNTIME: on.runtime,
		HOST_TEST_PROFILES: on.profile,
		FAKE_KEEPER: on.keeper,
	};
	try {
		const { stdout, stderr } = await run("bash", [script, ...words], {
			cwd: on.checkout,
			env,
		});
		return { code: 0, out: stdout, said: stdout + stderr };
	} catch (error) {
		if (!isRecord(error)) throw error;
		const { code, stdout, stderr } = error;
		const out = typeof stdout === "string" ? stdout : "";
		return {
			code: typeof code === "number" ? code : -1,
			out,
			said: `${out}${typeof stderr === "string" ? stderr : ""}`,
		};
	}
}

/** What the gate answers for `sha`. */
function gate(on: Harness, sha: string) {
	return answer(on, GATE, [sha]);
}

describe("host-gate.sh", () => {
	it("lets a change that touches nothing hosts run merge without a run", async () => {
		const on = await harness();
		const sha = await change(on, "docs/notes.md");

		const answered = await gate(on, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("refuses a change to the host with no run, naming what clears it", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`nothing ran test:host at ${sha}`);
		expect(answered.said).toContain(`bash ${RUNNER}`);
	});

	it.each([
		"extensions/subagent-workflow/index.ts",
		"extensions/job-workflow/outbox.ts",
		"lib/mesh/address.ts",
	])(
		"refuses a change to %s, which the host cases drive, with no run",
		async (file) => {
			const on = await harness();
			const sha = await change(on, file);

			const answered = await gate(on, sha);

			expect(answered.code).toBe(1);
			expect(answered.said).toContain(`nothing ran test:host at ${sha}`);
		},
	);

	it("lets a change to an extension no host case drives merge without a run", async () => {
		const on = await harness();
		const sha = await change(on, "extensions/mermaid-widget/index.ts");

		const answered = await gate(on, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("lets a change to the host merge once the keeper kept test:host passing at it", async () => {
		const on = await harness();
		const sha = await change(on, "lib/ui/panel-screen.ts");
		kept(on, sha, ["/nix/store/0000-coreutils/bin/true"]);
		kept(on, sha, testHost(on));

		const answered = await gate(on, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining(`test:host passed at ${sha}`),
		});
	});

	it("refuses another program the keeper kept as passing, such as true", async () => {
		const on = await harness();
		const sha = await change(on, "lib/core/session/slot.ts");
		kept(on, sha, ["/nix/store/0000-coreutils/bin/true"]);

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`what passed at ${sha} isn't test:host`);
	});

	it("refuses a run of only some files", async () => {
		const on = await harness();
		const sha = await change(on, "tests/host/end-to-end/keys.test.ts");
		kept(on, sha, [...testHost(on), "tests/host/end-to-end/keys.test.ts"]);

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("isn't test:host");
	});

	it("refuses a run on another runtime than the proven one", async () => {
		const on = await harness();
		const sha = await change(on, "package.json");
		kept(on, sha, testHost(on, "/nix/store/elsewhere"));

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("isn't test:host on the proven");
	});

	it("refuses a pass kept for an earlier commit of the same branch", async () => {
		const on = await harness();
		const earlier = await change(on, "host/service/program.ts");
		kept(on, earlier, testHost(on));
		const path = join(on.checkout, "host", "service", "program.ts");
		writeFileSync(path, "changed again\n");
		await git(on.checkout, "commit", "-q", "-am", "change it again");
		const later = await git(on.checkout, "rev-parse", "HEAD");

		const answered = await gate(on, later);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`nothing ran test:host at ${later}`);
	});

	it("refuses on a machine whose nix-offload runs no keeper", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		kept(on, sha, testHost(on));
		writeFileSync(join(on.keeper, "none"), "");

		const answered = await gate(on, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("runs no nix-offload keeper");
	});
});

describe("host-test-there.sh", () => {
	it("inside the fence prints the lone call the fence lets out, and the gate takes", async () => {
		const on = await harness();
		const sha = await change(on, "host/engine/engine.ts");
		const fenced = folder(made, "fenced-home");
		const key = join(fenced, ".local", "state", "nix-offload");
		mkdirSync(key, { recursive: true });
		writeFileSync(join(key, "store_ed25519"), "");

		const answered = await answer(on, RUNNER, [], fenced);

		expect(answered.code, answered.said).toBe(NOTHING_RAN);
		const call = answered.out.trim();
		expect(call).toMatch(
			new RegExp(`^cd ${on.checkout} && nix-offload there --never-ask --run `),
		);
		const words = call.split(" ").slice(3);
		expect(words.filter((word) => !PLAIN.test(word))).toEqual([]);
		expect(words.slice(words.indexOf("--") + 1)).toEqual(testHost(on));
		kept(on, sha, testHost(on));
		expect((await gate(on, sha)).code).toBe(0);
	});
});
