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
	closeSync,
	constants,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { STRAY_FOR_MS } from "../../../host/engine/carried-shells.ts";
import { SessionHost } from "../../../host/engine/index.ts";
import { KEPT_FOR_MS } from "../../../host/engine/kept-fences.ts";
import { tellHostFence } from "../../../lib/internal/sandbox/fence-told.ts";
import {
	closedState,
	fences,
	owner,
	putDown,
	registration,
	start,
	told,
} from "./fixtures/fence-host.ts";

const asked = { reason: "a test" };
afterEach(putDown);

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

it("keeps a looser fence through a close, a release's or one for good, since its reap may miss what it left", async () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	told(host, "a", "none");
	told(host, "b", "none");
	// A release keeps its `&` commands; a close for good reaps only those
	// still carrying its marker.
	await host.close("a", "released", true);
	await host.close("b", "closed");
	host.register(registration("a"));
	host.register(registration("b"));
	told(host, "a", "strict");
	told(host, "b", "strict");
	expect(fences(host)).toEqual({ a: "none", b: "none" });
});

it("forgets a park's fence a day after, when what the park kept is no longer spared", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const host = start();
		host.register(registration("a"));
		host.register(registration("b"));
		told(host, "a", "none");
		told(host, "b", "none");
		await host.stop("a", "parked");
		await host.stop("b", "parked");
		vi.setSystemTime(Date.now() + KEPT_FOR_MS - 1);
		host.register(registration("a"));
		told(host, "a", "strict");
		vi.setSystemTime(Date.now() + 2);
		host.register(registration("b"));
		told(host, "b", "strict");
		expect(fences(host)).toEqual({ a: "none", b: "strict" });
	} finally {
		vi.useRealTimers();
	}
});

it("keeps a park's fence past the day of the notes written before it, which spare what it kept", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const host = start();
		const parked = Date.now();
		host.register(registration("a"));
		told(host, "a", "none");
		await host.stop("a", "parked");
		vi.setSystemTime(parked + STRAY_FOR_MS + 60_000);
		host.register(registration("a"));
		told(host, "a", "strict");
		expect(fences(host)).toEqual({ a: "none" });
	} finally {
		vi.useRealTimers();
	}
});

it("gives an earlier park's fence a new day when a later park does, since its notes renew what the first left", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const host = start();
		const first = Date.now();
		host.register(registration("a"));
		told(host, "a", "none");
		await host.stop("a", "parked");
		const second = first + KEPT_FOR_MS - 2;
		vi.setSystemTime(second);
		host.register(registration("a"));
		told(host, "a", "strict");
		// The second park notes the first's `&` command again, sparing it a
		// new day, whatever this hold was told.
		await host.stop("a", "parked");
		vi.setSystemTime(first + KEPT_FOR_MS + 1);
		host.register(registration("a"));
		told(host, "a", "strict");
		const renewed = fences(host).a;
		await host.stop("a", "parked");
		vi.setSystemTime(Date.now() + KEPT_FOR_MS + 1);
		host.register(registration("a"));
		told(host, "a", "strict");
		expect(renewed, "within the second park's day").toBe("none");
		expect(fences(host), "past the last park's day").toEqual({
			a: "strict",
		});
	} finally {
		vi.useRealTimers();
	}
});

it("gives an earlier host's unfenced count a new day when a park here renews its notes", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const host = start();
		const now = Date.now();
		host.keptBefore(new Map([["a", now - KEPT_FOR_MS + 2]]));
		host.register(registration("a"));
		// This hold's runner tells no fence, but its park notes again what
		// the earlier host's left.
		await host.stop("a", "parked");
		vi.setSystemTime(now + 3);
		host.register(registration("a"));
		told(host, "a", "strict");
		expect(fences(host)).toEqual({ a: "none" });
	} finally {
		vi.useRealTimers();
	}
});

it("counts what an earlier host's parks kept as unfenced, since it forgot their fence", () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const host = start();
		// The notes outlive the restart; the fence each park kept didn't.
		const now = Date.now();
		host.keptBefore(
			new Map([
				["a", now],
				["b", now - KEPT_FOR_MS + 2],
			]),
		);
		host.register(registration("a"));
		told(host, "a", "strict");
		vi.setSystemTime(now + 2);
		host.register(registration("b"));
		told(host, "b", "strict");
		host.register(registration("c"));
		told(host, "c", "strict");
		expect(fences(host)).toEqual({ a: "none", b: "strict", c: "strict" });
	} finally {
		vi.useRealTimers();
	}
});

it("says which sessions an earlier host's notes count as unfenced, and until when", () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const said: string[] = [];
	const spy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((text) => said.push(String(text)) > 0);
	try {
		const host = start();
		const now = Date.now();
		host.keptBefore(
			new Map([
				["a", now],
				["b", now - KEPT_FOR_MS],
			]),
		);
		const until = new Date(now + KEPT_FOR_MS).toISOString();
		expect(said.filter((line) => line.includes("as unfenced until"))).toEqual([
			expect.stringContaining(`counts a as unfenced until ${until}`),
		]);
	} finally {
		spy.mockRestore();
		vi.useRealTimers();
	}
});

it("counts an earlier host's latest note, a park's or a carried call's, to its day", () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const host = start();
		const now = Date.now();
		// A park long ago, then a call its restart carried just now.
		host.keptBefore(
			new Map([["a", now - KEPT_FOR_MS + 2]]),
			new Map([["a", now]]),
		);
		vi.setSystemTime(now + 2);
		host.register(registration("a"));
		told(host, "a", "strict");
		expect(fences(host)).toEqual({ a: "none" });
	} finally {
		vi.useRealTimers();
	}
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

it("keeps through the replacement's park the fence it was handed, and what the first's park kept", async () => {
	const host = start();
	host.register(registration("a"));
	told(host, "a", "none");
	host.register(registration("b"));
	told(host, "b", "strict");
	host.inherit("a", "b");
	await host.close("a", "replaced");
	await host.stop("b", "parked");
	host.register(registration("b"));
	told(host, "b", "strict");
	// And one whose first was parked unfenced before pi replaced it.
	host.register(registration("c"));
	told(host, "c", "none");
	await host.stop("c", "parked");
	host.register(registration("c"));
	told(host, "c", "strict");
	host.register(registration("d"));
	told(host, "d", "strict");
	host.inherit("c", "d");
	await host.close("c", "replaced");
	await host.stop("d", "parked");
	host.register(registration("d"));
	told(host, "d", "strict");
	expect(fences(host)).toEqual({ b: "none", d: "none" });
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
			// Refused, and rewritten naming none, though both guards told one.
			expect(host.fenced("a", "none", "files"), "went unrefused").toBe(false);
			expect(fences(host), "the rewrite named a fence").toEqual({
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

it.skipIf(asRoot)(
	"unsays the fence of a runner that left, when no new record can be written",
	() => {
		const state = closedState();
		const host = start(state);
		host.register(registration("a"));
		told(host, "a", "strict");
		const folder = join(state, "agentic-harness.pi/hosts");
		chmodSync(folder, 0o555);
		try {
			// The runner's shell shuts down, as at a reload under a full disk.
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
	const host = start(state, join(state, "linked/hosts"));
	// A fenced command swaps the link for a folder of its own.
	rmSync(join(state, "linked"));
	mkdirSync(join(state, "linked/hosts"), { recursive: true });
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: undefined });
});

/** What the host says on its log while `act` runs, naming no fence. */
function saidUnclosed(act: () => void): string | undefined {
	const said: string[] = [];
	const spy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((text) => said.push(String(text)) > 0);
	try {
		act();
	} finally {
		spy.mockRestore();
	}
	return said.find((line) => line.includes("names no"));
}

it("says which folder names no fence and why, needing no restart once it's put right", () => {
	const state = closedState();
	const host = start(state);
	const said = saidUnclosed(() => {
		chmodSync(join(state, "agentic-harness.pi"), 0o777);
		host.register(registration("a"));
	});
	expect(said, "didn't name the folder others may write").toContain(
		`${join(state, "agentic-harness.pi")} may be written by another account`,
	);
	expect(said, "asked a restart for what clears as it's fixed").not.toMatch(
		/restart/,
	);
});

it("says which folder named no fence as the host started, and to restart once it's put right", () => {
	const state = closedState();
	const real = join(state, "real");
	mkdirSync(real);
	symlinkSync(real, join(state, "linked"));
	const said = saidUnclosed(() =>
		start(state, join(state, "linked/hosts")).register(registration("a")),
	);
	expect(said, "didn't name the link").toContain(
		`${join(state, "linked")} is a link`,
	);
	expect(said, "didn't ask a restart").toMatch(/restart/);
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

it("leaves pi's state as it is where a link lies above it, as a dotfile manager's may", () => {
	const base = closedState();
	const shared = join(base, "real/state/agentic-harness.pi");
	mkdirSync(join(shared, "hosts"), { recursive: true });
	chmodSync(shared, 0o775);
	symlinkSync(join(base, "real"), join(base, "linked"));
	// No step of the walk ends in the link, so only its real path tells.
	start(join(base, "linked/state"));
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
			() => symlinkSync(kept, host.registryPath),
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
			expect(readFileSync(kept, "utf8"), "wrote through what was put").toBe(
				"the person's own",
			);
			told(host, "a", "strict");
		}
	},
);

it.skipIf(asRoot)(
	"writes nothing into a FIFO that has a reader, by its file check or the pipe's refusal",
	() => {
		const state = closedState();
		const host = start(state);
		host.register(registration("a"));
		told(host, "a", "strict");
		const folder = join(state, "agentic-harness.pi/hosts");
		rmSync(host.registryPath);
		execFileSync("mkfifo", [host.registryPath]);
		// With a reader the host's open succeeds. Its file check refuses
		// then, and a positioned write, which a pipe refuses, would too, so
		// this guards the outcome rather than either.
		const reader = openSync(
			host.registryPath,
			constants.O_RDONLY | constants.O_NONBLOCK,
		);
		chmodSync(folder, 0o555);
		try {
			host.left("a");
			expect(readSync(reader, Buffer.alloc(64)), "wrote into a FIFO").toBe(0);
		} finally {
			closeSync(reader);
			chmodSync(folder, 0o755);
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

it("names a fence where earlier code left the home's folders above pi's state open to the group", () => {
	const home = closedState();
	const state = join(home, ".local/state/pi");
	mkdirSync(state, { recursive: true });
	// As other code makes them under a umask of 002; the home is the
	// person's, and one the group may write but no one else's entries.
	chmodSync(join(home, ".local"), 0o775);
	chmodSync(join(home, ".local/state"), 0o775);
	chmodSync(home, 0o1775);
	const said: string[] = [];
	const spy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((text) => said.push(String(text)) > 0);
	let host: SessionHost;
	try {
		host = start(state);
	} finally {
		spy.mockRestore();
	}
	expect(
		said.filter((line) => line.includes("to others' writes")),
		"said each folder it closed",
	).toEqual([
		expect.stringContaining(
			`${join(home, ".local")} to others' writes, from 775 to 755`,
		),
		expect.stringContaining(
			`${join(home, ".local/state")} to others' writes, from 775 to 755`,
		),
	]);
	host.register(registration("a"));
	told(host, "a", "strict");
	expect(fences(host)).toEqual({ a: "strict" });
	expect(statSync(home).mode & 0o7777, "changed the home").toBe(0o1775);
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
	expect(why[0], "didn't say no record lies there").toMatch(
		/no record lies there to name a fence/,
	);
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

it.each([
	["as it is", (base: string) => base],
	[
		"reached through a link above it, as /home to /var/home",
		(base: string) => {
			mkdirSync(join(base, "real/home"), { recursive: true });
			symlinkSync(join(base, "real"), join(base, "linked"));
			return join(base, "linked/home");
		},
	],
])(
	"names a fence where pi keeps its records by default, in the folder the fence closes, with a home %s",
	async (_, homeIn) => {
		const home = homeIn(closedState());
		vi.stubEnv("HOME", home);
		vi.stubEnv("XDG_STATE_HOME", undefined);
		let host: SessionHost | undefined;
		try {
			host = new SessionHost({ key: "test-host", owner });
			host.register(registration("a"));
			told(host, "a", "strict");
			expect(relative(home, host.registryPath)).toMatch(
				/^\.local\/state\/pi\//,
			);
			expect(fences(host)).toEqual({ a: "strict" });
		} finally {
			// Put down before the environment it read is put back.
			if (host) {
				await host.close("a");
				host.dispose();
			}
			vi.unstubAllEnvs();
		}
	},
);

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
