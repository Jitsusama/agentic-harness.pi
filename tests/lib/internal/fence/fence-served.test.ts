/**
 * The fence drawn for a language server, which runs code the project
 * picked on a hover: of the runtime folder it reaches only the Nix
 * daemon's door for sandboxes, which takes its caller as untrusted,
 * and nothing that acts as the person.
 */

import { describe, expect, it } from "vitest";
import { fenceArgs, fenceRules } from "../../../../lib/internal/fence/fence.ts";
import type { Disk } from "../../../../lib/internal/fence/fence-disk.ts";

/** A disk where every path is a folder, and every folder empty. */
const everyFolder: Disk = { kind: () => "folder", entries: () => [] };

describe("a language server's fence", () => {
	const place = {
		home: "/home/someone",
		runtimeDir: "/run/user/1000",
		served: true,
	};
	const inRuntime = (paths: readonly (string | undefined)[]) =>
		paths.filter((path) => path?.startsWith(place.runtimeDir));

	it("binds back only Nix's door for sandboxes of the runtime folder", () => {
		const args = fenceArgs(place, everyFolder);
		const bound = args.flatMap((arg, at) =>
			arg === "--ro-bind" ? [args[at + 1]] : [],
		);

		expect(inRuntime(bound)).toEqual(["/run/user/1000/nix-untrusted.sock"]);
	});

	it("tells Landlock of only Nix's door in the runtime folder", () => {
		const rules = fenceRules(place);
		const sockets = rules.flatMap((rule, at) =>
			rule === "--unix" ? [rules[at + 1]] : [],
		);

		expect(inRuntime(sockets)).toEqual(["/run/user/1000/nix-untrusted.sock"]);
	});
});
