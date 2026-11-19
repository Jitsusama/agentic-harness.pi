/**
 * Which trees the sweep's reading of the machine finds in use, on a
 * made-up machine whose reads fail as a real one's can. Taking an open
 * session's snapshot rests on this reading, so where it can't be sure
 * it must say so rather than call a tree free.
 */
import { describe, expect, it } from "vitest";
import {
	busyAmongBy,
	type ProcessReads,
} from "../../../extensions/work-integration/sweep.ts";

/** The link the machine's own process namespace has. */
const HOST = "pid:[4026531836]";

/** An error as the kernel's reads throw it. */
function failing(code: string): Error {
	return Object.assign(new Error(code), { code });
}

/**
 * A machine of `links`, each a path to what it points at or the error
 * reading it throws, its processes those `/proc` holds, and `folders`
 * the live sessions'.
 */
function machine(
	links: Record<string, string | Error>,
	folders: readonly string[] = [],
): ProcessReads {
	const listing = (path: string): string[] => {
		const prefix = `${path}/`;
		const names = Object.keys(links)
			.filter((link) => link.startsWith(prefix))
			.map((link) => link.slice(prefix.length).split("/")[0] ?? "");
		return [...new Set(names)];
	};
	return {
		readlink: async (path) => {
			const to =
				path === "/proc/self/ns/pid" ? (links[path] ?? HOST) : links[path];
			if (to instanceof Error) throw to;
			if (to === undefined) throw failing("ENOENT");
			return to;
		},
		readdir: async (path) => listing(path),
		sessionFolders: async () => folders,
	};
}

describe("the sweep's reading of what is in use", () => {
	it("finds a tree a process works in or holds a file open in", async () => {
		const busy = await busyAmongBy(
			["/trees/a", "/trees/b", "/trees/c"],
			machine({
				"/proc/10/cwd": "/trees/a/src",
				"/proc/11/cwd": "/home",
				"/proc/11/fd/3": "/trees/b/Cargo.lock",
			}),
		);

		expect([...(busy ?? [])].sort(), "not the trees processes are in").toEqual([
			"/trees/a",
			"/trees/b",
		]);
	});

	it("finds a tree a live session's folder lies in", async () => {
		// A hosted conversation's folder is no process's folder, and
		// reading there moves neither git nor the folder.
		const busy = await busyAmongBy(
			["/trees/a", "/trees/b"],
			machine({ "/proc/10/cwd": "/home" }, ["/trees/b/docs"]),
		);

		expect(
			[...(busy ?? [])],
			"a session's folder didn't keep its tree",
		).toEqual(["/trees/b"]);
	});

	it("reads on past a process it may not read", async () => {
		const busy = await busyAmongBy(
			["/trees/a"],
			machine({
				"/proc/10/cwd": failing("EACCES"),
				"/proc/11/cwd": failing("EPERM"),
				"/proc/12/cwd": "/trees/a",
			}),
		);

		expect(
			[...(busy ?? [])],
			"an unreadable process ended the reading",
		).toEqual(["/trees/a"]);
	});

	it("can't say when a read fails for want of files, even after one ended", async () => {
		const reading = await busyAmongBy(
			["/trees/a"],
			machine({
				"/proc/10/cwd": "/home",
				"/proc/10/fd/3": failing("EMFILE"),
				"/proc/11/cwd": failing("ENOENT"),
			}),
		);

		expect(
			reading,
			"a reading that missed a process called its trees free",
		).toBe(undefined);
	});

	it("can't say from inside another process namespace", async () => {
		const reading = await busyAmongBy(
			["/trees/a"],
			machine({
				"/proc/self/ns/pid": "pid:[4026532999]",
				"/proc/10/cwd": "/home",
			}),
		);

		expect(reading, "a namespace's share of the processes was trusted").toBe(
			undefined,
		);
	});

	it("can't say with no /proc", async () => {
		const reading = await busyAmongBy(
			["/trees/a"],
			machine({
				"/proc/self/ns/pid": failing("ENOENT"),
			}),
		);

		expect(reading, "a machine with no /proc was trusted").toBe(undefined);
	});
});
