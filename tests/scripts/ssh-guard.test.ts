/**
 * The ssh guard's programs, run as an agent's shell finds them: first on
 * PATH, before the real ssh, scp, sftp and rsync, which here are stand-ins
 * that say they ran. The case it exists for is 90VBWT's of 17 November: a
 * script whose `cd` failed ran `find . -type f -exec touch {} +` from
 * Joel's home on his Mac, over ssh, from inside a quest tool.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SSH_GUARD_BIN } from "../../lib/internal/shell/ssh-guard.ts";

const MACHINES = "optimus equilibrius";
/** bash, found where this test runs, by its full path. */
const BASH = spawnSync("bash", ["-c", "command -v bash"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
}).stdout.trim();
let place: string;
let real: string;
/** The few programs a script and the guard use, and no ssh among them. */
let tools: string;

/** A stand-in for `name` that says it ran, and answers `ssh -G` for one alias. */
function standIn(name: string): void {
	const path = join(real, name);
	writeFileSync(
		path,
		[
			"#!/usr/bin/env bash",
			`echo "REAL ${name} $*" >&2`,
			'if [ "$1" = -G ]; then',
			'  case "$2" in eq) echo "hostname equilibrius.lan" ;; *) echo "hostname $2" ;; esac',
			"  exit 0",
			"fi",
			`echo "ran ${name} $*"`,
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
}

beforeAll(() => {
	place = mkdtempSync(join(tmpdir(), "ssh-guard-"));
	real = join(place, "real");
	mkdirSync(real);
	for (const name of ["ssh", "scp", "sftp", "rsync"]) standIn(name);
	tools = join(place, "tools");
	mkdirSync(tools);
	for (const name of ["bash", "env", "echo", "cat", "tr"]) {
		const found = spawnSync(BASH, ["-c", `type -P ${name}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).stdout.trim();
		if (found) symlinkSync(found, join(tools, name));
	}
});

afterAll(() => rmSync(place, { recursive: true, force: true }));

/**
 * Run `script` in bash as the agent's shell would, the guard first on
 * PATH and only stand-ins after it, so no real ssh can be reached. Its
 * stdin is no socket: bash given one sources the system's bashrc, which
 * on NixOS sets PATH again.
 */
function run(script: string, machines = MACHINES) {
	const ran = spawnSync(BASH, ["-c", script], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			PATH: [SSH_GUARD_BIN, real, tools].join(":"),
			HOME: place,
			PI_SSH_GUARD_MACHINES: machines,
		},
	});
	return {
		status: ran.status,
		out: ran.stdout,
		err: ran.stderr,
		ranReal: ran.stderr.includes("REAL "),
	};
}

describe("the ssh guard refuses a command run on a realm machine", () => {
	it("refuses 90VBWT's script, which called ssh from inside a tool", () => {
		const tool = join(place, "v3-prove");
		writeFileSync(
			tool,
			[
				"#!/usr/bin/env bash",
				"eq_key=$HOME/.ssh/id_ecdsa.pub",
				'set -- -o BatchMode=yes -o IdentitiesOnly=yes -o "IdentityFile=$eq_key"',
				"ssh -n \"$@\" equilibrius 'bash -s -- 9099 786a'",
				"",
			].join("\n"),
		);
		chmodSync(tool, 0o755);
		const ran = run(tool);
		expect(ran.ranReal, ran.out).toBe(false);
		expect(ran.status).toBe(126);
		expect(ran.err).toContain("mycelium run --need machine=equilibrius --");
	});

	it("refuses the bare command that touched Joel's files", () => {
		const ran = run(
			"ssh equilibrius 'cd /missing && find . -type f -exec touch {} +'",
		);
		expect(ran.ranReal, ran.out).toBe(false);
		expect(ran.status).toBe(126);
	});

	it("knows a machine past a login, a domain, its case and joined options", () => {
		for (const script of [
			"ssh joel@EQUILIBRIUS.local uname",
			"ssh -p22 -oBatchMode=yes -nT equilibrius uname",
			"ssh -i key -l joel optimus -- uname",
			"ssh eq uname",
		]) {
			const ran = run(script);
			expect(ran.ranReal, `${script}: ${ran.out}`).toBe(false);
		}
	});

	it("refuses a script fed to a realm machine's login shell", () => {
		const ran = run("echo 'touch x' | ssh equilibrius");
		expect(ran.ranReal, ran.out).toBe(false);
	});

	it("refuses copies to and from a realm machine, by scp, sftp and rsync", () => {
		for (const script of [
			"scp -q -o BatchMode=yes ./probe equilibrius:/tmp/pi-probe",
			"scp -P 22 optimus:/etc/hosts .",
			"sftp -b batch equilibrius",
			"rsync -a ./src/ equilibrius:/tmp/src/",
			"rsync -e 'ssh -p 22' -a joel@optimus:/x ./x",
		]) {
			const ran = run(script);
			expect(ran.ranReal, `${script}: ${ran.out}`).toBe(false);
			expect(ran.status, script).toBe(126);
		}
	});
});

describe("the ssh guard passes everything else to the real program", () => {
	it("passes another host, a local copy and ssh's own questions", () => {
		for (const script of [
			"ssh aquifer-deploy-host-delta-5jjx uname",
			"ssh -G equilibrius",
			"ssh -N -L 8080:localhost:80 equilibrius",
			"scp ./a ./b",
			"scp ./a other-host:/tmp/a",
			"rsync -a ./src/ ./dst/",
			"sftp other-host",
		]) {
			const ran = run(script);
			expect(ran.ranReal, `${script}: ${ran.err}`).toBe(true);
		}
	});

	it("passes every argument through as given", () => {
		const ran = run("ssh other-host 'echo \"a b\"' c");
		expect(ran.out.trim()).toBe('ran ssh other-host echo "a b" c');
	});

	it("refuses nothing when no realm machine is named", () => {
		const ran = run("ssh equilibrius uname", "");
		expect(ran.ranReal, ran.err).toBe(true);
	});
});
