import { describe, expect, it } from "vitest";
import { kindOf } from "../../../../lib/internal/priority/queue.ts";
import {
	homeSearchRefusal,
	searchesHomeWhole,
} from "../../../../lib/internal/priority/world-walk.ts";

const home = "/home/joel";
const inSrc = { home, cwd: `${home}/src/core.nix` };
const atHome = { home, cwd: home };

/** The shell's `$HOME` in braces, built so it reads as no placeholder here. */
const BRACED_HOME = ["$", "{HOME}"].join("");

describe("a search of the whole home folder", () => {
	it.each([
		["find ~ -maxdepth 6 -path '*cadence*'", "find", home],
		["find ~/ -name '*.md' 2>/dev/null | head", "find", home],
		["find $HOME -type f -name x", "find", home],
		['find "$HOME" -name x', "find", home],
		[`find ${BRACED_HOME} -name x`, "find", home],
		["find /home/joel -name x", "find", home],
		["find ~joel -name x", "find", home],
		["find ~/* -name x", "find", home],
		["find / -name x", "find", "/"],
		["find /home -name x", "find", "/home"],
		["rg foo ~", "rg", home],
		["rg foo ~/*", "rg", home],
		["rg -n -g '*.ts' foo $HOME", "rg", home],
		["grep -r foo ~", "grep", home],
		["grep -Rn foo ~/", "grep", home],
		["grep --recursive foo /", "grep", "/"],
		["grep -d recurse foo ~", "grep", home],
		["grep --directories=recurse foo ~", "grep", home],
		["egrep -r foo ~", "egrep", home],
		["fgrep -r x ~", "fgrep", home],
		["rgrep foo ~", "rgrep", home],
		["fd cadence ~", "fd", home],
		["fdfind cadence ~", "fdfind", home],
		["fd -e ts . /", "fd", "/"],
		["fd --base-directory ~ x", "fd", home],
		["timeout 60 find ~ -name x", "find", home],
		["ionice -c3 nice -n 19 find ~ -name x", "find", home],
		["sudo find / -name x 2>/dev/null", "find", "/"],
		["sudo -u root find / -name x", "find", "/"],
		["env find ~ -name x", "find", home],
		["LC_ALL=C grep -r foo ~", "grep", home],
		["(cd ~ && find . -name x)", "find", home],
		["x=$(find ~ -name y)", "find", home],
		["for f in $(find ~ -name '*.md'); do echo $f; done", "find", home],
		["/usr/bin/find ~ -name x", "find", home],
		["\\find ~ -name x", "find", home],
		["xargs -0 rg foo ~ < list", "rg", home],
		["find ~ -maxdepth 1 -type d -exec rg foo {} +", "find", home],
		["fd -d 1 -t d . ~ -x rg foo", "fd", home],
		["ls; find ~ -name x", "find", home],
	])("is read in %s", (command, tool, root) => {
		expect(searchesHomeWhole(command, inSrc)).toEqual({ tool, root });
	});

	it("is read from the folder a search runs in when it names none", () => {
		expect(searchesHomeWhole("rg needle", atHome)).toEqual({
			tool: "rg",
			root: home,
		});
		expect(searchesHomeWhole("fd -e ts foo", atHome)).toEqual({
			tool: "fd",
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
		["a recursive grep of a narrower folder", "grep -r foo ~/notes"],
		["a grep that isn't recursive", "grep foo ~"],
		["a shallow find", "find ~ -maxdepth 2 -name '*.nix'"],
		["a shallow find running no search", "find ~ -maxdepth 1 -exec ls {} +"],
		["a shallow rg", "rg --max-depth 1 foo ~"],
		["a shallow fd", "fd -d 2 x ~"],
		["a pattern that only looks like the home", "rg '~' src"],
		["a search in quotes", 'git commit -m "fix && find ~ -name x"'],
		["a folder elsewhere", "find /nix/store -name x"],
	])("leaves alone %s", (_, command) => {
		expect(searchesHomeWhole(command, inSrc)).toBeUndefined();
	});

	it.each([
		["an rg reading a pipe", "ps aux | rg node"],
		["an rg reading a file", "rg foo < notes"],
		["a grep given its paths by xargs", "echo x | xargs grep -r foo"],
		["an rg asked its version", "rg --version"],
		["a find asked how it's called", "find --help"],
		["an fd naming its folder after its extension", "fd -e md . ~/notes"],
		["an fd based in a narrower folder", "fd --base-directory ~/src/x foo"],
	])("leaves alone, run from the home, %s", (_, command) => {
		expect(searchesHomeWhole(command, atHome)).toBeUndefined();
	});

	it("is queued as a build, as a search of a whole World checkout is", () => {
		expect(kindOf("find ~ -maxdepth 6 -path '*cadence*'", inSrc)).toBe("build");
		expect(kindOf("find ~/src/x -name y", inSrc)).toBeUndefined();
		expect(kindOf("ps aux | rg node", atHome)).toBeUndefined();
	});
});

describe("the refusal of a search of the whole home folder", () => {
	it("names the tool and the root, and says what to search instead", () => {
		const reason = homeSearchRefusal("rg -n cadence ~", inSrc) ?? "";

		expect(reason).toContain(
			"This rg searches every folder from ~, which takes in the whole home folder,",
		);
		expect(reason).toMatch(/narrower folder/);
		expect(reason).toContain("find ~ -maxdepth 2");
	});

	it("names / for a search of the whole disk", () => {
		expect(homeSearchRefusal("fd x /", inSrc)).toContain(
			"This fd searches every folder from /, which takes in every home folder on the machine,",
		);
	});

	it("leaves how a repeat goes to the guard's mode", () => {
		// In block mode a repeat is refused again; in redirect mode the
		// guardian adds its own word on going through.
		expect(homeSearchRefusal("find ~ -name x", inSrc)).not.toMatch(
			/again|repeat/i,
		);
	});

	it("says nothing for a search of a narrower folder", () => {
		expect(homeSearchRefusal("rg foo ~/src", inSrc)).toBeUndefined();
	});
});
