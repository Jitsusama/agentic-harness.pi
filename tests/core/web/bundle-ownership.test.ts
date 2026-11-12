/** Captured page bundles keep stable session directories and are reaped only when proven abandoned. */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareArtifactOwnership } from "../../../lib/core/internal/artifacts/ownership.ts";
import {
	installHost,
	type SessionOwner,
} from "../../../lib/core/session/index.ts";
import {
	BUNDLE_ROOT,
	diskSink,
	sessionDir,
} from "../../../lib/core/web/envelope/sink.ts";
import {
	cleanupSessionBundles,
	reapAbandonedBundles,
} from "../../../lib/core/web/reader.ts";
import { ArtifactLedger } from "../../../lib/core/web/session/artifacts.ts";
import { resultSession } from "../../support/result-session.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function session() {
	const ctx = resultSession();
	const dir = join(
		BUNDLE_ROOT,
		encodeURIComponent(ctx.sessionManager.getSessionId()),
	);
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return ctx;
}
function host(owner: SessionOwner) {
	const end = installHost({
		kind: "pi-durable",
		key: "bundle-host",
		owner,
		holds: () => "idle",
		env: () => {
			throw new Error("Bundle tests do not consume host env");
		},
		hints: () => ({}),
		close: () => {},
		stamp: () => {},
	});
	cleanups.push(end);
	return end;
}
function ownerOf(dir: string): unknown {
	return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")).owner;
}
const BEFORE = { pid: 101, startedAt: 1000, bootId: "before", startTicks: 10 };
const AFTER = { pid: 202, startedAt: 2000, bootId: "after", startTicks: 20 };

describe("web bundle ownership", () => {
	it("keeps two hosted callers' bundles apart and readable across a host restart", async () => {
		const a = session();
		const b = session();
		const stop = host(BEFORE);
		const fileA = diskSink(undefined, a).writeText("dom.html", "a");
		const fileB = diskSink(undefined, b).writeText("dom.html", "b");
		const dirA = sessionDir(a);
		expect(dirname(dirname(fileA))).toBe(dirA);
		expect(dirname(dirname(fileB))).toBe(sessionDir(b));
		expect(sessionDir(b)).not.toBe(dirA);
		// A hosted quit may be a host stop, so it removes nothing.
		cleanupSessionBundles(a);
		stop();
		// The crashed owner is gone, but no catalogue answer proves A closed.
		await reapAbandonedBundles({ standing: async () => "gone" });
		host(AFTER);
		expect(sessionDir(a)).toBe(dirA);
		expect(readFileSync(fileA, "utf8")).toBe("a");
		expect(readFileSync(fileB, "utf8")).toBe("b");
		diskSink(undefined, a);
		expect(ownerOf(dirA)).toMatchObject({
			...AFTER,
			session: a.sessionManager.getSessionId(),
			host: "bundle-host",
		});
	});

	it.each(["held", "unknown"] as const)(
		"preserves a dead hosted owner's bundles when the catalogue says %s",
		async (status) => {
			const ctx = session();
			host(BEFORE);
			const file = diskSink(undefined, ctx).writeText("dom.html", "kept");
			await reapAbandonedBundles({
				standing: async () => "gone",
				heldSessionStatus: async () => status,
			});
			expect(readFileSync(file, "utf8")).toBe("kept");
		},
	);

	it("reaps only the hosted conversation the catalogue says is unheld", async () => {
		const a = session();
		const b = session();
		host(BEFORE);
		diskSink(undefined, a).writeText("dom.html", "a");
		const kept = diskSink(undefined, b).writeText("dom.html", "b");
		await reapAbandonedBundles({
			standing: async () => "gone",
			heldSessionStatus: async (id) =>
				id === a.sessionManager.getSessionId() ? "unheld" : "held",
		});
		expect(
			existsSync(sessionDir(a)),
			"A's bundles are reaped after a definitive close",
		).toBe(false);
		expect(readFileSync(kept, "utf8")).toBe("b");
	});

	it("removes only the quitting plain-pi caller's bundles", async () => {
		const a = session();
		const b = session();
		await prepareArtifactOwnership(a);
		diskSink(undefined, a).writeText("dom.html", "a");
		const kept = diskSink(undefined, b).writeText("dom.html", "b");
		expect(ownerOf(sessionDir(a))).toMatchObject({ pid: process.pid });
		cleanupSessionBundles(a);
		expect(
			existsSync(sessionDir(a)),
			"plain-pi quit removes the caller's bundles",
		).toBe(false);
		expect(readFileSync(kept, "utf8")).toBe("b");
	});

	it("binds a browser ledger to the identity it was built with", () => {
		const a = session();
		host(BEFORE);
		const sink = new ArtifactLedger(a).sink();
		expect(dirname(sink.dir)).toBe(sessionDir(a));
	});

	it("still sweeps pid directories that carry no owner record", async () => {
		// Above the kernel's highest pid, so no process can hold it.
		const dead = join(BUNDLE_ROOT, String(2 ** 22 + 1));
		const live = join(BUNDLE_ROOT, String(process.pid));
		for (const dir of [dead, live]) {
			mkdirSync(dir, { recursive: true });
			cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		}
		await reapAbandonedBundles();
		expect(existsSync(dead), "a dead pid's directory is reaped").toBe(false);
		expect(existsSync(live), "this process's directory is kept").toBe(true);
	});
});
