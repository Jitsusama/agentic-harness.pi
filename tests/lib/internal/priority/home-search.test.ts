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
		[
			"rg foo ~/.local/share/pi-packages ~/.pi/pkg/pi-1.6.0/dist ~/.pi/agent",
			"rg",
			`${home}/.local/share/pi-packages`,
		],
		[
			"rg foo ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi",
			"rg",
			`${home}/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi`,
		],
		["grep -rn foo ~/.pi/agent/sessions", "grep", `${home}/.pi/agent/sessions`],
		["rg foo ~/.pi/agent", "rg", `${home}/.pi/agent`],
		["fd x ~/.pi", "fd", `${home}/.pi`],
		["find ~/.local -name x", "find", `${home}/.local`],
		[
			"rg foo ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/versions",
			"rg",
			`${home}/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/versions`,
		],
		[
			"grep -r foo ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/versions/*/lib",
			"grep",
			`${home}/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/versions/*/lib`,
		],
		["rg foo ~/.pi/agent/sessions/*/", "rg", `${home}/.pi/agent/sessions/*`],
		[
			"rg foo ~/.pi/agent/sessions/*/*.jsonl",
			"rg",
			`${home}/.pi/agent/sessions/*/*.jsonl`,
		],
		["rg foo $HOME/.pi/agent/sessions/", "rg", `${home}/.pi/agent/sessions`],
		[
			"cd ~/.local/share/pi-packages && rg foo",
			"rg",
			`${home}/.local/share/pi-packages`,
		],
		[
			"rg --max-depth 2 foo ~/.pi/agent/sessions",
			"rg",
			`${home}/.pi/agent/sessions`,
		],
		[
			"find ~/.pi/agent/sessions -maxdepth 2 -exec grep foo {} +",
			"find",
			`${home}/.pi/agent/sessions`,
		],
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
		[
			"one installed pi package",
			"rg foo ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/current/lib",
		],
		[
			"one installed version by its commit",
			"rg foo ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi/versions/d8addb81",
		],
		["pi's own code", "rg foo ~/.pi/pkg/pi-1.6.0/dist"],
		["pi's skills", "grep -r foo ~/.pi/agent/skills"],
		[
			"one folder's session logs",
			"rg foo ~/.pi/agent/sessions/--home-joel-src--",
		],
		["a shallow look at pi's state", "find ~/.pi -maxdepth 2"],
		[
			"a few session folders by a word",
			"rg foo ~/.pi/agent/sessions/--*harness*--/",
		],
		[
			"a session log by its name",
			"find ~/.pi/agent/sessions -maxdepth 2 -name '01a2*'",
		],
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

	it("names pi's installed packages for a search of them", () => {
		const reason =
			homeSearchRefusal("rg foo ~/.local/share/pi-packages", inSrc) ?? "";

		expect(reason).toContain(
			"This rg searches every folder from ~/.local/share/pi-packages, which takes in every version of every installed pi package,",
		);
		expect(reason).toContain("/current");
	});

	it("names pi's session logs for a search of them", () => {
		expect(homeSearchRefusal("grep -r foo ~/.pi", inSrc)).toContain(
			"This grep searches every folder from ~/.pi, which takes in every pi session's log,",
		);
	});

	it("names one package's versions for a search of that package", () => {
		expect(
			homeSearchRefusal(
				"rg foo ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi",
				inSrc,
			),
		).toContain("which takes in every version of this pi package,");
	});

	it("offers no depth that reads every log for a search of the sessions", () => {
		const reason =
			homeSearchRefusal("rg foo ~/.pi/agent/sessions", inSrc) ?? "";

		expect(reason).not.toContain("--max-depth 2");
		expect(reason).toContain(
			"find ~/.pi/agent/sessions -maxdepth 2 -name '<id>*'",
		);
	});

	it("says nothing for a search of a narrower folder", () => {
		expect(homeSearchRefusal("rg foo ~/src", inSrc)).toBeUndefined();
	});
});
