import { describe, expect, it } from "vitest";
import {
	openInSessionsKitty,
	type SessionsKittyStart,
	sessionsKittyRuns,
	sessionsKittyStart,
} from "../../../../lib/internal/quest/sessions-kitty.ts";

const SOCKETS = [
	"Num       RefCount Protocol Flags    Type St Inode Path",
	"0000000000000000: 00000002 00000000 00010000 0001 01 41234 @kitty-2684",
	"0000000000000000: 00000002 00000000 00010000 0001 01 41235 @kitty-ipc-1000-pi-sessions",
].join("\n");

describe("the desktop's sessions kitty", () => {
	it("runs where kitty's one instance listens for the pi-sessions group", () => {
		const probe = { PI_SESSIONS_KITTY: undefined };
		expect(
			sessionsKittyRuns(() => SOCKETS, 1000, probe),
			"its socket is listed for this user",
		).toBe(true);
		expect(
			sessionsKittyRuns(() => SOCKETS, 1001, probe),
			"another user's socket says nothing of this one's",
		).toBe(false);
		expect(
			sessionsKittyRuns(
				() => {
					throw new Error("no /proc");
				},
				1000,
				probe,
			),
			"with no /proc there is none",
		).toBe(false);
		expect(
			sessionsKittyRuns(() => SOCKETS, 1000, { PI_SESSIONS_KITTY: "off" }),
			"PI_SESSIONS_KITTY=off says there is none",
		).toBe(false);
		expect(
			sessionsKittyRuns(() => "", 1000, { PI_SESSIONS_KITTY: "on" }),
			"PI_SESSIONS_KITTY=on says there is one",
		).toBe(true);
	});

	it("opens a window there unfocused, under the agents' slice, held by the realm", () => {
		const start = sessionsKittyStart(
			{
				command: "pi",
				cwd: "/work/one",
				env: { QUEST_WORKFLOW_AUTOLOAD_ID: "QEST-1" },
			},
			{
				SHELL: "/bin/zsh",
				MYCELIUM_REALM: "work",
				XDG_ACTIVATION_TOKEN: "token",
				DESKTOP_STARTUP_ID: "startup",
				PATH: "/bin",
			},
		);
		expect(start.binary).toBe("systemd-run");
		expect(start.args.slice(0, 18)).toEqual([
			"--user",
			"--scope",
			"--collect",
			"--quiet",
			"--slice=agents.slice",
			"--",
			"env",
			`MYCELIUM_APP_ID=${start.windowClass}`,
			"kitty",
			"-1",
			"--instance-group",
			"pi-sessions",
			"--class",
			start.windowClass,
			"--directory",
			"/work/one",
			"/bin/zsh",
			"-l",
		]);
		const line = start.args.at(-1) ?? "";
		expect(line).toContain("QUEST_WORKFLOW_AUTOLOAD_ID=");
		expect(line).toContain("mycelium --realm 'work' hold -- pi");
		expect(start.env).not.toHaveProperty("XDG_ACTIVATION_TOKEN");
		expect(start.env).not.toHaveProperty("DESKTOP_STARTUP_ID");
	});

	it("gives each window a class of its own that niri opens unfocused", () => {
		const window = { command: "pi", cwd: "/work/one" };
		const first = sessionsKittyStart(window, { SHELL: "/bin/sh" });
		const second = sessionsKittyStart(window, { SHELL: "/bin/sh" });
		// core.nix's modules/niri/config.kdl opens these without the focus.
		const unfocused = /^pi-spawned(\.[0-9]+)?$/;
		expect(first.windowClass, "niri's rule matches the class").toMatch(
			unfocused,
		);
		expect(
			first.windowClass,
			"a class shared by two windows names neither",
		).not.toBe(second.windowClass);
		expect(first.windowClass, "a bare class names no window").not.toBe(
			"pi-spawned",
		);
	});

	it("keeps the window's class from a program no holder keeps it from", () => {
		const held = sessionsKittyStart(
			{ command: "pi", cwd: "/work/one" },
			{ SHELL: "/bin/sh", MYCELIUM_REALM: "work" },
		);
		const unheld = sessionsKittyStart(
			{ command: "pi", cwd: "/work/one" },
			{ SHELL: "/bin/sh" },
		);
		expect(
			unheld.args.at(-1),
			"a session it spawns would say the class as its own window's",
		).toMatch(/^unset MYCELIUM_APP_ID\n/);
		expect(
			held.args.at(-1),
			"the holder reads the class and keeps it from its program",
		).not.toContain("unset MYCELIUM_APP_ID");
	});

	it("runs the command as it is outside a realm, and says where it opened", async () => {
		const starts: SessionsKittyStart[] = [];
		const where = await openInSessionsKitty(
			{ command: "pi --session abc", cwd: "/work/two" },
			{ SHELL: "/bin/sh" },
			async (start) => {
				starts.push(start);
			},
		);
		expect(where).toBe(
			"a window in the desktop's sessions kitty, in /work/two",
		);
		expect(starts[0]?.args.at(-1)).not.toContain("mycelium");
		expect(starts[0]?.args.at(-1)).toContain("pi --session abc");
	});
});
