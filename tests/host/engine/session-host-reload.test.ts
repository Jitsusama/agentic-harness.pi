/** Reloading one hosted conversation keeps it held and leaves its sibling alone. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	type ConversationRegistration,
	HOST_RELOAD_ONTO,
	SessionHost,
} from "../../../host/engine/index.ts";
import {
	ambientSession,
	sessionEnv,
	sessionSlot,
} from "../../../lib/core/session/index.ts";

const owner = { pid: 123, startedAt: 1000, bootId: "boot", startTicks: 20 };
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

function start() {
	const dir = mkdtempSync(join(tmpdir(), "session-engine-reload-"));
	directories.push(dir);
	const host = new SessionHost({ key: "test-host", owner, registryDir: dir });
	hosts.push(host);
	return host;
}

function registration(
	id: string,
	parts: Partial<ConversationRegistration> = {},
): ConversationRegistration {
	return {
		id,
		file: `/sessions/${id}.jsonl`,
		cwd: `/repo/${id}`,
		env: { MARKER: id },
		close: () => {},
		...parts,
	};
}

/** A conversation's slot, made under it. */
function slotOf(host: SessionHost, id: string) {
	return host.run(id, () =>
		sessionSlot("reload-test", undefined, () => ({ marker: id })),
	);
}

it("reloads one conversation under its own context, keeping what it holds", async () => {
	const host = start();
	const seen: unknown[] = [];
	const closeA = vi.fn();
	const closeB = vi.fn();
	const stampA = vi.fn();
	host.register(
		registration("a", {
			close: closeA,
			stamp: stampA,
			reload: (request) => {
				seen.push([ambientSession(), request.reason]);
			},
		}),
	);
	host.register(registration("b", { close: closeB }));
	const slotA = slotOf(host, "a");
	const slotB = slotOf(host, "b");
	host.run("a", () => sessionEnv().set("CARRIED", "kept"));
	const before = readFileSync(host.registryPath, "utf8");

	await host.reload("a", { reason: "try the new footer" });

	expect(seen, "the runner reloads A as A, once").toEqual([
		["a", "try the new footer"],
	]);
	expect(slotOf(host, "a"), "A keeps its slots").toBe(slotA);
	expect(slotOf(host, "b"), "B keeps its slots").toBe(slotB);
	expect(host.env("a").get("CARRIED"), "A keeps its environment").toBe("kept");
	expect(host.holds("a")).toBe("idle");
	expect(host.run("b", () => "running")).toBe("running");
	expect(
		readFileSync(host.registryPath, "utf8"),
		"the published list is as it was",
	).toBe(before);
	expect(closeA).not.toHaveBeenCalled();
	expect(closeB).not.toHaveBeenCalled();
	expect(stampA).not.toHaveBeenCalled();
});

it("joins a reload already under way rather than starting a second", async () => {
	const host = start();
	let finish: () => void = () => {};
	const reload = vi
		.fn<NonNullable<ConversationRegistration["reload"]>>()
		.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
	host.register(registration("a", { reload }));

	const first = host.reload("a", { reason: "first" });
	const second = host.reload("a", { reason: "second" });
	expect(second).toBe(first);
	await Promise.resolve();
	finish();
	await first;

	expect(reload).toHaveBeenCalledTimes(1);
	await host.reload("a", { reason: "after" });
	expect(reload, "a later ask reloads again").toHaveBeenCalledTimes(2);
});

it("refuses an unknown or closing conversation, another tree, and a runner with no reload", async () => {
	const host = start();
	let finish: () => void = () => {};
	const closing = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const reload = vi.fn();
	host.register(registration("a", { reload, close: () => closing }));
	host.register(registration("b"));

	await expect(host.reload("z", { reason: "x" })).rejects.toThrow(
		"not held: z",
	);
	await expect(
		host.reload("a", { reason: "x", onto: "/trees/other" }),
	).rejects.toThrow(HOST_RELOAD_ONTO);
	await expect(host.reload("b", { reason: "x" })).rejects.toThrow(
		"can't be reloaded: b",
	);
	const closed = host.close("a");
	await expect(host.reload("a", { reason: "x" })).rejects.toThrow("closing: a");
	finish();
	await closed;
	expect(reload).not.toHaveBeenCalled();
});

it("leaves a conversation held and usable when its reload fails", async () => {
	const host = start();
	const reload = vi
		.fn<NonNullable<ConversationRegistration["reload"]>>()
		.mockRejectedValueOnce(new Error("runner busy"))
		.mockResolvedValueOnce(undefined);
	host.register(registration("a", { reload }));
	const slot = slotOf(host, "a");

	await expect(host.reload("a", { reason: "x" })).rejects.toThrow(
		"runner busy",
	);

	expect(host.holds("a")).toBe("idle");
	expect(host.run("a", () => "usable")).toBe("usable");
	expect(slotOf(host, "a"), "its slots survive the failure").toBe(slot);
	await host.reload("a", { reason: "again" });
	expect(reload).toHaveBeenCalledTimes(2);
});
