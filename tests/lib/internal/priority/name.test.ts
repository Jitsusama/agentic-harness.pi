import { describe, expect, it } from "vitest";
import { workNameIn } from "../../../../lib/internal/priority/name.ts";

describe("the plain name of what a job builds", () => {
	it("names a check, a package and a machine by the part a person chose", () => {
		expect(
			workNameIn([
				"nix build --no-link -L .#checks.x86_64-linux.vm-desktop-launcher-answers",
			]),
		).toBe("vm-desktop-launcher-answers");
		expect(workNameIn(["nix build .#packages.aarch64-darwin.pi-ask"])).toBe(
			"pi-ask",
		);
		expect(
			workNameIn([
				'nix build -L "path:/w/zone-next3#nixosConfigurations.penelope.config.system.build.toplevel"',
			]),
		).toBe("penelope");
		expect(workNameIn(["nix build .#devShells.x86_64-linux.default"])).toBe(
			"default",
		);
		expect(workNameIn(["nix build .#foo.bar"])).toBe("foo.bar");
	});

	it("leaves out a path still holding a shell variable", () => {
		// What Y2YBTS saw: a loop whose `what` names nothing until it runs.
		expect(
			workNameIn(["for c in a b; do nix build .#checks.x86_64-linux.$c; done"]),
		).toBeUndefined();
		expect(
			workNameIn(['nix build "$F#checks.x86_64-linux.vm-$t"']),
		).toBeUndefined();
	});

	it("reads the expanded name from a running job's processes", () => {
		expect(
			workNameIn([
				"bash -c for c in a b; do nix build .#checks.x86_64-linux.$c; done",
				"nix build --no-link -L .#checks.x86_64-linux.formatting",
			]),
		).toBe("formatting");
	});

	it("says several as the first and how many more, each once", () => {
		expect(
			workNameIn([
				"nix build .#checks.x86_64-linux.a .#checks.x86_64-linux.b",
				"nix build .#checks.x86_64-linux.a",
			]),
		).toBe("a and 1 more");
	});

	it("names nothing a command doesn't build from a flake", () => {
		expect(workNameIn(["cargo test -p walgit"])).toBeUndefined();
		expect(workNameIn([])).toBeUndefined();
	});
});
