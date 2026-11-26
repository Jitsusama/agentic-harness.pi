/**
 * Scope: the groups a peer's work puts it in.
 */
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	groupNamed,
	hears,
	isJoinable,
	MOST_GROUP_CHARS,
} from "../../../lib/mesh/group.ts";
import {
	part,
	repositoryKey,
	repositoryName,
	scopesOf,
} from "../../../lib/mesh/scope.ts";

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

	// A presence drops a group longer than one may run, and a send to
	// one is refused, so a long repository name is cut to fit where its
	// group is made, the same for every peer in it (#2217's third council).
	it("cut a long repository's group to the most a group may run", () => {
		const name = `a-${"long-name-".repeat(12)}repo`;
		const [scope = ""] = scopesOf({ questChain: [], repositories: [name] });

		expect(scope.length).toBeLessThanOrEqual(MOST_GROUP_CHARS);
		expect(isJoinable(scope), "a peer can join it").toBe(true);
		expect(groupNamed(scope), "it reads back as itself").toBe(scope);
		expect(scope.startsWith("#repo/a-long-name-")).toBe(true);
		expect(scope.endsWith("-"), "no dash left hanging").toBe(false);
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
	/** Every config here is padded to this size, so a rewrite keeps it. */
	const CONFIG_BYTES = 160;

	/** A config whose origin is `url`, or that has none, padded by a comment. */
	function configFor(url: string | undefined): string {
		const origin = url ? `[remote "origin"]\n\turl = ${url}\n` : "";
		const text = `[core]\n\tbare = false\n${origin}`;
		return `${text}#${" ".repeat(CONFIG_BYTES - text.length - 2)}\n`;
	}

	/** A checkout whose origin is `url`, or that has none. */
	function checkoutWith(url: string | undefined): string {
		const at = mkdtempSync(join(tmpdir(), "scope-key-"));
		mkdirSync(join(at, ".git"));
		writeFileSync(join(at, ".git", "config"), configFor(url));
		return at;
	}

	/** A whole second, since a Date can't carry a file's finer time back. */
	const stood = new Date("2026-11-19T12:00:00Z");

	/** A second after `stood`, as a later write would leave it. */
	const later = new Date(stood.getTime() + 1_000);

	/** Write `text` over `file` in place, leaving its time at `stood`. */
	function rewrite(file: string, text: string): void {
		writeFileSync(file, text);
		utimesSync(file, stood, stood);
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
			[
				"https://x-access-token:secret@github.com/Jitsusama/mycelium.git",
				"github:Jitsusama/mycelium",
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

	// Every presence publish asks for each held tree's key, and core.nix's
	// config is half a megabyte: rereading it each time held the host's
	// loop busy (19 November).
	// So the case below can tell a read kept from a read again, a rewrite in
	// place at the same time and size is the one change it can't see.
	it("keeps what it read while the config's time, size and file stand", () => {
		const at = checkoutWith("https://github.com/Jitsusama/mycelium.git");
		const config = join(at, ".git", "config");
		try {
			utimesSync(config, stood, stood);
			expect(repositoryKey(at)).toBe("github:Jitsusama/mycelium");
			rewrite(config, configFor("https://github.com/Jitsusama/core.nix.git"));
			expect(repositoryKey(at), "a config that stands is not read again").toBe(
				"github:Jitsusama/mycelium",
			);
			utimesSync(config, stood, later);
			expect(repositoryKey(at), "a config whose time moved is read again").toBe(
				"github:Jitsusama/core.nix",
			);
		} finally {
			rmSync(at, { recursive: true, force: true });
		}
	});

	it("reads a config again once its size moves, though its time stands", () => {
		const at = checkoutWith("https://github.com/Jitsusama/mycelium.git");
		const config = join(at, ".git", "config");
		try {
			utimesSync(config, stood, stood);
			expect(repositoryKey(at)).toBe("github:Jitsusama/mycelium");
			rewrite(
				config,
				`${configFor("https://github.com/Jitsusama/core.nix.git")}\n`,
			);
			expect(repositoryKey(at)).toBe("github:Jitsusama/core.nix");
		} finally {
			rmSync(at, { recursive: true, force: true });
		}
	});

	// Git writes its config to config.lock and renames that over it.
	it("reads a config again once git replaces it, though its time and size stand", () => {
		const at = checkoutWith("https://github.com/Jitsusama/mycelium.git");
		const config = join(at, ".git", "config");
		try {
			utimesSync(config, stood, stood);
			expect(repositoryKey(at)).toBe("github:Jitsusama/mycelium");
			const lock = `${config}.lock`;
			rewrite(lock, configFor("https://github.com/Jitsusama/core.nix.git"));
			renameSync(lock, config);
			expect(repositoryKey(at)).toBe("github:Jitsusama/core.nix");
		} finally {
			rmSync(at, { recursive: true, force: true });
		}
	});

	it("keeps a checkout with no origin as having none while its config stands", () => {
		const at = checkoutWith(undefined);
		const config = join(at, ".git", "config");
		try {
			utimesSync(config, stood, stood);
			expect(repositoryKey(at)).toBeUndefined();
			rewrite(config, configFor("https://github.com/Jitsusama/mycelium.git"));
			expect(repositoryKey(at), "a config that stands is not read again").toBe(
				undefined,
			);
			utimesSync(config, stood, later);
			expect(repositoryKey(at)).toBe("github:Jitsusama/mycelium");
		} finally {
			rmSync(at, { recursive: true, force: true });
		}
	});

	it("names the repository again once its origin changes, as its key does", () => {
		const at = checkoutWith("https://github.com/Jitsusama/mycelium.git");
		const config = join(at, ".git", "config");
		try {
			expect(repositoryName(at)).toBe("mycelium");
			writeFileSync(config, configFor("https://github.com/Jitsusama/core.nix"));
			utimesSync(config, later, later);
			expect(repositoryName(at)).toBe("core.nix");
			expect(repositoryKey(at)).toBe("github:Jitsusama/core.nix");
		} finally {
			rmSync(at, { recursive: true, force: true });
		}
	});
});

describe("a name as part of a group", () => {
	it("keeps letters, digits and dashes, lower-cased", () => {
		expect(part("Agentic-Harness.PI")).toBe("agentic-harness-pi");
	});
});
