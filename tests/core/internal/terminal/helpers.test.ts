import { describe, expect, it } from "vitest";
import {
	ancestryFromListing,
	normaliseProgramName,
} from "../../../../lib/core/internal/terminal/ancestry.ts";
import { resolveBinary } from "../../../../lib/core/internal/terminal/binary.ts";
import {
	launchEnvironment,
	loginShellArgv,
	typedLine,
} from "../../../../lib/core/internal/terminal/drivers/shared.ts";
import {
	BUILTIN_LAUNCHERS,
	fillTemplate,
	launcherOn,
} from "../../../../lib/core/internal/terminal/launchers.ts";

describe("program names", () => {
	it.each([
		["/nix/store/abc-kitty-0.49.2/bin/.kitty-wrapped", "kitty"],
		["/Applications/kitty.app/Contents/MacOS/kitty", "kitty"],
		["/Applications/WezTerm.app/Contents/MacOS/wezterm-gui", "wezterm"],
		["-zsh", "zsh"],
		["tmux", "tmux"],
	])("normalises %s to %s", (raw, name) => {
		expect(normaliseProgramName(raw)).toBe(name);
	});

	it("walks a ps listing up from a process, nearest first", () => {
		const listing = [
			"  1     0 /sbin/launchd",
			" 50     1 /Applications/kitty.app/Contents/MacOS/kitty",
			" 60    50 -zsh",
			" 70    60 /usr/local/bin/tmux",
			" 80    70 node",
		].join("\n");
		expect(ancestryFromListing(listing, 80)).toEqual(["tmux", "zsh", "kitty"]);
	});
});

describe("finding a binary", () => {
	const exists = (path: string) => path === "/b/kitty" || path === "/opt/k";

	it("walks PATH in order", () => {
		expect(resolveBinary("kitty", "/a:/b:/c", exists)).toBe("/b/kitty");
		expect(resolveBinary("foot", "/a:/b", exists)).toBeUndefined();
	});

	it("takes an absolute path as given when it is executable", () => {
		expect(resolveBinary("/opt/k", "", exists)).toBe("/opt/k");
		expect(resolveBinary("/opt/nope", "/b", exists)).toBeUndefined();
	});
});

describe("running a command under the person's shell", () => {
	it("types a line with its variables in front", () => {
		expect(typedLine("pi --session 'x'", { A: "it's" })).toBe(
			"A='it'\\''s' pi --session 'x'\n",
		);
	});

	it("runs it through a login, interactive shell that stays open afterwards", () => {
		expect(loginShellArgv("/bin/zsh", "pi", { env: { A: "1" } })).toEqual([
			"/bin/zsh",
			"-l",
			"-i",
			"-c",
			"A='1' pi; exec '/bin/zsh' -l",
		]);
	});

	it("puts the person's wrap in front, with the directory filled in", () => {
		expect(
			loginShellArgv("/bin/zsh", "pi", {
				wrap: ["direnv", "exec", "{cwd}"],
				cwd: "/w",
			})[4],
		).toBe("'direnv' 'exec' '/w' pi; exec '/bin/zsh' -l");
	});

	it("leaves this session's variables out of a launched terminal", () => {
		expect(
			launchEnvironment({
				PATH: "/bin",
				PI_CACHE_RETENTION: "long",
				PI_SESSION_ID: "abc",
				KITTY_WINDOW_ID: "1",
				TMUX: "/s,1,0",
				QUEST_WORKFLOW_AUTOLOAD_ID: "Q",
			}),
		).toEqual({ PATH: "/bin", PI_CACHE_RETENTION: "long" });
	});
});

describe("launch templates", () => {
	it("fills the directory and spreads the command", () => {
		expect(
			fillTemplate(["--working-directory={cwd}", "-e", "{argv}"], {
				cwd: "/w",
				argv: ["zsh", "-l"],
			}),
		).toEqual(["--working-directory=/w", "-e", "zsh", "-l"]);
	});

	it("drops an argument whose token has no value", () => {
		expect(
			fillTemplate(["--title={title}", "{argv}"], { argv: ["sh"] }),
		).toEqual(["sh"]);
	});

	it("refuses a template with nowhere to put the command", () => {
		expect(fillTemplate(["--hold"], { argv: ["sh"] })).toBeUndefined();
	});

	it("gives each built-in a form on the platforms it runs on", () => {
		const on = (platform: "linux" | "darwin") =>
			BUILTIN_LAUNCHERS.map(
				(spec) => launcherOn(spec, platform)?.binary ?? null,
			);
		expect(on("linux")).toEqual([
			"kitty",
			"wezterm",
			"ghostty",
			"alacritty",
			"foot",
		]);
		expect(on("darwin")).toEqual([
			"kitty",
			"wezterm",
			"open",
			"alacritty",
			null,
		]);
	});
});
