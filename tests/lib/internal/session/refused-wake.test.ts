/** A refused wake: what asked for it and why it was refused, kept beside its wake file. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearRefusedWake,
	readRefusedWake,
	wakeAskedBy,
	writeRefusedWake,
} from "../../../../lib/internal/session/refused-wake.ts";

let dir: string;
let wake: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "refused-wake-"));
	wake = join(dir, "wake");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("a refused wake", () => {
	it("is read back as it was written, until it is cleared", () => {
		const refused = {
			messageId: "2f95756a",
			reason: "the host is stopping",
			at: "2026-11-11T14:00:00.000Z",
		};

		writeRefusedWake(wake, refused);

		expect(readRefusedWake(wake), "read back whole").toEqual(refused);
		clearRefusedWake(wake);
		expect(readRefusedWake(wake), "gone once cleared").toBeUndefined();
	});

	it("is nothing where none was written, or what was written is no record", async () => {
		expect(readRefusedWake(wake), "none written").toBeUndefined();
		await writeFile(`${wake}.refused`, "{half");
		expect(readRefusedWake(wake), "half written").toBeUndefined();
		await writeFile(`${wake}.refused`, JSON.stringify({ at: "now" }));
		expect(readRefusedWake(wake), "no reason").toBeUndefined();
	});

	it("names the message a sender's wake file says asked for it, and none for a bare write", () => {
		expect(
			wakeAskedBy(
				`${JSON.stringify({ session: "a", messageId: "2f95756a", at: "now" })}\n`,
			),
			"a sender's wake",
		).toBe("2f95756a");
		expect(wakeAskedBy("message"), "a bare write").toBeUndefined();
		expect(wakeAskedBy(JSON.stringify({ messageId: 7 })), "no id").toBe(
			undefined,
		);
	});
});
