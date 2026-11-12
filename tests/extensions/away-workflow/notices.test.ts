import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import type { NotifyDeps } from "../../../lib/internal/notify.ts";

/** Each test reads the module fresh, as a reload would. */
async function notices() {
	return await import("../../../extensions/away-workflow/notices.ts");
}

/**
 * A desktop that gives each notice the next id and records which ids
 * were closed. `hold` keeps the next show unanswered until it is let go.
 */
function desktop() {
	let next = 0;
	const closed: number[] = [];
	let held: (() => void) | undefined;
	let holding = false;
	const exec: Exec = async (command, args) => {
		if (command === "notify-send") {
			next += 1;
			const id = next;
			if (holding) {
				holding = false;
				await new Promise<void>((resolve) => {
					held = resolve;
				});
			}
			return { code: 0, stdout: `${id}\n`, stderr: "" };
		}
		closed.push(Number(args.at(-1)));
		return { code: 0, stdout: "", stderr: "" };
	};
	const deps: NotifyDeps = { platform: "linux", exec, env: {} };
	return {
		deps,
		closed,
		hold: () => {
			holding = true;
		},
		letGo: () => held?.(),
	};
}

afterEach(async () => {
	const { EVERY_NOTICE, withdrawNotices } = await notices();
	await withdrawNotices(EVERY_NOTICE, { env: { PI_NOTIFY: "off" } });
	vi.resetModules();
});

describe("the notices a session has up", () => {
	it("takes a notice back by the id the desktop gave it", async () => {
		const { raiseNotice, withdrawNotices } = await notices();
		const screen = desktop();
		await raiseNotice("resting", { title: "pi is resting" }, screen.deps);
		await withdrawNotices(["resting"], screen.deps);
		expect(screen.closed, "the resting notice, id 1, was closed").toEqual([1]);
	});

	it("replaces its own notice of the same kind", async () => {
		const { raiseNotice } = await notices();
		const screen = desktop();
		await raiseNotice("held", { title: "holds a call" }, screen.deps);
		await raiseNotice("held", { title: "holds 2 calls" }, screen.deps);
		expect(screen.closed, "the first held notice gave way").toEqual([1]);
	});

	it("leaves the other kinds up", async () => {
		const { raiseNotice, withdrawNotices } = await notices();
		const screen = desktop();
		await raiseNotice("held", { title: "holds a call" }, screen.deps);
		await raiseNotice("resting", { title: "is resting" }, screen.deps);
		await withdrawNotices(["resting"], screen.deps);
		expect(screen.closed, "only the resting notice, id 2, went").toEqual([2]);
	});

	it("takes back one withdrawn while it was still being shown", async () => {
		const { raiseNotice, withdrawNotices } = await notices();
		const screen = desktop();
		screen.hold();
		const raising = raiseNotice("asked", { title: "asked" }, screen.deps);
		await withdrawNotices(["asked"], screen.deps);
		expect(screen.closed, "nothing has an id to close yet").toEqual([]);
		screen.letGo();
		await raising;
		expect(screen.closed, "closed once the desktop said its id").toEqual([1]);
	});

	it("takes back, after a reload, what the copy before it raised", async () => {
		const before = await notices();
		const screen = desktop();
		await before.raiseNotice("blocked", { title: "needs you" }, screen.deps);
		vi.resetModules();
		const after = await notices();
		expect(after, "a fresh copy of the module").not.toBe(before);
		await after.withdrawNotices(after.EVERY_NOTICE, screen.deps);
		expect(screen.closed, "the old copy's notice was closed").toEqual([1]);
	});
});
