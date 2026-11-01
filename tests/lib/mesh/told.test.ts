/**
 * Who a peer has told of an overlap, kept where every process of the
 * peer reads it.
 */
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOLD_FOR_MS, toldIn } from "../../../lib/mesh/told.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-told-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const telling = {
	teller: "JWZXTR",
	holder: "session-s",
	kind: "change",
	subject: "walgit-rs:docs/ROUNDTRIPS.md",
};
const now = Date.parse("2026-11-01T12:00:00.000Z");

describe("a telling", () => {
	it("is known to another process of the peer within the hour, and not after", () => {
		toldIn(root).note(telling, now);

		const elsewhere = toldIn(root);
		expect(elsewhere.already(telling, now + TOLD_FOR_MS - 1)).toBe(true);
		expect(elsewhere.already(telling, now + TOLD_FOR_MS)).toBe(false);
	});

	it.each([
		["another teller", { teller: "NOX1G3" }],
		["another holder", { holder: "session-j" }],
		["another kind", { kind: "heavy" }],
		["another subject", { subject: "walgit-rs:README.md" }],
	])("is not known for %s", (_, over) => {
		toldIn(root).note(telling, now);

		expect(toldIn(root).already({ ...telling, ...over }, now)).toBe(false);
	});

	it("sweeps tellings past their hour as it notes another", () => {
		const told = toldIn(root);
		told.note(telling, now);
		const [old] = readdirSync(root).filter((name) => name.endsWith(".json"));
		const past = (Date.now() - TOLD_FOR_MS - 1000) / 1000;
		utimesSync(join(root, old ?? ""), past, past);

		told.note({ ...telling, subject: "walgit-rs:README.md" }, Date.now());

		expect(readdirSync(root).filter((name) => name.endsWith(".json"))).toEqual([
			expect.not.stringMatching(old ?? ""),
		]);
	});
});
