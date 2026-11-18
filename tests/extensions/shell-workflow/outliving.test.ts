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

	for (const kind of ["fence", "strict"] as const) {
		it(`is nothing a command can start, in the ${kind} sandbox`, () => {
			const said = outlivingIt(kind);

			expect(said).toMatch(/no command can reach systemd/);
			expect(said, "it offers no systemd-run").not.toMatch(/systemd-run/);
		});
	}
});
