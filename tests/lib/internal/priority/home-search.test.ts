import { describe, expect, it } from "vitest";
import { kindOf } from "../../../../lib/internal/priority/queue.ts";
import {
	homeSearchRefusal,
	searchesHomeWhole,
} from "../../../../lib/internal/priority/world-walk.ts";

const home = "/home/joel";
const inSrc = { home, cwd: `${home}/src/core.nix` };

/** The shell's `$HOME` in braces, built so it reads as no placeholder here. */
const BRACED_HOME = ["$", "{HOME}"].join("");

describe("a search of the whole home folder", () => {
	it.each([
		["find ~ -maxdepth 6 -path '*cadence*'", "find", home],
		["find ~/ -name '*.md' 2>/dev/null | head", "find", home],
		["find $HOME -type f -name x", "find", home],
		['find "$HOME" -name x', "find", home],
		[`find ${BRACED_HOME} -name x`, "find", home],
		["find / -name x", "find", "/"],
		["find /home -name x", "find", "/home"],
		["rg foo ~", "rg", home],
		["rg -n -g '*.ts' foo $HOME", "rg", home],
		["grep -r foo ~", "grep", home],
		["grep -Rn foo ~/", "grep", home],
		["grep --recursive foo /", "grep", "/"],
		["fd cadence ~", "fd", home],
		["fd -e ts x /", "fd", "/"],
		["timeout 60 find ~ -name x", "find", home],
		["ls; find ~ -name x", "find", home],
	])("is read in %s", (command, tool, root) => {
		expect(searchesHomeWhole(command, inSrc)).toEqual({ tool, root });
	});

	it("is read from the folder a search runs in when it names none", () => {
		expect(searchesHomeWhole("rg needle", { home, cwd: home })).toEqual({
			tool: "rg",
			root: home,
		});
		expect(searchesHomeWhole("cd ~ && find . -name x", inSrc)).toEqual({
			tool: "find",
			root: home,
		});
		expect(searchesHomeWhole("cd && grep -r x", inSrc)).toEqual({
			tool: "grep",
			root: home,
		});
		expect(searchesHomeWhole("fd x", { home, cwd: "/" })).toEqual({
			tool: "fd",
			root: "/",
		});
	});

	it.each([
		["a folder under the home", "find ~/src/x -name y"],
		["a path named from a repository", "rg foo areas/core"],
		["a search where it runs", "rg foo"],
		["a grep of one file", "grep foo ~/notes.md"],
		["a grep that isn't recursive", "grep foo ~"],
		["a shallow find", "find ~ -maxdepth 2 -name '*.nix'"],
		["a shallow rg", "rg --max-depth 1 foo ~"],
		["a shallow fd", "fd -d 2 x ~"],
		["a pattern that only looks like the home", "rg '~' src"],
		["a word in quotes", "echo 'find ~ -name x'"],
		["a folder elsewhere", "find /nix/store -maxdepth 1 -name x"],
	])("leaves alone %s", (_, command) => {
		expect(searchesHomeWhole(command, inSrc)).toBeUndefined();
	});

	it("is queued as a build, as a search of a whole World checkout is", () => {
		expect(kindOf("find ~ -maxdepth 6 -path '*cadence*'", inSrc)).toBe("build");
		expect(kindOf("find ~/src/x -name y", inSrc)).toBeUndefined();
	});
});

describe("the refusal of a search of the whole home folder", () => {
	it("names the tool and the root, and says what to search instead", () => {
		const reason =
			homeSearchRefusal("find ~ -maxdepth 6 -path '*cadence*'", inSrc) ?? "";

		expect(reason).toContain("find");
		expect(reason).toContain("~");
		expect(reason).toContain("World");
		expect(reason).toMatch(/narrower folder/);
		expect(reason).toMatch(/-maxdepth 2/);
	});

	it("names / for a search of the whole disk", () => {
		expect(homeSearchRefusal("fd x /", inSrc)).toContain("from /,");
	});

	it("says nothing for a search of a narrower folder", () => {
		expect(homeSearchRefusal("rg foo ~/src", inSrc)).toBeUndefined();
	});
});
