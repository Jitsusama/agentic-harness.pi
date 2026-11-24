/**
 * The node's worker socket in the fence: on a machine whose node serves
 * one, a fenced or strict command reaches it and is told where it is,
 * and nothing else of the node's; on S99IA2's VM trial (24 November) a
 * strict start found no node at all.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fenceArgs, fenceRules } from "../../../../lib/internal/fence/fence.ts";
import type { Disk } from "../../../../lib/internal/fence/fence-disk.ts";
import { fenceRunText } from "../../../../lib/internal/fence/fence-run.ts";
import {
	fencedWorkerSocket,
	type SocketDisk,
	WORKER_SOCKET_FOLDER,
} from "../../../../lib/internal/fence/fence-worker-socket.ts";
import {
	type Sandbox,
	sandboxedCommand,
	wrapFor,
} from "../../../../lib/internal/sandbox/sandbox.ts";
import { strictRules } from "../../../../lib/internal/sandbox/strict-rules.ts";

const RUNTIME = "/run/user/1000";
const WORKER = `${WORKER_SOCKET_FOLDER}/work-worker.sock`;

/**
 * A disk holding `sockets` and `files` where they are named, with links
 * followed by `links` (a path's real place), and the worker folder kept
 * by its owner unless `open`.
 */
function diskWith({
	sockets = [],
	files = [],
	links = {},
	open = false,
}: {
	sockets?: readonly string[];
	files?: readonly string[];
	links?: Readonly<Record<string, string>>;
	open?: boolean;
}): SocketDisk {
	const held = [...sockets, ...files];
	return {
		real: (path) => links[path] ?? (held.includes(path) ? path : undefined),
		isSocket: (path) => sockets.includes(path),
		keptByItsOwner: (folder) => folder === WORKER_SOCKET_FOLDER && !open,
	};
}

/** An environment naming `socket` as the worker socket. */
function naming(
	socket: string | undefined,
	runtime: string | undefined = RUNTIME,
): NodeJS.ProcessEnv {
	return {
		...(runtime === undefined ? {} : { XDG_RUNTIME_DIR: runtime }),
		...(socket === undefined ? {} : { MYCELIUM_WORKER_SOCKET: socket }),
	};
}

describe("the worker socket a fenced command may reach", () => {
	it("is the node's worker socket, where the node serves it", () => {
		expect(
			fencedWorkerSocket(naming(WORKER), diskWith({ sockets: [WORKER] })),
			"the node's worker socket wasn't let through",
		).toBe(WORKER);
	});

	it("is the same with no runtime folder named, which it doesn't depend on", () => {
		expect(
			fencedWorkerSocket(
				naming(WORKER, undefined),
				diskWith({ sockets: [WORKER] }),
			),
			"the worker socket wasn't let through without a runtime folder",
		).toBe(WORKER);
	});

	it("is none where the machine names none, or one that isn't there", () => {
		expect(
			fencedWorkerSocket(naming(undefined), diskWith({ sockets: [WORKER] })),
			"a socket was let through with none named",
		).toBeUndefined();
		expect(
			fencedWorkerSocket(naming(WORKER), diskWith({})),
			"a socket that isn't there was let through",
		).toBeUndefined();
	});

	it.each([
		["the node's full socket", `${RUNTIME}/mycelium/work.sock`],
		["another realm's full socket", `${RUNTIME}/mycelium/home.sock`],
		["the full socket in the worker folder", "/run/mycelium/work.sock"],
		["a name not a worker's", "/run/mycelium/other"],
		["a socket in the runtime folder", `${RUNTIME}/systemd/private`],
		["a container engine's socket", `${RUNTIME}/podman/podman.sock`],
		["X's socket", "/tmp/.X11-unix/X0"],
		["the session bus", `${RUNTIME}/bus`],
		["the system bus", "/run/dbus/system_bus_socket"],
		["a worker's name elsewhere", "/tmp/work-worker.sock"],
		["a relative path", "mycelium/work-worker.sock"],
		["a path spelt with ..", "/run/mycelium/../user/1000/work-worker.sock"],
		["a path spelt with a doubled slash", "/run//mycelium/work-worker.sock"],
	])("is never %s", (_what, socket) => {
		expect(
			fencedWorkerSocket(naming(socket), diskWith({ sockets: [socket] })),
			`${socket} was let through`,
		).toBeUndefined();
	});

	it("is never a path a link in any part of it leads elsewhere", () => {
		expect(
			fencedWorkerSocket(
				naming(WORKER),
				diskWith({
					sockets: [`${RUNTIME}/bus`],
					links: { [WORKER]: `${RUNTIME}/bus` },
				}),
			),
			"a link to the session bus was let through",
		).toBeUndefined();
	});

	it("is never a file that isn't a socket", () => {
		expect(
			fencedWorkerSocket(naming(WORKER), diskWith({ files: [WORKER] })),
			"a plain file was let through",
		).toBeUndefined();
	});

	it("is never one in a folder others may write", () => {
		expect(
			fencedWorkerSocket(
				naming(WORKER),
				diskWith({ sockets: [WORKER], open: true }),
			),
			"a socket in a folder anyone may write was let through",
		).toBeUndefined();
	});
});

describe("the fence around a command on a machine whose node serves a worker socket", () => {
	const place = { home: "/home/someone", runtimeDir: RUNTIME };
	const folders: Disk = {
		kind: (path) => (path === WORKER ? "file" : undefined),
		entries: () => [],
	};

	/** What Landlock is told to let a connect reach. */
	const unix = (rules: readonly string[]) =>
		rules.flatMap((rule, at) => (rule === "--unix" ? [rules[at + 1]] : []));

	it("tells Landlock of the socket's folder, so a node that restarts is still reached", () => {
		expect(
			unix(fenceRules({ ...place, workerSocket: WORKER })),
			"the fence's Landlock wasn't told of the worker folder",
		).toContain(WORKER_SOCKET_FOLDER);
		expect(
			strictRules({ ...place, cwd: "/tmp/work", workerSocket: WORKER })
				.filter(([flag]) => flag === "--unix")
				.map(([, path]) => path),
			"the strict profile wasn't told of the worker folder",
		).toContain(WORKER_SOCKET_FOLDER);
	});

	it("binds nothing for it and empties no folder holding it, so a node that is down stops no command", () => {
		const args = fenceArgs({ ...place, workerSocket: WORKER }, folders);
		expect(
			args.filter((arg) => arg.startsWith(WORKER_SOCKET_FOLDER)),
			`the fence laid something over the worker folder: ${args.join(" ")}`,
		).toEqual([]);
		const emptied = args.flatMap((arg, at) =>
			arg === "--tmpfs" ? [args[at + 1] ?? ""] : [],
		);
		expect(
			emptied.filter((folder) => WORKER.startsWith(`${folder}/`)),
			"a folder holding the worker socket was emptied",
		).toEqual([]);
	});

	it("tells nothing of the node's where the machine serves none", () => {
		expect(
			unix(fenceRules(place)),
			"the fence's Landlock was told of a socket with none served",
		).not.toContain(WORKER_SOCKET_FOLDER);
		expect(
			strictRules({ ...place, cwd: "/tmp/work" }).flat(),
			"the strict profile was told of a socket with none served",
		).not.toContain(WORKER_SOCKET_FOLDER);
	});
});

describe("a strict command on a machine whose node serves a worker socket", () => {
	// The strict case makes its folders under home before a command, so
	// home and the folder it runs in are the test's own.
	let base: string;
	beforeAll(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
		mkdirSync(join(base, "home"));
		mkdirSync(join(base, "work"));
	});
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	const strict = (served = false): Extract<Sandbox, { kind: "strict" }> => ({
		kind: "strict",
		landrun: "/bin/landrun",
		workerSockets: diskWith({ sockets: [WORKER] }),
		...(served ? { served } : {}),
	});

	/** The text a strict command runs as, its environment naming `socket`. */
	const text = (socket: string, sandbox = strict()) => {
		const wrap = wrapFor(
			sandbox,
			{ cwd: join(base, "work"), env: { ...naming(socket), PATH: "/bin" } },
			join(base, "home"),
		);
		return wrap ? wrap("true") : "";
	};

	it("is handed where the socket is, and Landlock lets it reach the folder", () => {
		const made = text(WORKER);
		expect(made, "the strict command wasn't handed the socket").toContain(
			`MYCELIUM_WORKER_SOCKET='${WORKER}'`,
		);
		expect(made, "landrun wasn't told to hand it on").toContain(
			"--env MYCELIUM_WORKER_SOCKET",
		);
		expect(made, "Landlock wasn't told of the folder").toContain(
			`--unix '${WORKER_SOCKET_FOLDER}'`,
		);
	});

	it("is handed nothing of a socket the fence won't let through", () => {
		const made = text(`${RUNTIME}/mycelium/work.sock`);
		expect(made, "a refused socket was named to the command").not.toContain(
			"MYCELIUM_WORKER_SOCKET",
		);
		expect(made, "Landlock was told of a refused socket").not.toContain(
			"work.sock",
		);
	});

	it("is handed nothing of it in a language server's sandbox, which runs no one's ask", () => {
		const made = text(WORKER, strict(true));
		expect(made, "a language server was handed the socket").not.toContain(
			"MYCELIUM_WORKER_SOCKET",
		);
		expect(made, "a language server's Landlock was told of it").not.toContain(
			`--unix '${WORKER_SOCKET_FOLDER}'`,
		);
	});

	it("never keeps the variable from the session's own environment", () => {
		// What the session exports goes through the shell's own filter, which
		// no socket's variable passes: only one handed in reaches the command.
		const made = sandboxedCommand("true", [], "/bin/landrun");
		expect(made, "the session's variable could be kept").not.toContain(
			"MYCELIUM_WORKER_SOCKET",
		);
	});

	it("is handed it by pi-fence's strict run too, and nothing of a refused one", () => {
		const run = (socket: string) => {
			const made = fenceRunText(
				{ kind: "strict", folder: join(base, "work"), words: ["true"] },
				{
					env: naming(socket, undefined),
					home: join(base, "home"),
					platform: "linux",
					sandbox: {
						kind: "fence",
						bwrap: "/bin/bwrap",
						landrun: "/bin/landrun",
						workerSockets: diskWith({ sockets: [WORKER] }),
					},
				},
			);
			return "text" in made ? made.text : JSON.stringify(made);
		};
		const made = run(WORKER);
		expect(made, "pi-fence's strict run wasn't handed the socket").toContain(
			"--env MYCELIUM_WORKER_SOCKET",
		);
		expect(made, "its Landlock wasn't told of the folder").toContain(
			`--unix '\\''${WORKER_SOCKET_FOLDER}'\\''`,
		);
		expect(
			run(`${RUNTIME}/bus`),
			"pi-fence's strict run was handed a refused socket",
		).not.toContain("MYCELIUM_WORKER_SOCKET");
	});
});
