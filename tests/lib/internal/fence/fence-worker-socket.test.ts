/**
 * The node's worker socket in the fence: on a machine naming one, a
 * fenced or strict command reaches it, bound back past the emptied runtime
 * folder and told to Landlock, and nothing else of the node's; on S99IA2's
 * VM trial (24 November) a strict start found no node at all.
 */

import { describe, expect, it } from "vitest";
import { fenceArgs, fenceRules } from "../../../../lib/internal/fence/fence.ts";
import type { Disk } from "../../../../lib/internal/fence/fence-disk.ts";
import { fencedWorkerSocket } from "../../../../lib/internal/fence/fence-worker-socket.ts";
import { strictRules } from "../../../../lib/internal/sandbox/strict-rules.ts";

const RUNTIME = "/run/user/1000";
const WORKER = "/run/mycelium/worker.sock";

/** A disk holding `files` as files and `links` as links, and folders above them. */
function diskWith(
	files: readonly string[],
	links: readonly string[] = [],
): Disk {
	return {
		kind: (path) => {
			if (files.includes(path)) return "file";
			if (links.includes(path)) return "link";
			const inside = [...files, ...links].some((held) =>
				held.startsWith(`${path}/`),
			);
			return inside ? "folder" : undefined;
		},
		entries: () => [],
	};
}

/** An environment naming `socket` as the worker socket. */
function naming(socket: string | undefined): NodeJS.ProcessEnv {
	return {
		XDG_RUNTIME_DIR: RUNTIME,
		...(socket === undefined ? {} : { MYCELIUM_WORKER_SOCKET: socket }),
	};
}

describe("the worker socket a fenced command may reach", () => {
	it("is the socket the machine names, where it is", () => {
		expect(
			fencedWorkerSocket(naming(WORKER), diskWith([WORKER])),
			"the named worker socket wasn't let through",
		).toBe(WORKER);
	});

	it("is none where the machine names none, or one that isn't there", () => {
		expect(
			fencedWorkerSocket(naming(undefined), diskWith([WORKER])),
			"a socket was let through with none named",
		).toBeUndefined();
		expect(
			fencedWorkerSocket(naming(WORKER), diskWith([])),
			"a socket that isn't there was let through",
		).toBeUndefined();
	});

	it.each([
		["the node's full socket", `${RUNTIME}/mycelium/work.sock`],
		["the full socket by another path", "/run/mycelium/work.sock"],
		["a relative path", "mycelium/worker.sock"],
		["a path spelt with ..", "/run/mycelium/../user/1000/bus"],
		["a path spelt with a doubled slash", "/run//mycelium/worker.sock"],
		["a name the fence keeps out", `${RUNTIME}/bus`],
		["a name within one the fence keeps out", `${RUNTIME}/gnupg/S.agent`],
		["a name a kept-out pattern begins", `${RUNTIME}/wayland-1`],
		["an absolute name the fence keeps out", "/run/dbus/system_bus_socket"],
	])("is never %s", (_what, socket) => {
		expect(
			fencedWorkerSocket(naming(socket), diskWith([socket])),
			`${socket} was let through`,
		).toBeUndefined();
	});

	it("is never a link, which could be pointed anywhere once bound", () => {
		expect(
			fencedWorkerSocket(naming(WORKER), diskWith([], [WORKER])),
			"a link was let through",
		).toBeUndefined();
	});

	it("is never a folder", () => {
		expect(
			fencedWorkerSocket(
				naming("/run/mycelium"),
				diskWith(["/run/mycelium/worker.sock"]),
			),
			"a folder was let through",
		).toBeUndefined();
	});
});

describe("the fence around a command on a machine naming a worker socket", () => {
	const place = { home: "/home/someone", runtimeDir: RUNTIME };
	const disk = diskWith([WORKER, `${RUNTIME}/mycelium/work.sock`]);

	it("binds the socket back read-only after every folder it empties", () => {
		const args = fenceArgs({ ...place, workerSocket: WORKER }, disk);
		const bound = args.findIndex(
			(arg, at) =>
				arg === "--ro-bind" &&
				args[at + 1] === WORKER &&
				args[at + 2] === WORKER,
		);
		expect(
			bound,
			`the worker socket wasn't bound: ${args.join(" ")}`,
		).toBeGreaterThan(-1);
		const emptied = args.flatMap((arg, at) => (arg === "--tmpfs" ? [at] : []));
		const runtime = args.findIndex(
			(arg, at) => arg === "--tmpfs" && args[at + 1] === RUNTIME,
		);
		expect(runtime, "the runtime folder wasn't emptied").toBeGreaterThan(-1);
		expect(
			emptied.filter(
				(at) => at > bound && WORKER.startsWith(`${args[at + 1]}/`),
			),
			"a folder holding the worker socket was emptied after it was bound",
		).toEqual([]);
	});

	it("never binds the node's full socket", () => {
		const args = fenceArgs({ ...place, workerSocket: WORKER }, disk);
		expect(
			args.some((arg) => arg.endsWith("work.sock")),
			`the node's full socket was bound: ${args.join(" ")}`,
		).toBe(false);
	});

	it("tells Landlock of it, in the fence and the strict profile", () => {
		const unix = (rules: readonly string[]) =>
			rules.flatMap((rule, at) => (rule === "--unix" ? [rules[at + 1]] : []));
		expect(
			unix(fenceRules({ ...place, workerSocket: WORKER })),
			"the fence's Landlock wasn't told of the worker socket",
		).toContain(WORKER);
		expect(
			strictRules({ ...place, cwd: "/tmp/work", workerSocket: WORKER })
				.filter(([flag]) => flag === "--unix")
				.map(([, path]) => path),
			"the strict profile wasn't told of the worker socket",
		).toContain(WORKER);
	});

	it("binds and tells nothing of the node's where the machine names none", () => {
		const args = fenceArgs(place, disk);
		expect(args, "a worker socket was bound with none named").not.toContain(
			WORKER,
		);
		expect(
			fenceRules(place),
			"the fence's Landlock was told of a socket with none named",
		).not.toContain(WORKER);
		expect(
			strictRules({ ...place, cwd: "/tmp/work" }).flat(),
			"the strict profile was told of a socket with none named",
		).not.toContain(WORKER);
	});
});
