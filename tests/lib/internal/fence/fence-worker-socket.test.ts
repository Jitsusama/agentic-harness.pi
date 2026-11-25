/**
 * The node's worker socket in the fence: on a machine whose node serves
 * one, a fenced or strict command reaches it and is told where it is,
 * and nothing else of the node's; on S99IA2's VM trial (24 November) a
 * strict start found no node at all.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fenceArgs, fenceRules } from "../../../../lib/internal/fence/fence.ts";
import type { Disk } from "../../../../lib/internal/fence/fence-disk.ts";
import { fenceRunText } from "../../../../lib/internal/fence/fence-run.ts";
import {
	type FolderStat,
	fencedWorkerSocket,
	ownerKeepsFolder,
	SOCKET_DISK,
	type SocketDisk,
	WORKER_SOCKET_FOLDER,
} from "../../../../lib/internal/fence/fence-worker-socket.ts";
import {
	type Sandbox,
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
	const held = [...sockets, ...files, WORKER_SOCKET_FOLDER];
	return {
		real: (path) => links[path] ?? (held.includes(path) ? path : undefined),
		present: (path) => held.includes(path) || path in links,
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

	it("is none where the machine names none", () => {
		expect(
			fencedWorkerSocket(naming(undefined), diskWith({ sockets: [WORKER] })),
			"a socket was let through with none named",
		).toBeUndefined();
	});

	it("is still the worker socket while the node is between restarts, so a command started then reaches it once it is back", () => {
		expect(
			fencedWorkerSocket(naming(WORKER), diskWith({})),
			"a worker socket not yet bound again was refused",
		).toBe(WORKER);
	});

	it("is never one in a folder that is itself a link elsewhere", () => {
		expect(
			fencedWorkerSocket(
				naming(WORKER),
				diskWith({
					sockets: [WORKER],
					links: { [WORKER_SOCKET_FOLDER]: "/home/someone/folder" },
				}),
			),
			"a socket in a linked folder was let through",
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
		kind: (path) =>
			path === WORKER
				? "file"
				: path === WORKER_SOCKET_FOLDER
					? "folder"
					: undefined,
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

	it("binds its folder read-only, so a command can't take the node's place, and empties no folder holding it", () => {
		const args = fenceArgs({ ...place, workerSocket: WORKER }, folders);
		expect(
			args.filter((arg) => arg.startsWith(WORKER_SOCKET_FOLDER)),
			`the fence laid something else over the worker folder: ${args.join(" ")}`,
		).toEqual([WORKER_SOCKET_FOLDER, WORKER_SOCKET_FOLDER]);
		const at = args.indexOf(WORKER_SOCKET_FOLDER);
		expect(args[at - 1], "the worker folder was bound writable").toBe(
			"--ro-bind",
		);
		expect(
			fenceArgs(place, folders).filter((arg) =>
				arg.startsWith(WORKER_SOCKET_FOLDER),
			),
			"the worker folder was bound with no socket let through",
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
	const text = (socket: string, sandbox: Sandbox = strict()) => {
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

	it("is handed it in the bubblewrap fence too, the session's own value never, and nothing in a language server's", () => {
		const fence = (served = false): Sandbox => ({
			kind: "fence",
			bwrap: "/bin/bwrap",
			landrun: "/bin/landrun",
			workerSockets: diskWith({ sockets: [WORKER] }),
			...(served ? { served } : {}),
		});
		/** The variables the fence's own filter keeps of a session exporting the socket's. */
		const kept = (made: string) => {
			const filter = made
				.split("\n")
				.find((line) => line.startsWith("__pi_env=()"));
			expect(filter, `the fence has no filter: ${made}`).toBeDefined();
			const ran = spawnSync(
				"bash",
				["-c", `${filter}; printf '%s\\n' "\${__pi_env[@]}"`],
				{
					env: {
						PATH: process.env.PATH,
						MYCELIUM_WORKER_SOCKET: "/tmp/listening.sock",
						KEPT_BESIDE: "1",
					},
					encoding: "utf8",
				},
			);
			return ran.stdout;
		};
		const made = text(WORKER, fence());
		expect(made, "the fenced command wasn't handed the socket").toContain(
			`MYCELIUM_WORKER_SOCKET='${WORKER}'`,
		);
		const refused = text(`${RUNTIME}/bus`, fence());
		expect(
			refused,
			"a refused socket was named to the fenced command",
		).not.toContain("MYCELIUM_WORKER_SOCKET='");
		for (const shell of [made, refused]) {
			const passed = kept(shell);
			expect(passed, "the filter kept nothing at all").toContain("KEPT_BESIDE");
			expect(
				passed,
				"the session's own value of the variable went into the fence",
			).not.toContain("MYCELIUM_WORKER_SOCKET");
		}
		const served = text(WORKER, fence(true));
		expect(
			served,
			"a language server's fence was handed the socket",
		).not.toContain(`MYCELIUM_WORKER_SOCKET='`);
	});
});

describe("whose folder the worker socket may sit in", () => {
	const SESSION = 1000;
	const NODE = 990;
	const folders =
		(listed: Record<string, FolderStat>) =>
		(path: string): FolderStat | undefined =>
			listed[path];
	const run: FolderStat = { uid: 0, mode: 0o40755, isFolder: true };

	it("takes the node's own account's folder where only root could have made it", () => {
		const stat = folders({
			"/run": run,
			"/run/mycelium": { uid: NODE, mode: 0o40755, isFolder: true },
		});

		expect(
			ownerKeepsFolder("/run/mycelium", stat, SESSION),
			"the node's own folder is kept",
		).toBe(true);
	});

	it("takes whichever account root gave the folder to, not the node's alone", () => {
		const stat = folders({
			"/run": run,
			"/run/mycelium": { uid: 65_534, mode: 0o40700, isFolder: true },
		});

		expect(
			ownerKeepsFolder("/run/mycelium", stat, SESSION),
			"the folder root gave this account is kept",
		).toBe(true);
	});

	it("refuses another account's folder in a folder that isn't root's", () => {
		const stat = folders({
			"/run": { uid: NODE, mode: 0o40755, isFolder: true },
			"/run/mycelium": { uid: NODE, mode: 0o40755, isFolder: true },
		});

		expect(
			ownerKeepsFolder("/run/mycelium", stat, SESSION),
			"another account's folder is refused",
		).toBe(false);
	});

	it("refuses another account's folder in root's folder its group may write", () => {
		const stat = folders({
			"/run": { uid: 0, mode: 0o40775, isFolder: true },
			"/run/mycelium": { uid: NODE, mode: 0o40755, isFolder: true },
		});

		expect(
			ownerKeepsFolder("/run/mycelium", stat, SESSION),
			"another account's folder is refused",
		).toBe(false);
	});

	it("refuses another account's folder whose parent can't be read as a folder", () => {
		const mycelium = { uid: NODE, mode: 0o40755, isFolder: true };
		const unread = folders({ "/run/mycelium": mycelium });
		const linked = folders({
			"/run": { uid: 0, mode: 0o120777, isFolder: false },
			"/run/mycelium": mycelium,
		});

		expect(
			ownerKeepsFolder("/run/mycelium", unread, SESSION),
			"a folder whose owner can't be read is refused",
		).toBe(false);
		expect(
			ownerKeepsFolder("/run/mycelium", linked, SESSION),
			"a linked folder is refused",
		).toBe(false);
	});

	it("lets a strict command through to a worker socket in the node's own folder", () => {
		const judged = (parent: FolderStat): SocketDisk => ({
			...diskWith({ sockets: [WORKER] }),
			keptByItsOwner: (folder) =>
				ownerKeepsFolder(
					folder,
					folders({
						"/run": parent,
						[WORKER_SOCKET_FOLDER]: {
							uid: NODE,
							mode: 0o40755,
							isFolder: true,
						},
					}),
					SESSION,
				),
		});

		expect(fencedWorkerSocket(naming(WORKER), judged(run))).toBe(WORKER);
		expect(
			fencedWorkerSocket(
				naming(WORKER),
				judged({ uid: NODE, mode: 0o40755, isFolder: true }),
			),
		).toBeUndefined();
	});

	it("refuses another account's folder where anyone could have made it", () => {
		const stat = folders({
			"/tmp": { uid: 0, mode: 0o41777, isFolder: true },
			"/tmp/mycelium": { uid: NODE, mode: 0o40755, isFolder: true },
		});

		expect(
			ownerKeepsFolder("/tmp/mycelium", stat, SESSION),
			"another account's folder under /tmp is refused",
		).toBe(false);
	});

	it("refuses a folder others may write, whoever made it", () => {
		const stat = folders({
			"/run": run,
			"/run/mycelium": { uid: 0, mode: 0o40775, isFolder: true },
		});

		expect(
			ownerKeepsFolder("/run/mycelium", stat, SESSION),
			"a folder others may write is refused",
		).toBe(false);
	});

	it("takes root's or the session's own folder wherever it is", () => {
		const stat = folders({
			"/home/s/mine": { uid: SESSION, mode: 0o40700, isFolder: true },
			"/opt/roots": { uid: 0, mode: 0o40755, isFolder: true },
		});

		expect(
			ownerKeepsFolder("/home/s/mine", stat, SESSION),
			"root's folder in the home is kept",
		).toBe(true);
		expect(
			ownerKeepsFolder("/opt/roots", stat, SESSION),
			"root's folder in /opt is kept",
		).toBe(true);
	});
});

describe("the disk a worker socket is judged on, as it is", () => {
	let base: string;
	let server: Server;
	const socket = () => join(base, "open", "w.sock");
	beforeAll(async () => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "wd-")));
		mkdirSync(join(base, "kept"), { mode: 0o755 });
		mkdirSync(join(base, "open"), { mode: 0o755 });
		chmodSync(join(base, "open"), 0o777);
		writeFileSync(join(base, "kept", "file"), "");
		server = createServer();
		await new Promise<void>((done) => server.listen(socket(), done));
		symlinkSync(socket(), join(base, "kept", "link.sock"));
		symlinkSync(join(base, "kept"), join(base, "kept-link"));
	});
	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()));
		rmSync(base, { recursive: true, force: true });
	});

	it("keeps a folder only its own account may write, never one others may", () => {
		expect(
			SOCKET_DISK.keptByItsOwner(join(base, "kept")),
			"the account's own 0755 folder wasn't kept",
		).toBe(true);
		expect(
			SOCKET_DISK.keptByItsOwner(join(base, "open")),
			"a folder anyone may write was kept",
		).toBe(false);
		expect(
			SOCKET_DISK.keptByItsOwner(join(base, "kept-link")),
			"a link to a kept folder was read as the folder",
		).toBe(false);
	});

	it("reads a socket as one, never a link to one or a file", () => {
		expect(SOCKET_DISK.isSocket(socket()), "a socket wasn't read").toBe(true);
		expect(
			SOCKET_DISK.isSocket(join(base, "kept", "link.sock")),
			"a link to a socket was read as one",
		).toBe(false);
		expect(
			SOCKET_DISK.isSocket(join(base, "kept", "file")),
			"a file was read as a socket",
		).toBe(false);
	});

	it("follows a link to where it ends, and finds nothing where nothing is", () => {
		expect(
			SOCKET_DISK.real(join(base, "kept", "link.sock")),
			"a link wasn't followed",
		).toBe(socket());
		expect(
			SOCKET_DISK.present(join(base, "kept", "link.sock")),
			"a link wasn't read as there",
		).toBe(true);
		expect(
			SOCKET_DISK.present(join(base, "kept", "gone")),
			"nothing was read as something",
		).toBe(false);
		expect(SOCKET_DISK.real(join(base, "kept", "gone"))).toBeUndefined();
	});
});
