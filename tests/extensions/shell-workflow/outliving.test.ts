/**
 * What a session is told about outliving a command: a transient service
 * where systemd can be reached, and where it can't, that nothing can.
 */

import { describe, expect, it } from "vitest";
import { outlivingIt } from "../../../extensions/shell-workflow/outliving.ts";

describe("outliving a command", () => {
	it("is a transient service of its own, in the command's folder, with nothing expanded, where nothing is sandboxed", () => {
		const said = outlivingIt("none");

		expect(said).toMatch(/transient service/);
		for (const part of [
			"systemd-run --user --unit=NAME --collect --same-dir --expand-environment=no",
			'--setenv=PATH="$PATH" --setenv=HOME="$HOME"',
			"-p RuntimeMaxSec=SECONDS",
			"a NAME of its own each run",
			"systemctl --user stop NAME",
			"journalctl --user -u NAME",
		]) {
			expect(said, `it says ${part}`).toContain(part);
		}
		expect(said, "it tells no secret to pass by --setenv").toMatch(
			/never a secret/,
		);
	});

	// On 21 November about 22 askpass windows reached the person in six
	// minutes, while services agents started ran ssh with the user
	// manager's SSH_ASKPASS and DISPLAY and no terminal.
	it("asks nothing on the person's screen from the service it starts", () => {
		const said = outlivingIt("none");
		expect(said.indexOf(" -- "), "its options end at a --").toBeGreaterThan(0);
		const options = said.slice(0, said.indexOf(" -- "));

		// Before the `--`, so systemd-run takes them rather than the command.
		for (const setting of [
			"--setenv=GIT_ASKPASS= ",
			"--setenv=SSH_ASKPASS= ",
			"--setenv=SSH_ASKPASS_REQUIRE=never ",
		])
			expect(options).toContain(setting);
	});

	// On 21 November a test suite run that way, with /tmp as its temp
	// folder, emptied /tmp three times, taking other runs' logs, caches
	// and Nix's pinned host keys with it.
	it("keeps the service's temp files in the command's temp folder, not the shared /tmp", () => {
		const said = outlivingIt("none");
		expect(said.indexOf(" -- "), "its options end at a --").toBeGreaterThan(0);
		const options = said.slice(0, said.indexOf(" -- "));

		// With no TMPDIR set, an empty one would be no folder at all.
		expect(options).toContain(`--setenv=TMPDIR="\${TMPDIR:-/tmp}" `);
	});

	it("says the service takes the user manager's environment, not none", () => {
		const said = outlivingIt("none");

		expect(said).toMatch(/user manager's environment, not the command's/);
		expect(said).not.toMatch(/starts with none of the command's environment/);
	});

	for (const kind of ["fence", "strict"] as const) {
		it(`is nothing a command can start, in the ${kind} sandbox`, () => {
			const said = outlivingIt(kind);

			expect(said).toMatch(/no command can reach systemd/);
			expect(said, "it offers no systemd-run").not.toMatch(/systemd-run/);
		});
	}
});
