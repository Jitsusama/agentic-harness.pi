/**
 * The wrap each of a session's commands is put in
 * (lib/internal/fence/fence-mac-command.ts): on a Mac no sandbox holds pi,
 * the fence asked for is laid around each command by sandbox-exec, a
 * strict one started without the session's credentials too, and a
 * command the fence won't run, or whose profile doesn't apply, never
 * runs. A stand-in sandbox-exec runs the command as it is, so the
 * plumbing is proved on any machine; a real Mac proves the profile.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISK, type Disk } from "../../../../lib/internal/fence/fence-disk.ts";
import {
	commandWrapFor,
	macFenceSaid,
} from "../../../../lib/internal/fence/fence-mac-command.ts";
import { macSandbox } from "../../../../lib/internal/sandbox/mac-sandbox.ts";
import type { Sandbox } from "../../../../lib/internal/sandbox/sandbox.ts";

let home: string;
let work: string;
let laidProfile: string;
let standIn: string;
let unapplied: string;

beforeAll(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "fc-")));
	work = join(home, "work");
	mkdirSync(work);
	mkdirSync(join(home, "trees"));
	mkdirSync(join(home, "other"));
	writeFileSync(join(home, "other", "notes"), "theirs\n");
	laidProfile = join(home, "profile");
	// Runs what it is handed as it is, keeping the profile it was given,
	// with the Mac's own true and bash found where this machine keeps them.
	standIn = join(home, "sandbox-exec");
	writeFileSync(
		standIn,
		[
			"#!/bin/sh",
			'[ "$1" = -p ] || exit 9',
			`printf %s "$2" > '${laidProfile}'`,
			"shift 2",
			'case "$1" in /usr/bin/true) exit 0;; /bin/bash) shift; exec bash "$@";; esac',
			'exec "$@"',
			"",
		].join("\n"),
	);
	chmodSync(standIn, 0o755);
	// One whose profile never applies, as inside another sandbox.
	unapplied = join(home, "unapplied");
	writeFileSync(unapplied, "#!/bin/sh\nexit 1\n");
	chmodSync(unapplied, 0o755);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Where a Linux machine's lent builders live, one folder each, which no Mac has. */
const LENDERS = "/run/nix-offload";
const lent = (path: string) => path.startsWith(LENDERS);

/**
 * The disk without a Linux builder's folders, which no Mac has and
 * which make a profile past the 128 KiB Linux lets one argument be.
 */
const withoutLenders: Disk = {
	...DISK,
	kind: (path) => (lent(path) ? undefined : DISK.kind(path)),
	entries: (folder) => (lent(folder) ? [] : DISK.entries(folder)),
};

const seatbelt = (
	asked: "fence" | "strict",
	sandboxExec: string = standIn,
): Sandbox => ({ kind: "seatbelt", asked, sandboxExec });

/** `command` run as the session's shell would run it, in `cwd`. */
function ran(
	sandbox: Sandbox,
	command: string,
	cwd: string = work,
	env: NodeJS.ProcessEnv = {},
) {
	const offered = { PATH: process.env.PATH, HOME: home, LANG: "C", ...env };
	const wrap = commandWrapFor(sandbox, { cwd, env: offered }, home, {
		platform: "darwin",
		treesRoot: join(home, "trees"),
		heldTrees: [],
		disk: withoutLenders,
	});
	const answer = spawnSync("bash", ["-c", wrap?.(command) ?? command], {
		cwd: work,
		encoding: "utf8",
		env: offered,
	});
	expect(answer.error, "the session's shell didn't start").toBeUndefined();
	return answer;
}

describe("a Mac's command in the fence it lays itself", () => {
	it("runs in the fence's profile, its quoting and how it ended kept", () => {
		const answer = ran(
			seatbelt("fence"),
			`printf '%s\\n' "it's \\"said\\""; exit 3`,
		);
		expect(answer.stdout, "the command's own quoting didn't survive").toBe(
			`it's "said"\n`,
		);
		expect(answer.status, "the command's exit status was lost").toBe(3);
		const profile = readFileSync(laidProfile, "utf8");
		expect(profile, "no seatbelt profile was laid around it").toContain(
			"(version 1)",
		);
	});

	it("starts a strict command without the session's credentials, writing only its folder", () => {
		const answer = ran(
			seatbelt("strict"),
			`printf '%s' "\${GH_TOKEN:-none}"; exit 4`,
			work,
			{ GH_TOKEN: "held" },
		);
		expect(answer.stdout, "a strict command read the session's token").toBe(
			"none",
		);
		expect(answer.status, "the command's exit status was lost").toBe(4);
		const profile = readFileSync(laidProfile, "utf8");
		expect(
			profile,
			"strict's profile didn't grant writes to its folder",
		).toContain(`(allow file-read* file-write* (subpath "${work}"))`);
	});

	it("leaves a fence command the session's environment, as the fence on Linux does", () => {
		const answer = ran(seatbelt("fence"), `printf '%s' "$GH_TOKEN"`, work, {
			GH_TOKEN: "kept",
		});
		expect(answer.stdout, "the fence held back what it keeps").toBe("kept");
	});

	it("runs nothing in the home folder itself, saying why", () => {
		const answer = ran(seatbelt("strict"), "echo ran", home);
		expect(answer.stdout, "a command ran with the whole home to write").toBe(
			"",
		);
		expect(answer.status, "the refusal's status wasn't the fence's").toBe(126);
		expect(answer.stderr, "the refusal didn't say why").toMatch(/home/);
	});

	it("runs nothing when its profile doesn't apply", () => {
		const answer = ran(seatbelt("fence", unapplied), "echo ran");
		expect(answer.stdout, "the command ran without its profile").toBe("");
		expect(answer.status, "the refusal's status wasn't the fence's").toBe(126);
	});

	it("runs nothing in a work tree the session doesn't hold", () => {
		const theirs = join(home, "trees", "theirs");
		mkdirSync(theirs, { recursive: true });
		const answer = ran(seatbelt("fence"), "echo ran", theirs);
		expect(answer.stdout, "the command ran in another's tree").toBe("");
		expect(answer.stderr, "the refusal didn't say why").toMatch(
			/a work tree its asker doesn't hold/,
		);
	});

	it("leaves every other sandbox's wrap as it was", () => {
		const wrap = commandWrapFor({ kind: "none" }, { cwd: work, env: {} }, home);
		expect(wrap, "a session with no sandbox had its commands wrapped").toBe(
			undefined,
		);
	});

	it("tells the session what each fence keeps from its commands", () => {
		expect(macFenceSaid("strict"), "strict's guidance").toMatch(
			/strict sandbox.*credentials.*writes there only its working folder/,
		);
		expect(macFenceSaid("fence"), "the fence's guidance").toMatch(
			/agent fence.*keychain/,
		);
	});
});

/** Whether this Mac lays a profile, so one can be run, not only read. */
const sandboxes =
	process.platform === "darwin" &&
	existsSync("/usr/bin/sandbox-exec") &&
	macSandbox() !== "inside";

describe.skipIf(!sandboxes)("a strict command under sandbox-exec", () => {
	it("reads its folder, but no other file in the home", () => {
		const real = seatbelt("strict", "/usr/bin/sandbox-exec");
		writeFileSync(join(work, "mine"), "mine\n");
		expect(ran(real, "cat mine").stdout, "it couldn't read its folder").toBe(
			"mine\n",
		);
		const refused = ran(real, `cat '${join(home, "other", "notes")}'`);
		expect(refused.status, "it read another folder in the home").not.toBe(0);
		expect(refused.stderr).toContain("Operation not permitted");
	});
});
