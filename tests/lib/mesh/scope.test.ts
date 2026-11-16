/**
 * Scope: the groups a peer's work puts it in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupNamed, hears } from "../../../lib/mesh/group.ts";
import { part, repositoryKey, scopesOf } from "../../../lib/mesh/scope.ts";

describe("a peer's scopes", () => {
	it("name its quest down from the root, so the root's group reaches it", () => {
		const [quest = ""] = scopesOf({
			questChain: ["QEST-20261021-LUQ49E", "QEST-20261021-5GV2AH"],
			repositories: [],
		});

		expect(quest).toBe("#quest/5gv2ah/luq49e");
		expect(
			hears([quest], "#quest/5gv2ah"),
			"the root quest's group reaches it",
		).toBe(true);
		expect(
			hears([quest], "#quest/7m6jkg"),
			"another quest's group does not reach it",
		).toBe(false);
	});

	it("give each repository its group, named as a group can be", () => {
		expect(
			scopesOf({
				questChain: [],
				repositories: ["agentic-harness.pi", "core.nix", "agentic-harness.pi"],
			}),
		).toEqual(["#repo/agentic-harness-pi", "#repo/core-nix"]);
	});

	it("are only ever groups the mesh can read", () => {
		for (const scope of scopesOf({
			questChain: ["QEST-20261021-AB_C9Z"],
			repositories: ["..Weird Repo!!", "---"],
		})) {
			expect(groupNamed(scope)).toBe(scope);
		}
	});

	it("give each orchestration it is in its group, named by the orchestrator's address", () => {
		const scopes = scopesOf({
			questChain: ["QEST-20261025-QCXZEB", "QEST-20261007-WCJQSG"],
			repositories: [],
			orchestrations: ["QEST-20261007-WCJQSG"],
		});

		expect(scopes).toEqual(["#orchestration/wcjqsg", "#quest/wcjqsg/qcxzeb"]);
		for (const scope of scopes) expect(groupNamed(scope)).toBe(scope);
	});

	it("put a nested orchestrator in its own orchestration and the one above", () => {
		expect(
			scopesOf({
				questChain: [],
				repositories: [],
				orchestrations: ["QEST-20261007-WCJQSG", "QEST-20261026-SWARM1"],
			}),
		).toEqual(["#orchestration/swarm1", "#orchestration/wcjqsg"]);
	});

	it("are none for a peer on no quest outside any repository", () => {
		expect(scopesOf({ questChain: [], repositories: [] })).toEqual([]);
	});
});

describe("a checkout's repository key", () => {
	/** A checkout whose origin is `url`, or that has none. */
	function checkoutWith(url: string | undefined): string {
		const at = mkdtempSync(join(tmpdir(), "scope-key-"));
		mkdirSync(join(at, ".git"));
		const origin = url ? `[remote "origin"]\n\turl = ${url}\n` : "";
		writeFileSync(
			join(at, ".git", "config"),
			`[core]\n\tbare = false\n${origin}`,
		);
		return at;
	}

	it("names GitHub as github and any other host by its name", () => {
		const cases: [string, string][] = [
			[
				"https://github.com/Jitsusama/mycelium.git",
				"github:Jitsusama/mycelium",
			],
			["git@github.com:Jitsusama/core.nix.git", "github:Jitsusama/core.nix"],
			[
				"https://delta.example.io/shop/world.git",
				"delta.example.io:shop/world",
			],
		];
		for (const [url, key] of cases) {
			const at = checkoutWith(url);
			expect(repositoryKey(at), url).toBe(key);
			rmSync(at, { recursive: true, force: true });
		}
	});

	it("is nothing without an origin", () => {
		const at = checkoutWith(undefined);
		expect(repositoryKey(at)).toBeUndefined();
		rmSync(at, { recursive: true, force: true });
	});
});

describe("a name as part of a group", () => {
	it("keeps letters, digits and dashes, lower-cased", () => {
		expect(part("Agentic-Harness.PI")).toBe("agentic-harness-pi");
	});
});
