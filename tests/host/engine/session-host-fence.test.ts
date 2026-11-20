/**
 * The host's record says each session's fence as its tools told the
 * host they hold it, the loosest since it opened in the host, and only
 * once its present runner's shell and file guard have both told one: a
 * pi host's own environment says nothing of any one session's, so the
 * mycelium node reads a hosted session's fence from this record
 * (KP0L6A, 19 November) and refuses one that says none. A record a
 * fenced command could put in this one's place says none.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	type ConversationRegistration,
	SessionHost,
} from "../../../host/engine/index.ts";
import { tellHostFence } from "../../../lib/internal/sandbox/fence-told.ts";
import type { FenceKind } from "../../../lib/mesh/presence.ts";

const owner = { pid: 123, startedAt: 1000, bootId: "boot", startTicks: 20 };
const asked = { reason: "a test" };
const hosts: SessionHost[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) {
		for (const { id } of host.list()) await host.close(id);
		host.dispose();
	}
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A closed state folder of its own, spelled as it really is. */
function closedState(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "session-host-fence-")));
	directories.push(dir);
	return dir;
}

function start(
	state = closedState(),
	registryDir = join(state, "agentic-harness.pi/hosts"),
): SessionHost {
	const host = new SessionHost({
		key: "test-host",
		owner,
		registryDir,
		closedState: state,
	});
	hosts.push(host);
	return host;
}

function registration(
	id: string,
	extra: Partial<ConversationRegistration> = {},
): ConversationRegistration {
	return {
		id,
		file: `/sessions/${id}.jsonl`,
		cwd: `/repo/${id}`,
		env: {},
		hints: {},
		close: () => {},
		...extra,
	};
}

/** Each session's fence, as the host's record says it. */
function fences(host: SessionHost): Record<string, unknown> {
	const read = JSON.parse(readFileSync(host.registryPath, "utf8")) as {
		sessions: { id: string; fence?: unknown }[];
	};
	return Object.fromEntries(read.sessions.map(({ id, fence }) => [id, fence]));
}

/** A runner starting, its file guard and then its shell telling the host. */
function told(host: SessionHost, id: string, fence: FenceKind): void {
	host.fenced(id, fence, "files");
	host.fenced(id, fence, "shell");
}

it("says no session's fence until its shell and its file guard both tell it", () => {
	const host = start();
	host.register(registration("a", { env: { PI_SANDBOX: "strict" } }));
	host.register(registration("b", { env: { PI_SANDBOX: "strict" } }));
	expect(fences(host), "named before anything told").toEqual({
		a: undefined,
		b: undefined,
	});
	// Each guards only its own tools: pi's file tools say nothing of
	// bash, and the shell nothing of pi's file tools.
	host.fenced("a", "strict", "files");
	host.fenced("b", "strict", "shell");
	expect(fences(host), "named by one guard alone").toEqual({
		a: undefined,
		b: undefined,
	});
	host.fenced("a", "strict", "shell");
	host.fenced("b", "strict", "files");
	expect(fences(host)).toEqual({ a: "strict", b: "strict" });
});

it("says each session's fence as its tools told it", () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	host.register(registration("c"));
	told(host, "a", "fence");
	told(host, "b", "strict");
	told(host, "c", "none");
	expect(fences(host)).toEqual({ a: "fence", b: "strict", c: "none" });
});

it("says nothing new when the session's environment asks for another fence", () => {
	const host = start();
	host.register(registration("a", { env: { PI_SANDBOX: "strict" } }));
	told(host, "a", "strict");
	// Its tools still hold it to what they said; the record is written
	// again, so a fence worked out from the environment would show.
	host.env("a").set("PI_SANDBOX", "off");
	host.state("a", "busy");
	expect(fences(host)).toEqual({ a: "strict" });
});

it("keeps the loosest fence its tools told, never a tighter one after", () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	told(host, "a", "strict");
	host.fenced("a", "none", "files");
	told(host, "b", "none");
	host.fenced("b", "strict", "files");
	expect(fences(host)).toEqual({ a: "none", b: "none" });
});

it("says nothing through a reload until the new runner's guards tell it", async () => {
	const host = start();
	let during: unknown = "unread";
	host.register(
		registration("a", {
			reload: () => {
				// pi shuts the old runner down, and its guards say they left.
				host.left("a");
				during = fences(host).a;
				told(host, "a", "strict");
			},
		}),
	);
	told(host, "a", "strict");
	await host.reload("a", asked);
	expect(during, "named while reloading").toBeUndefined();
	expect(fences(host)).toEqual({ a: "strict" });
});

it("keeps a looser fence told before a reload, since its commands may still run", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => {
				host.left("a");
				told(host, "a", "strict");
			},
		}),
	);
	told(host, "a", "none");
	await host.reload("a", asked);
	expect(fences(host)).toEqual({ a: "none" });
});

it("keeps a looser fence through a park, since what it left running runs on", async () => {
	const host = start();
	host.register(registration("a"));
	told(host, "a", "none");
	// A park ends the conversation's runner, keeping its `&` commands.
	await host.stop("a", "parked");
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: "none" });
});

it("keeps a looser fence through a release, since what it left running is kept", async () => {
	const host = start();
	host.register(registration("a"));
	told(host, "a", "none");
	// A release ends the conversation here as a close, keeping its `&` commands.
	host.handsOn("a");
	await host.close("a", "released");
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: "none" });
});

it("counts a runner whose shell never told as unfenced, since pi ran its own bash", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => {
				// Only the file guard is there to say it left.
				host.left("a");
				told(host, "a", "strict");
			},
		}),
	);
	host.register(registration("b"));
	// Each runner's shell failed to load; only its file guard told.
	host.fenced("a", "strict", "files");
	host.fenced("b", "strict", "files");
	await host.reload("a", asked);
	await host.stop("b", "parked");
	host.register(registration("b"));
	told(host, "b", "strict");
	expect(fences(host)).toEqual({ a: "none", b: "none" });
});

it("counts a runner whose file guard never told as unfenced", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => told(host, "a", "strict"),
		}),
	);
	host.fenced("a", "strict", "shell");
	// The shell shuts down with its runner, before the reload.
	host.left("a");
	await host.reload("a", asked);
	expect(fences(host)).toEqual({ a: "none" });
});

it("forgets a fence once its conversation is closed for good", async () => {
	const host = start();
	host.register(registration("a"));
	told(host, "a", "none");
	await host.close("a");
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: "strict" });
});

it("hands a looser fence on to the conversation pi replaces one with", async () => {
	const host = start();
	host.register(registration("a"));
	told(host, "a", "none");
	host.register(registration("b"));
	told(host, "b", "strict");
	// What the one it replaces left running carries on as the new one's.
	host.inherit("a", "b");
	await host.close("a", "replaced");
	expect(fences(host)).toEqual({ b: "none" });
});

it("says no fence after a reload whose shell tells none, whatever else does", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => {
				host.left("a");
				host.fenced("a", "strict", "files");
			},
		}),
	);
	told(host, "a", "strict");
	await host.reload("a", asked);
	expect(fences(host)).toEqual({ a: undefined });
});

it("says no fence after a reload whose file guard tells none", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => {
				host.left("a");
				host.fenced("a", "strict", "shell");
			},
		}),
	);
	told(host, "a", "strict");
	await host.reload("a", asked);
	expect(fences(host)).toEqual({ a: undefined });
});

it("says no fence once the old shell shuts down, though it told one draining", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => {
				// The old runner's last command, then its shutdown; the new
				// runner's guards never load.
				told(host, "a", "strict");
				host.left("a");
			},
		}),
	);
	told(host, "a", "strict");
	await host.reload("a", asked);
	expect(fences(host)).toEqual({ a: undefined });
});

it("says the new runner's fence after the old one told it draining", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => {
				// The old runner's last command tells it through the shell
				// alone, then it shuts down, then the new one's guards load.
				host.fenced("a", "strict", "shell");
				host.left("a");
				told(host, "a", "strict");
			},
		}),
	);
	told(host, "a", "strict");
	await host.reload("a", asked);
	expect(fences(host)).toEqual({ a: "strict" });
});

it("keeps the fence through a reload that failed before its runner shut down", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => {
				throw new Error("no runner could be made");
			},
		}),
	);
	told(host, "a", "strict");
	await expect(host.reload("a", asked)).rejects.toThrow(/runner could be made/);
	// The same runner carries on, and parks with what both its guards told.
	host.fenced("a", "strict", "shell");
	await host.stop("a", "parked");
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: "strict" });
});

it("says no fence after a reload that failed once its runner shut down", async () => {
	const host = start();
	host.register(
		registration("a", {
			reload: () => {
				host.left("a");
				throw new Error("an extension failed");
			},
		}),
	);
	told(host, "a", "strict");
	await expect(host.reload("a", asked)).rejects.toThrow(/extension failed/);
	expect(fences(host)).toEqual({ a: undefined });
});

it("counts a runner the person reloaded, whose shell never told, as unfenced", () => {
	const host = start();
	host.register(registration("a"));
	// A reload typed in pi never reaches the host; only the file guard
	// loaded, and says it left as its runner shuts down.
	host.fenced("a", "strict", "files");
	host.left("a");
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: "none" });
});

it("counts a replaced runner whose shell never told as unfenced in its replacement", async () => {
	const host = start();
	host.register(registration("a"));
	host.fenced("a", "strict", "files");
	host.register(registration("b"));
	told(host, "b", "strict");
	host.inherit("a", "b");
	await host.close("a", "replaced");
	expect(fences(host)).toEqual({ b: "none" });
});

it("refuses while the record can't be written, and writes it at the next ask", () => {
	const state = closedState();
	const host = start(state);
	host.register(registration("a"));
	told(host, "a", "strict");
	// A file where the records' folder stands, so no write lands.
	const folder = join(state, "agentic-harness.pi/hosts");
	rmSync(folder, { recursive: true });
	writeFileSync(folder, "in the way");
	expect(host.fenced("a", "none", "files"), "a write that failed landed").toBe(
		false,
	);
	expect(
		host.fenced("a", "none", "files"),
		"an unwritten fence wasn't tried again",
	).toBe(false);
	rmSync(folder);
	expect(host.fenced("a", "none", "files"), "the write failed again").toBe(
		true,
	);
	expect(fences(host)).toEqual({ a: "none" });
});

// Root writes a folder whatever its mode, so no write fails there.
const asRoot = process.getuid?.() === 0;

it.skipIf(asRoot)(
	"leaves no fence on disk that it no longer holds, when no new record can be written",
	() => {
		const state = closedState();
		const host = start(state);
		host.register(registration("a"));
		told(host, "a", "strict");
		// No new file can be made beside the record, as on a full disk, and
		// the runner's shell shuts down; the next may never load.
		const folder = join(state, "agentic-harness.pi/hosts");
		chmodSync(folder, 0o555);
		try {
			host.left("a");
			expect(fences(host), "the record kept a fence the host dropped").toEqual({
				a: undefined,
			});
			expect(
				host.fenced("a", "none", "files"),
				"a looser fence went unrefused",
			).toBe(false);
		} finally {
			chmodSync(folder, 0o755);
		}
		expect(host.fenced("a", "none", "files"), "the write failed again").toBe(
			true,
		);
	},
);

it("names no fence where its records lie past a link", () => {
	const state = closedState();
	const real = join(state, "real");
	mkdirSync(real);
	symlinkSync(real, join(state, "linked"));
	const host = start(state, join(state, "linked/hosts"));
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: undefined });
});

it("names no fence where its records lay past a link as it started", () => {
	const state = closedState();
	const real = join(state, "real");
	mkdirSync(real);
	symlinkSync(real, join(state, "linked"));
	const host = new SessionHost({
		key: "test-host",
		owner,
		registryDir: join(state, "linked/hosts"),
		closedState: state,
	});
	hosts.push(host);
	// A fenced command swaps the link for a folder of its own.
	rmSync(join(state, "linked"));
	mkdirSync(join(state, "linked/hosts"), { recursive: true });
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: undefined });
});

it("names no fence where others may write its records' folder", () => {
	const state = closedState();
	const host = start(state);
	host.register(registration("a"));
	// Another account could rename this record away and put its own there.
	chmodSync(join(state, "agentic-harness.pi/hosts"), 0o777);
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: undefined });
});

it.each(["agentic-harness.pi", ""])(
	"names no fence where others may write a folder above its records (%j)",
	(above) => {
		const state = closedState();
		const host = start(state);
		host.register(registration("a"));
		// Another account could rename the records' folder away and put its own there.
		chmodSync(join(state, above), 0o777);
		told(host, "a", "strict");
		expect(fences(host)).toEqual({ a: undefined });
	},
);

it("leaves a folder past a link as it is, closing nothing it doesn't judge", () => {
	const state = closedState();
	// A folder the person shares with a group on purpose.
	const shared = join(state, "real/hosts");
	mkdirSync(shared, { recursive: true });
	chmodSync(shared, 0o775);
	symlinkSync(join(state, "real"), join(state, "linked"));
	start(state, join(state, "linked/hosts"));
	expect(statSync(shared).mode & 0o777, "closed past a link").toBe(0o775);
});

it.skipIf(asRoot)(
	"neither waits on nor writes through what was put at its record's path",
	() => {
		const state = closedState();
		const host = start(state);
		host.register(registration("a"));
		told(host, "a", "strict");
		const folder = join(state, "agentic-harness.pi/hosts");
		const kept = join(state, "kept");
		writeFileSync(kept, "the person's own");
		for (const put of [
			() => execFileSync("mkfifo", [host.registryPath]),
			() => linkSync(kept, host.registryPath),
		]) {
			rmSync(host.registryPath);
			put();
			chmodSync(folder, 0o555);
			try {
				// A FIFO with no reader would hold the host's one thread here.
				host.left("a");
			} finally {
				chmodSync(folder, 0o755);
			}
			expect(readFileSync(kept, "utf8"), "wrote through a hard link").toBe(
				"the person's own",
			);
			told(host, "a", "strict");
		}
	},
);

it("names a fence where earlier code left the folders above its records open to the group", () => {
	const state = closedState();
	// As pi's other state code makes them, with no mode, under a umask of 002.
	mkdirSync(join(state, "agentic-harness.pi"));
	chmodSync(join(state, "agentic-harness.pi"), 0o775);
	chmodSync(state, 0o775);
	const host = start(state);
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: "strict" });
});

it("names no fence where its records lie outside what the fence closes", () => {
	const host = start(closedState(), join(closedState(), "hosts"));
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: undefined });
});

it("names a fence under a umask that lets the person's group write", () => {
	// As a distribution that gives each person a group of their own sets it.
	const was = process.umask(0o002);
	try {
		const host = start();
		host.register(registration("a"));
		told(host, "a", "strict");
		expect(fences(host)).toEqual({ a: "strict" });
	} finally {
		process.umask(was);
	}
});

it("names a fence where an earlier host left its records' folder open to the group", () => {
	const state = closedState();
	// As a host before this one made it, under a umask of 002.
	const folder = join(state, "agentic-harness.pi/hosts");
	mkdirSync(folder, { recursive: true });
	chmodSync(folder, 0o775);
	const host = start(state);
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: "strict" });
});

it("says once why a record couldn't be written", () => {
	const state = closedState();
	const host = start(state);
	host.register(registration("a"));
	const folder = join(state, "agentic-harness.pi/hosts");
	rmSync(folder, { recursive: true });
	writeFileSync(folder, "in the way");
	const said: string[] = [];
	const spy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((text) => said.push(String(text)) > 0);
	try {
		host.fenced("a", "strict", "files");
		host.fenced("a", "none", "files");
	} finally {
		spy.mockRestore();
		rmSync(folder);
	}
	const why = said.filter((line) => line.includes("couldn't write"));
	expect(why, "said other than once").toHaveLength(1);
	expect(why[0]).toMatch(/ENOTDIR|EEXIST/);
});

it.skipIf(asRoot)(
	"says once each outage why a record couldn't be written, and what became of it",
	() => {
		const state = closedState();
		const host = start(state);
		host.register(registration("a"));
		told(host, "a", "strict");
		const folder = join(state, "agentic-harness.pi/hosts");
		const said: string[] = [];
		const spy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((text) => said.push(String(text)) > 0);
		try {
			// Each write is made in a file of its own name, so the words differ.
			chmodSync(folder, 0o555);
			host.fenced("a", "none", "files");
			host.fenced("a", "none", "files");
			// Most writes that end an outage are a turn's state, not a tell.
			chmodSync(folder, 0o755);
			host.state("a", "busy");
			chmodSync(folder, 0o555);
			host.left("a");
		} finally {
			spy.mockRestore();
			chmodSync(folder, 0o755);
		}
		const why = said.filter((line) => line.includes("couldn't write"));
		expect(why, "not said once for each outage").toHaveLength(2);
		expect(why[0], "didn't say the record was rewritten").toMatch(
			/rewritten where it lies naming no session's fence/,
		);
	},
);

it("names a fence where pi keeps its records by default, in the folder the fence closes", async () => {
	const home = closedState();
	const was = { HOME: process.env.HOME, XDG: process.env.XDG_STATE_HOME };
	process.env.HOME = home;
	delete process.env.XDG_STATE_HOME;
	let host: SessionHost | undefined;
	try {
		host = new SessionHost({ key: "test-host", owner });
		host.register(registration("a"));
		told(host, "a", "strict");
		expect(
			host.registryPath.startsWith(join(home, ".local/state/pi/")),
			host.registryPath,
		).toBe(true);
		expect(fences(host)).toEqual({ a: "strict" });
	} finally {
		// Put down before the environment it read is put back.
		if (host) {
			await host.close("a");
			host.dispose();
		}
		process.env.HOME = was.HOME;
		if (was.XDG === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = was.XDG;
	}
});

it("hears the session each tool names, as the extensions name it from pi's", () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	// Each extension names the session pi gives it (sessionKeyOf), which
	// the engine keeps the conversation's own id.
	const env = { PI_SESSION_ID: "b" };
	tellHostFence("fence", "files", env, host);
	tellHostFence("fence", "shell", env, host);
	expect(fences(host)).toEqual({ a: undefined, b: "fence" });
});

it("refuses to say the fence of a session it doesn't hold", () => {
	const host = start();
	expect(() => host.fenced("gone", "fence", "shell")).toThrow(/gone/);
});
