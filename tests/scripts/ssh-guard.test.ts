/**
 * The ssh guard's programs, run as an agent's shell finds them: first on
 * PATH, before the real ssh, scp, sftp and rsync, which here are stand-ins
 * that say they ran (ssh-guard-stand-in.sh). The case it exists for is
 * 90VBWT's of 17 November: a script whose `cd` failed ran
 * `find . -type f -exec touch {} +` from Joel's home on his Mac, over
 * ssh, from inside a quest tool.
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
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SSH_GUARD_BIN } from "../../lib/internal/shell/ssh-guard.ts";
// Imported only to be named, so `--changed` runs this file when the
// stand-in changes alone; it runs it from its path below.
import "./ssh-guard-stand-in.sh";

const MACHINES = "optimus equilibrius";
const STAND_IN = fileURLToPath(
	new URL("./ssh-guard-stand-in.sh", import.meta.url),
);
/** bash, found where this test runs, by its full path. */
const BASH = spawnSync("bash", ["-c", "command -v bash"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
}).stdout.trim();
let place: string;
let real: string;
/** The few programs a script and the guard use, and no ssh among them. */
let tools: string;

/** A folder holding a link to the stand-in under each of `names`. */
function standIns(folder: string, names: readonly string[]): string {
	mkdirSync(folder, { recursive: true });
	for (const name of names) symlinkSync(STAND_IN, join(folder, name));
	return folder;
}

beforeAll(() => {
	place = mkdtempSync(join(tmpdir(), "ssh-guard-"));
	real = standIns(join(place, "real"), ["ssh", "scp", "sftp", "rsync"]);
	tools = join(place, "tools");
	mkdirSync(tools);
	for (const name of ["bash", "env", "echo", "cat", "tr", "sed"]) {
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
function run(
	script: string,
	machines = MACHINES,
	path = [SSH_GUARD_BIN, real, tools],
) {
	const ran = spawnSync(BASH, ["-c", script], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 20_000,
		env: {
			PATH: path.join(":"),
			HOME: place,
			PI_SSH_GUARD_MACHINES: machines,
			PI_SSH_GUARD_HERE: "optimus",
		},
	});
	return {
		status: ran.status,
		out: ran.stdout,
		err: ran.stderr,
		ranReal: ran.stderr.includes("REAL "),
	};
}

/** That `script` was refused for `machine`, naming the node's route. */
function refused(script: string, machine = "equilibrius"): void {
	const ran = run(script);
	expect(ran.ranReal, `${script}: ${ran.err}`).toBe(false);
	expect(ran.status, `${script}: ${ran.err}`).toBe(126);
	expect(ran.err, script).toContain(
		`mycelium run --need machine=${machine} --`,
	);
}

/** That `script` reached the real program. */
function passed(script: string): void {
	const ran = run(script);
	expect(ran.ranReal, `${script}: ${ran.err}`).toBe(true);
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
		refused(tool);
	});

	it("refuses the bare command that touched Joel's files", () => {
		refused("ssh equilibrius 'cd /missing && find . -type f -exec touch {} +'");
	});

	it("knows a machine past a login, a domain, its case, joined options and a URI", () => {
		refused("ssh joel@EQUILIBRIUS.local uname");
		refused("ssh -p22 -oBatchMode=yes -nT equilibrius uname");
		refused("ssh -i key -l joel optimus -- uname", "optimus");
		refused("ssh ssh://joel@equilibrius:22 uname");
		refused("ssh equilibrius -p 22 uname");
	});

	it("knows a machine by what ssh's settings connect to", () => {
		refused("ssh eq uname");
		refused("ssh eqip uname");
		refused("ssh 192.168.4.49 uname");
		refused("ssh -o HostName=equilibrius anything uname");
		refused("ssh localhost uname", "optimus");
	});

	it("reads the call's own settings wherever they are written", () => {
		refused("ssh other-host -o HostName=equilibrius uname");
		refused("ssh -P work eq uname");
		const settings = join(place, "settings");
		writeFileSync(settings, "Host anything\n  HostName equilibrius\n");
		refused(`ssh -F ${settings} anything uname`);
	});

	it("knows this machine by each spelling of its loopback on ssh's port", () => {
		refused("ssh 127.1 uname", "optimus");
		refused("ssh -p 22 localhost uname", "optimus");
		refused("scp '[::1]:/x' .", "optimus");
		refused("scp ./a 'joel@[::1]:/x'", "optimus");
	});

	it("knows a realm machine reached through a forward on the loopback", () => {
		const settings = join(place, "forwarded");
		writeFileSync(settings, "Host equilibrius\n  HostName localhost\n");
		refused(`ssh -F ${settings} -p 2222 equilibrius uname`);
	});

	it("keeps a realm machine tunnelled through the loopback from claiming every loopback port", () => {
		const machines = `${MACHINES} tunnelled`;
		const byName = run("ssh tunnelled uname", machines);
		expect(byName.ranReal, byName.err).toBe(false);
		expect(byName.err).toContain("mycelium run --need machine=tunnelled --");
		const vm = run("ssh -p 2222 localhost uname", machines);
		expect(vm.ranReal, `a local VM: ${vm.err}`).toBe(true);
		const copy = run("scp -P 2222 ./a localhost:/x", machines);
		expect(copy.ranReal, `a copy to a local VM: ${copy.err}`).toBe(true);
	});

	it("reads ssh's destination whole, an IPv6 address too", () => {
		refused("ssh -p 22 ::1 uname", "optimus");
		refused("ssh 2001:db8:0:0:0:0:0:49 uname");
	});

	it("still refuses when a caller says it is the guard's own lookup", () => {
		refused("PI_SSH_GUARD_LOOKUP=1 ssh equilibrius uname");
	});

	it("refuses a script fed to a realm machine's login shell", () => {
		refused("echo 'touch x' | ssh equilibrius");
	});

	it("refuses copies to and from a realm machine, by scp, sftp and rsync", () => {
		refused("scp -q -o BatchMode=yes ./probe equilibrius:/tmp/pi-probe");
		refused("scp -P 22 optimus:/etc/hosts .", "optimus");
		refused("scp ./a scp://joel@equilibrius:22/tmp/a");
		refused("scp -o HostName=equilibrius ./a anything:/tmp/a");
		refused("sftp -b batch equilibrius");
		refused("sftp joel@equilibrius:/tmp");
		refused("rsync -a ./src/ equilibrius:/tmp/src/");
		refused("rsync -e 'ssh -p 22' -a joel@optimus:/x ./x", "optimus");
	});
});

describe("the ssh guard passes everything else to the real program", () => {
	it("passes another host, a local copy and ssh's own questions", () => {
		passed("ssh aquifer-deploy-host-delta-5jjx uname");
		passed("ssh optimus.example.com uname");
		passed("ssh -N -L 8080:localhost:80 equilibrius");
		passed("ssh equilibrius -N -L 8080:localhost:80");
		passed("ssh -O check equilibrius");
		passed("ssh -W localhost:22 equilibrius");
		passed("scp ./a ./b");
		passed("scp ./a other-host:/tmp/a");
		passed("rsync -a ./src/ ./dst/");
		passed("rsync -a ./src/ equilibrius::module/");
		passed("sftp other-host");
	});

	it("passes a local VM or container, on the loopback at another port", () => {
		passed("ssh -p 2222 localhost uname");
		passed("scp -P 2222 ./a localhost:/x");
		passed("scp ./a scp://localhost:2222/x");
		passed("ssh ssh://joel@localhost:2222 uname");
		passed("rsync -a -e 'ssh -p 2222' ./a localhost:/x");
		passed("rsync -a --rsh='ssh -p 2222' ./a localhost:/x");
		refused("rsync -a -e 'ssh -p 22' ./a localhost:/x", "optimus");
	});

	it("reaches the same ssh from a ProxyCommand's ssh, which that ssh started", () => {
		// A program, as a real ssh is: no `#!` line, which bash runs anyway.
		// Asked to, it runs `ssh` by name, as a ProxyCommand does.
		const program = join(place, "program");
		mkdirSync(program);
		writeFileSync(
			join(program, "ssh"),
			'[ "$2" = proxy ] && exec ssh -W other-host:22 jump\necho "PROGRAM ssh $*" >&2\n',
		);
		chmodSync(join(program, "ssh"), 0o755);
		const ran = run("ssh jump proxy", MACHINES, [
			SSH_GUARD_BIN,
			program,
			real,
			tools,
		]);
		expect(ran.status, ran.err).toBe(0);
		expect(ran.err.trim()).toBe("PROGRAM ssh -W other-host:22 jump");
	});

	it("ends a wrapper that only ever calls ssh by name, running nothing", () => {
		const only = join(place, "only-wrapper");
		mkdirSync(only);
		writeFileSync(join(only, "ssh"), '#!/usr/bin/env bash\nexec ssh "$@"\n');
		chmodSync(join(only, "ssh"), 0o755);
		const ran = run("ssh other-host uname", MACHINES, [
			SSH_GUARD_BIN,
			only,
			tools,
		]);
		expect(ran.status, ran.err).toBe(127);
		expect(ran.err).toContain("no ssh on PATH after the guard's own");
	});

	it("answers ssh -G with the settings themselves", () => {
		const ran = run("ssh -G eq");
		expect(ran.status, ran.err).toBe(0);
		expect(ran.out).toContain("hostname equilibrius.lan");
	});

	it("passes every argument through as given", () => {
		const ran = run("ssh other-host 'echo \"a b\"' '' c");
		expect(ran.err.trim()).toBe('REAL ssh [other-host][echo "a b"][][c]');
	});

	it("refuses nothing when no realm machine is named", () => {
		const ran = run("ssh equilibrius uname", "");
		expect(ran.ranReal, ran.err).toBe(true);
	});

	it("reaches the real ssh past a second guard folder and a wrapper calling ssh by name", () => {
		const second = join(place, "second-guard");
		mkdirSync(join(second, "bin"), { recursive: true });
		writeFileSync(join(second, "guard.bash"), "");
		symlinkSync(join(SSH_GUARD_BIN, "ssh"), join(second, "bin", "ssh"));
		const wrapper = join(place, "wrapper");
		mkdirSync(wrapper);
		writeFileSync(join(wrapper, "ssh"), '#!/usr/bin/env bash\nexec ssh "$@"\n');
		chmodSync(join(wrapper, "ssh"), 0o755);
		const ran = run("ssh other-host uname", MACHINES, [
			SSH_GUARD_BIN,
			join(second, "bin"),
			wrapper,
			real,
			tools,
		]);
		expect(ran.status, ran.err).toBe(0);
		expect(ran.err.trim()).toBe("REAL ssh [other-host][uname]");
	});
});
