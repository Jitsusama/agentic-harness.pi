/**
 * A carry still running in this process is spared by every copy of the
 * staging code it holds, and no carry is staged through a link.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const STAGE = "../../../../lib/internal/carry/stage.ts";

type StageModule = typeof import("../../../../lib/internal/carry/stage.ts");

const made: string[] = [];

afterEach(() => {
	for (const path of made.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

/** A quest's handover in a fresh folder of quest scratches. */
function handover(): string {
	const workspaces = mkdtempSync(join(tmpdir(), "carry-live-"));
	made.push(workspaces);
	const into = join(workspaces, "QEST-1", "handover", "kestrel");
	mkdirSync(into, { recursive: true });
	return into;
}

/** A fresh copy of the staging code, as another extension or a reload loads it. */
async function copyOfStage(): Promise<StageModule> {
	vi.resetModules();
	return (await import(STAGE)) as StageModule;
}

describe("staging a carry", () => {
	it("spares a carry still running in this process through another copy of its code", async () => {
		const into = handover();
		const first = await copyOfStage();
		const second = await copyOfStage();
		expect(second, "two copies, as pi's loader gives").not.toBe(first);
		let placed = (): void => {};
		let finish = (): void => {};
		const placing = new Promise<void>((resolve) => {
			placed = resolve;
		});
		const running = first.staged(into, "s-a", async (stage) => {
			writeFileSync(join(stage.folder, "a.bundle"), "carried\n");
			stage.place(["a.bundle"]);
			placed();
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		await placing;

		await second.staged(into, "s-b", async () => {});

		expect(
			existsSync(join(into, "a.bundle")),
			"the running carry's file stays while it runs",
		).toBe(true);
		finish();
		await running;
		expect(readdirSync(into)).toEqual(["a.bundle"]);
	});

	it("writes no done file through a handover swapped for a link after it placed", async () => {
		const into = handover();
		const stage = await copyOfStage();
		const elsewhere = mkdtempSync(join(tmpdir(), "carry-elsewhere-"));
		made.push(elsewhere);

		await expect(
			stage.staged(into, "s-d", async (staging) => {
				writeFileSync(join(staging.folder, "d.bundle"), "carried\n");
				staging.place(["d.bundle"]);
				// A fenced command may write the handover, so may swap it.
				renameSync(into, `${into}.moved`);
				symlinkSync(elsewhere, into);
				staging.write(() => writeFileSync(join(into, "s-d.done.json"), "{}\n"));
			}),
		).rejects.toThrow(/is a link or no folder/);

		expect(readdirSync(elsewhere), "nothing was written where it led").toEqual(
			[],
		);
	});

	it.each([
		[
			"the folder of staging folders",
			(into: string, stage: StageModule) => dirname(stage.stagingOf(into)),
		],
		[
			"the quest's staging folder",
			(into: string, stage: StageModule) => stage.stagingOf(into),
		],
	])("stages nothing where %s is a link", async (_, linked) => {
		const into = handover();
		const stage = await copyOfStage();
		const elsewhere = mkdtempSync(join(tmpdir(), "carry-elsewhere-"));
		made.push(elsewhere);
		const at = linked(into, stage);
		mkdirSync(dirname(at), { recursive: true });
		symlinkSync(elsewhere, at);
		let ran = false;

		await expect(
			stage.staged(into, "s-c", async () => {
				ran = true;
			}),
		).rejects.toThrow(
			/is a link or no folder, so no carry is staged through it\.$/,
		);

		expect(ran, "its work never ran").toBe(false);
		expect(readdirSync(elsewhere), "nothing was made where it led").toEqual([]);
	});
});
