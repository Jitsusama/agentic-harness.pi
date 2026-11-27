/**
 * The pre-flight's verdicts: a throw is a failure, the report says each
 * check, and the exit status lets the install go only when every check
 * passed.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_STAND_IN } from "../../../../lib/internal/fence/fence-gcloud-ssh.ts";
import {
	type Check,
	exitStatus,
	failed,
	inSession,
	type PreflightContext,
	passed,
	type Ran,
	refusedAs,
	reportLine,
	runChecks,
	succeeded,
	summary,
	type Verdict,
} from "../../../../lib/internal/fence/fence-preflight.ts";
import {
	gcloudKeyProbe,
	hiddenVerdict,
	keyProbed,
	readsAsStandIn,
} from "../../../../lib/internal/fence/fence-preflight-checks.ts";

const CONTEXT: PreflightContext = {
	session: "s",
	repo: "/r",
	scratch: "/tmp",
	heavy: false,
};

function check(id: string, run: () => Promise<Verdict>): Check {
	return { id, group: "agents", what: `check ${id}`, run };
}

describe("running the pre-flight's checks", () => {
	it("counts a check that throws as failed, and runs the rest", async () => {
		const verdicts = await runChecks(
			[
				check("1", async () => {
					throw new Error("no socket");
				}),
				check("2", async () => passed("fine")),
			],
			CONTEXT,
		);
		expect(
			verdicts.map(([, verdict]) => verdict),
			"each check's verdict",
		).toEqual([failed("threw: no socket"), passed("fine")]);
	});

	it("installs only when every check passed", async () => {
		const all = (verdict: Verdict) =>
			runChecks(
				[check("1", async () => passed("a")), check("2", async () => verdict)],
				CONTEXT,
			);
		expect(exitStatus(await all(passed("b"))), "every check passed").toBe(0);
		expect(exitStatus(await all(failed("b"))), "one failed").toBe(1);
		expect(exitStatus(await all(inSession("b"))), "one left to a session").toBe(
			2,
		);
	});

	it("says each check and what came of it", async () => {
		const verdicts = await runChecks(
			[
				check("7a", async () => failed("gh refused")),
				check("8", async () => inSession("do it")),
			],
			CONTEXT,
		);
		expect(
			verdicts.map(([c, v]) => reportLine(c, v)),
			"a line a check",
		).toEqual(["FAIL 7a   check 7a: gh refused", "TODO 8    check 8: do it"]);
		expect(summary(verdicts), "the summary's verdict").toBe(
			"0 passed, 1 failed, 1 for a session to do: the fence doesn't install.",
		);
	});
});

describe("judging a command's run", () => {
	const ran = (code: number | null) => ({
		code,
		out: "out",
		err: "err",
		ms: 5,
	});

	it("passes a command that should succeed only on exit 0", () => {
		expect(succeeded(ran(0), "git fetch").outcome, "exit 0").toBe("passed");
		expect(succeeded(ran(128), "git fetch"), "exit 128").toEqual(
			failed("git fetch exited 128 after 5 ms: out / err"),
		);
		expect(succeeded(ran(null), "git fetch").said, "stopped").toContain(
			"stopped",
		);
	});

	it("passes a command that must be refused only when it didn't succeed", () => {
		expect(refusedAs(ran(1), "touch").outcome, "refused").toBe("passed");
		expect(refusedAs(ran(0), "touch").outcome, "let through").toBe("failed");
	});
});

/**
 * The stand-in's digest, as sha256sum prints it. A probe that read the
 * stand-in says it; one that found no key says only `unread`, which
 * readsAsStandIn takes too, so a test meaning the key was read checks for
 * this as well.
 */
const STAND_IN_DIGEST = createHash("sha256").update(KEY_STAND_IN).digest("hex");

describe("whether gcloud's key read inside as the stand-in", () => {
	const standIn = STAND_IN_DIGEST;
	const real = createHash("sha256").update("PRIVATE\n").digest("hex");

	it.each([
		["the stand-in's digest", { code: 0, out: `${standIn}  -\n` }, true],
		[
			"after what the wrap printed",
			{ code: 0, out: `pi: note\n${standIn}  -\n` },
			true,
		],
		["the probe's own unread", { code: 0, out: "unread\n" }, true],
		["another key's digest", { code: 0, out: `${real}  -\n` }, false],
		["nothing said, though it ran", { code: 0, out: "" }, false],
		[
			"a probe that failed, though it said unread",
			{ code: 1, out: "unread\n" },
			false,
		],
		["a probe killed at its time limit", { code: null, out: "" }, false],
		["a refused wrap", { code: 126, out: "" }, false],
	])("takes %s as %s", (_, ran, standsIn) => {
		expect(readsAsStandIn(ran)).toBe(standsIn);
	});
});

describe("the probe of gcloud's key, run as the fence runs it", () => {
	// bash by its own path, so a PATH without the probe's tools still finds it.
	const BASH = spawnSync("bash", ["-c", 'printf %s "$BASH"'], {
		encoding: "utf8",
	}).stdout;
	let folder = "";

	beforeEach(() => {
		folder = mkdtempSync(join(tmpdir(), "gcloud-probe-"));
	});

	afterEach(() => {
		rmSync(folder, { recursive: true, force: true });
	});

	/** The probe's run over a key saying `text`, or none where it's undefined. */
	function probed(
		text: string | undefined,
		path = process.env.PATH ?? "",
	): { code: number | null; out: string } {
		const key = join(folder, "google_compute_engine");
		if (text !== undefined) writeFileSync(key, text);
		// stdin from /dev/null: on a socket, as node gives it, bash takes
		// itself for a remote shell and reads the system's bashrc, which
		// sets PATH afresh.
		const ran = spawnSync(BASH, ["-c", gcloudKeyProbe(key)], {
			encoding: "utf8",
			env: { PATH: path },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: ran.status, out: ran.stdout };
	}

	it("reads the stand-in as the stand-in", () => {
		const ran = probed(KEY_STAND_IN);
		expect(ran.out).toContain(STAND_IN_DIGEST);
		expect(readsAsStandIn(ran), "the stand-in").toBe(true);
	});

	// A probe that fails outright reads as no stand-in too, so the key's
	// own digest is what shows it was read.
	it("reads the person's real key as no stand-in", () => {
		const real = "-----BEGIN OPENSSH PRIVATE KEY-----\n";
		const ran = probed(real);
		expect(ran.code, "the probe ran through").toBe(0);
		expect(ran.out).toContain(createHash("sha256").update(real).digest("hex"));
		expect(readsAsStandIn(ran), "the person's real key").toBe(false);
	});

	it("reads an emptied or missing key as unread", () => {
		expect(probed("").out.trim(), "emptied").toBe("unread");
		expect(readsAsStandIn(probed(undefined)), "missing").toBe(true);
	});

	it("fails, rather than saying unread, where its tools are missing", () => {
		const ran = probed("-----BEGIN OPENSSH PRIVATE KEY-----\n", folder);
		expect(ran.code).toBe(127);
		expect(readsAsStandIn(ran), "its tools missing").toBe(false);
	});

	it("fails, rather than saying unread, where head alone is missing", () => {
		// A folder holding sha256sum but not head: without the guard, head's
		// failing to run would read as the key hidden, and say unread.
		const tools = join(folder, "tools");
		mkdirSync(tools);
		const sum = spawnSync("bash", ["-c", "command -v sha256sum"], {
			encoding: "utf8",
		}).stdout.trim();
		symlinkSync(sum, join(tools, "sha256sum"));
		const ran = probed("-----BEGIN OPENSSH PRIVATE KEY-----\n", tools);
		expect(ran.code).not.toBe(0);
		expect(ran.out.trim()).not.toBe("unread");
		expect(readsAsStandIn(ran), "head missing").toBe(false);
	});

	it("takes a path a shell would split or expand as one word", () => {
		const odd = join(folder, "it's $HOME key");
		writeFileSync(odd, KEY_STAND_IN);
		const ran = spawnSync(BASH, ["-c", gcloudKeyProbe(odd)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(ran.stdout).toContain(STAND_IN_DIGEST);
		expect(
			readsAsStandIn({ code: ran.status, out: ran.stdout }),
			"an odd path read as one word",
		).toBe(true);
	});
});

describe("what the preflight makes of the key's probe", () => {
	const key = "/home/one/.ssh/google_compute_engine";
	const standIn = STAND_IN_DIGEST;
	const ran = (code: number | null, out: string): Ran => ({
		code,
		out,
		err: "bwrap: refused",
		ms: 5,
	});

	it("finds nothing where the key reads as the stand-in or unread", () => {
		expect(keyProbed(key, ran(0, `${standIn}  -\n`))).toEqual({});
		expect(keyProbed(key, ran(0, "unread\n"))).toEqual({});
	});

	it("names the key where it read as anything else", () => {
		expect(keyProbed(key, ran(0, `${"0".repeat(64)}  -\n`))).toEqual({
			read: key,
		});
	});

	it("says it couldn't probe, rather than that it read, where the probe failed", () => {
		const failedRun = keyProbed(key, ran(127, ""));
		expect(failedRun.read).toBeUndefined();
		expect(failedRun.unprobed).toContain(
			`couldn't probe ${key} inside (exit 127)`,
		);
		expect(keyProbed(key, ran(null, "")).unprobed).toContain("exit stopped");
	});

	it("says it couldn't probe where the probe ended 0 saying neither unread nor a digest", () => {
		const odd = keyProbed(key, ran(0, "bwrap: some notice\n"));
		expect(odd.read).toBeUndefined();
		expect(odd.unprobed).toContain("said neither unread nor a digest");
	});
});

describe("the hidden files' verdict", () => {
	const key = "/home/one/.ssh/google_compute_engine";

	it("passes only where nothing read and the key held", () => {
		expect(hiddenVerdict(3, [], {})).toEqual({
			outcome: "passed",
			said: "3 hidden files, none readable inside",
		});
	});

	it("fails naming gcloud's key where its probe read it", () => {
		expect(hiddenVerdict(3, ["/home/one/.netrc"], { read: key })).toEqual({
			outcome: "failed",
			said: `readable inside: /home/one/.netrc, ${key}`,
		});
	});

	it("fails saying why where the key couldn't be probed", () => {
		expect(hiddenVerdict(3, [], { unprobed: "couldn't probe it" })).toEqual({
			outcome: "failed",
			said: "couldn't probe it",
		});
	});
});
