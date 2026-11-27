/**
 * ready-gate.sh as review_offer ready runs it: bash running the script as
 * it stands, in a clone of a bare origin, with the head as its last word.
 * Each case commits a change on a branch and has a stand-in nix-offload
 * say what its keeper kept as passed at that commit, as `nix-offload
 * passed ran` does. The bash the words name comes from a profile of the
 * test's own, as from the account's on a machine.
 */

import { execFile } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	realpathSync,
	rmSync,
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
// Imported only to be named, so `--changed` runs this file when a script
// it runs changes alone; it runs them from their paths below.
import "../../scripts/ready-gate.sh";
import "../../scripts/changed-run.sh";
import "../../scripts/changed-there.sh";
import "../../scripts/changed-words.sh";

const run = promisify(execFile);
const SCRIPTS = join(import.meta.dirname, "..", "..", "scripts");
const GATE = join(SCRIPTS, "ready-gate.sh");
const SENDER = join(SCRIPTS, "changed-there.sh");
/** What nix-offload exits with where the machine runs no keeper. */
const NO_KEEPER = 69;
/** What changed-there.sh exits with when nothing ran. */
const NOTHING_RAN = 75;

const made: string[] = [];
afterEach(() => removeAll(made));

/** A stand-in nix-offload saying what `keeper` holds for each commit. */
const OFFLOAD = `#!/usr/bin/env bash
[[ "$1 $2" == "passed ran" ]] || exit 64
[[ -e "$FAKE_KEEPER/none" ]] && exit ${NO_KEEPER}
cat "$FAKE_KEEPER/$3" 2> /dev/null
exit 0
`;

/** A harness clone, a profile holding bash, and a stand-in keeper. */
async function harness() {
	const origin = await bareOrigin(made);
	const checkout = await cloneAt(origin, join(folder(made, "clone"), "h"));
	const store = folder(made, "store");
	const profile = folder(made, "profile");
	const shell = join(store, "0000-bash", "bin");
	mkdirSync(shell, { recursive: true });
	writeFileSync(join(shell, "bash"), "");
	chmodSync(join(shell, "bash"), 0o755);
	symlinkSync(join(shell, "bash"), join(profile, "bash"));
	const bin = folder(made, "bin");
	writeFileSync(join(bin, "nix-offload"), OFFLOAD);
	chmodSync(join(bin, "nix-offload"), 0o755);
	return {
		checkout,
		profile,
		bash: `${realpathSync(join(store, "0000-bash"))}/bin/bash`,
		bin,
		keeper: folder(made, "keeper"),
		home: folder(made, "home"),
	};
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Commits `files` and removes `gone` on a branch, answering the commit. */
async function change(
	on: Harness,
	files: string[],
	gone: string[] = [],
): Promise<string> {
	await git(on.checkout, "checkout", "-q", "-B", "work", "origin/main");
	for (const file of files) {
		const path = join(on.checkout, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${file}\n`);
	}
	if (files.length > 0) await git(on.checkout, "add", ...files);
	for (const file of gone) await git(on.checkout, "rm", "-q", file);
	await git(on.checkout, "commit", "-q", "-m", "change");
	return git(on.checkout, "rev-parse", "HEAD");
}

/** The words a run of the checks of `files` is kept under, after `--`. */
function checksOf(on: Harness, files: string[]): string[] {
	return [on.bash, "scripts/changed-run.sh", ...files];
}

/** Keeps a passing run of `words` at `sha`, as nix-offload's keeper does. */
function kept(on: Harness, sha: string, words: string[]): void {
	const line = JSON.stringify({
		copies: [],
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
): Promise<{ code: number; out: string; said: string }> {
	const env: NodeJS.ProcessEnv = {
		PATH: `${on.bin}:${process.env.PATH ?? ""}`,
		HOME: on.home,
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

describe("the harness's ready gate", () => {
	it("lets a head through once its changed checks passed there, its files in order", async () => {
		const on = await harness();
		const sha = await change(on, ["lib/b.ts", "lib/a.ts"]);
		kept(on, sha, checksOf(on, ["lib/a.ts", "lib/b.ts"]));

		const gated = await answer(on, GATE, [sha]);

		expect(gated.said).toContain("passed at");
		expect(gated.code).toBe(0);
	});

	it("refuses a head whose kept run checked other files, naming what clears it", async () => {
		const on = await harness();
		const sha = await change(on, ["lib/a.ts", "lib/b.ts"]);
		kept(on, sha, checksOf(on, ["lib/a.ts"]));

		const gated = await answer(on, GATE, [sha]);

		expect(gated.code).toBe(1);
		expect(gated.said).toContain("changed-there.sh");
		expect(gated.said).toContain("2 file(s)");
	});

	it("takes no other program kept as passing there, true among them", async () => {
		const on = await harness();
		const sha = await change(on, ["lib/a.ts"]);
		kept(on, sha, ["/run/current-system/sw/bin/true"]);

		expect((await answer(on, GATE, [sha])).code).toBe(1);
	});

	it("refuses a run kept at another commit", async () => {
		const on = await harness();
		const earlier = await change(on, ["lib/a.ts"]);
		kept(on, earlier, checksOf(on, ["lib/a.ts"]));
		writeFileSync(join(on.checkout, "lib/a.ts"), "again\n");
		await git(on.checkout, "commit", "-q", "-am", "again");
		const sha = await git(on.checkout, "rev-parse", "HEAD");

		expect((await answer(on, GATE, [sha])).code).toBe(1);
	});

	it("leaves a deleted file out of the checks it asks for", async () => {
		const on = await harness();
		await change(on, ["lib/old.ts"]);
		await git(on.checkout, "push", "-q", "origin", "HEAD:main");
		await git(on.checkout, "fetch", "-q", "origin");
		const sha = await change(on, ["lib/a.ts"], ["lib/old.ts"]);
		kept(on, sha, checksOf(on, ["lib/a.ts"]));

		expect((await answer(on, GATE, [sha])).code).toBe(0);
	});

	it("says a machine with no keeper can't take any run as passed", async () => {
		const on = await harness();
		const sha = await change(on, ["lib/a.ts"]);
		writeFileSync(join(on.keeper, "none"), "");

		const gated = await answer(on, GATE, [sha]);

		expect(gated.code).toBe(1);
		expect(gated.said).toContain("runs no nix-offload keeper");
	});
});

describe("sending a change's checks", () => {
	it("prints, inside the fence, the very call whose kept pass the gate takes", async () => {
		const on = await harness();
		const sha = await change(on, ["lib/b.ts", "lib/a.ts"]);
		rmSync(join(on.home, ".local"), { recursive: true, force: true });

		const sent = await answer(on, SENDER, []);

		expect(sent.code).toBe(NOTHING_RAN);
		const call = sent.out.trim().split(" && nix-offload there ")[1] ?? "";
		const words = call.split(" ");
		kept(on, sha, words.slice(words.indexOf("--") + 1));
		expect((await answer(on, GATE, [sha])).code).toBe(0);
	});

	it("refuses a checkout with uncommitted changes, which wouldn't be what ran", async () => {
		const on = await harness();
		await change(on, ["lib/a.ts"]);
		writeFileSync(join(on.checkout, "lib/a.ts"), "edited\n");

		const sent = await answer(on, SENDER, []);

		expect(sent.code).toBe(2);
		expect(sent.said).toContain("uncommitted changes");
	});
});
