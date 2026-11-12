import { describe, expect, it } from "vitest";
import { fenceArgs } from "../../../../lib/internal/fence.ts";
import {
	openInSessionsKitty,
	SESSIONS_SOCKET,
	type SessionsKittyDoor,
	type SessionsKittyStart,
	sessionsKittyDoor,
	sessionsKittyRuns,
	sessionsKittyStart,
} from "../../../../lib/internal/quest/sessions-kitty.ts";

const SOCKET = "/run/user/1000/pi-sessions/kitty.sock";
const BY_SOCKET: SessionsKittyDoor = { kind: "socket", path: SOCKET };
const BY_INSTANCE: SessionsKittyDoor = { kind: "instance" };
const UNIT =
	"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice/sessions-kitty.service";

/** A machine where the socket is or isn't there, and the unit runs or not. */
function machine(socket: boolean, running: boolean) {
	return {
		env: { XDG_RUNTIME_DIR: "/run/user/1000" },
		uid: 1000,
		isSocket: (path: string) => socket && path === SOCKET,
		processesIn: (cgroup: string) =>
			running && cgroup === UNIT ? "3272\n" : "",
	};
}

describe("the desktop's sessions kitty", () => {
	it("is reached by its socket in the runtime folder whenever the socket is there", () => {
		expect(sessionsKittyDoor(machine(true, true))).toEqual(BY_SOCKET);
		expect(
			sessionsKittyDoor(machine(true, false)),
			"the socket alone says where it listens",
		).toEqual(BY_SOCKET);
		expect(SESSIONS_SOCKET).toBe("pi-sessions/kitty.sock");
	});

	it("is reached through its single instance only while its unit runs without a socket", () => {
		expect(
			sessionsKittyDoor(machine(false, true)),
			"a kitty started before the socket holds the instance's name",
		).toEqual(BY_INSTANCE);
		expect(
			sessionsKittyDoor(machine(false, false)),
			"with its unit stopped, whoever holds the name could be anyone",
		).toBeUndefined();
		expect(sessionsKittyRuns(machine(false, false)), "no window opens").toBe(
			false,
		);
	});

	it("is said outright by PI_SESSIONS_KITTY", () => {
		expect(
			sessionsKittyRuns({
				...machine(true, true),
				env: { PI_SESSIONS_KITTY: "off" },
			}),
			"PI_SESSIONS_KITTY=off says there is none",
		).toBe(false);
		expect(
			sessionsKittyDoor({
				...machine(false, false),
				env: { XDG_RUNTIME_DIR: "/run/user/1000", PI_SESSIONS_KITTY: "on" },
			}),
		).toEqual(BY_SOCKET);
	});

	it("keeps its socket from every fenced command", () => {
		const args = fenceArgs(
			{ home: "/home/someone", runtimeDir: "/run/user/1000" },
			{ kind: () => "folder", entries: () => [] },
		);
		expect(
			args.join(" "),
			"the runtime folder goes in empty, with no way to the sessions kitty",
		).not.toContain("pi-sessions");
		expect(args.join(" ")).toContain("--tmpfs /run/user/1000");
	});

	it("opens a window by its socket, told only its class, never the asker's variables", () => {
		const start = sessionsKittyStart(
			{
				command: "pi",
				cwd: "/work/one",
				env: { QUEST_WORKFLOW_AUTOLOAD_ID: "QEST-1" },
			},
			{
				SHELL: "/bin/zsh",
				MYCELIUM_REALM: "work",
				PI_QUEST: "QEST-2",
				GITHUB_TOKEN: "ghp_secret",
				XDG_ACTIVATION_TOKEN: "token",
				PATH: "/bin",
			},
			BY_SOCKET,
		);
		expect(start.binary).toBe("kitten");
		expect(start.args.slice(0, 15)).toEqual([
			"@",
			"--to",
			`unix:${SOCKET}`,
			"launch",
			"--type=os-window",
			"--os-window-class",
			start.windowClass,
			"--cwd",
			"/work/one",
			"--env",
			`MYCELIUM_APP_ID=${start.windowClass}`,
			"/bin/zsh",
			"-l",
			"-i",
			"-c",
		]);
		const told = start.args.filter((_, at) => start.args[at - 1] === "--env");
		expect(told, "the window is told its class and nothing else").toEqual([
			`MYCELIUM_APP_ID=${start.windowClass}`,
		]);
		const said = start.args.join(" ");
		expect(said, "the asker's quest stays its own").not.toContain("QEST-2");
		expect(said, "the asker's token stays its own").not.toContain("ghp_secret");
		const line = start.args.at(-1) ?? "";
		expect(line).toContain("QUEST_WORKFLOW_AUTOLOAD_ID=");
		expect(line).toContain("mycelium --realm 'work' hold -- pi");
	});

	it("opens a window through the single instance unfocused, under the agents' slice, held by the realm", () => {
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
			BY_INSTANCE,
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
		const first = sessionsKittyStart(window, { SHELL: "/bin/sh" }, BY_SOCKET);
		const second = sessionsKittyStart(window, { SHELL: "/bin/sh" }, BY_SOCKET);
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
			BY_SOCKET,
		);
		const unheld = sessionsKittyStart(
			{ command: "pi", cwd: "/work/one" },
			{ SHELL: "/bin/sh" },
			BY_SOCKET,
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
			() => BY_SOCKET,
		);
		expect(where).toBe(
			"a window in the desktop's sessions kitty, in /work/two",
		);
		expect(starts[0]?.args.at(-1)).not.toContain("mycelium");
		expect(starts[0]?.args.at(-1)).toContain("pi --session abc");
	});

	it("opens nothing when there is no sessions kitty", async () => {
		const starts: SessionsKittyStart[] = [];
		await expect(
			openInSessionsKitty(
				{ command: "pi", cwd: "/work/two" },
				{ SHELL: "/bin/sh" },
				async (start) => {
					starts.push(start);
				},
				() => undefined,
			),
		).rejects.toThrow("there is no sessions kitty to open a window in");
		expect(starts, "no kitty -1 was started").toEqual([]);
	});
});
