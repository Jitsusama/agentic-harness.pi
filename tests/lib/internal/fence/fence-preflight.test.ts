/**
 * The pre-flight's verdicts: a throw is a failure, the report says each
 * check, and the exit status lets the install go only when every check
 * passed.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	refusedAs,
	reportLine,
	runChecks,
	succeeded,
	summary,
	type Verdict,
} from "../../../../lib/internal/fence/fence-preflight.ts";
import {
	gcloudKeyProbe,
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

describe("whether gcloud's key read inside as the stand-in", () => {
	const standIn = createHash("sha256").update(KEY_STAND_IN).digest("hex");
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
		expect(readsAsStandIn(probed(KEY_STAND_IN))).toBe(true);
	});

	it("reads the person's real key as no stand-in", () => {
		expect(
			readsAsStandIn(probed("-----BEGIN OPENSSH PRIVATE KEY-----\n")),
		).toBe(false);
	});

	it("reads an emptied or missing key as unread", () => {
		expect(probed("").out.trim(), "emptied").toBe("unread");
		expect(readsAsStandIn(probed(undefined)), "missing").toBe(true);
	});

	it("fails, rather than saying unread, where its tools are missing", () => {
		const ran = probed("-----BEGIN OPENSSH PRIVATE KEY-----\n", folder);
		expect(ran.code).toBe(127);
		expect(readsAsStandIn(ran)).toBe(false);
	});
});
