/**
 * The start spacing a waiting round reads at each look keeps its last
 * good value while the config can't be read or is gone for a moment,
 * so a file caught half-saved takes no waiting round to the quickest
 * pace, and the round's answer says why a spacing was held.
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configuredSpacing,
	type SpacingRead,
	spacingKeptAcrossFailedReads,
	withSpacingHeld,
} from "../../../../extensions/review-integration/tools/ask-round.ts";
import { COUNCIL_START_SPACING_MS } from "../../../../lib/core/review/ask/start-spacing.ts";

/** A reader answering each of `reads` in turn. */
function readsOf(reads: SpacingRead[]) {
	let at = 0;
	return async () => {
		const read = reads[at] ?? { unread: "no more reads" };
		at += 1;
		return read;
	};
}

const FAILED: SpacingRead = { unread: "Could not parse package config" };
const GONE: SpacingRead = { missing: "/config.json" };

describe("the spacing a waiting round reads", () => {
	it("keeps the last good spacing through a failed read", async () => {
		const spacing = spacingKeptAcrossFailedReads(
			readsOf([{ ms: 180_000 }, FAILED, { ms: 60_000 }]),
		);

		expect(await spacing.read()).toBe(180_000);
		expect(await spacing.read(), "the read failed").toBe(180_000);
		expect(await spacing.read()).toBe(60_000);
	});

	it("takes a spacing taken out of the config as none", async () => {
		const spacing = spacingKeptAcrossFailedReads(
			readsOf([{ ms: 180_000 }, { ms: undefined }]),
		);

		await spacing.read();

		expect(await spacing.read()).toBeUndefined();
	});

	// The config may set a wide spacing for a provider's limit, which a
	// read of none would let the quiet pace pass.
	it("keeps the line's default when its first read fails", async () => {
		const spacing = spacingKeptAcrossFailedReads(
			readsOf([FAILED, { ms: undefined }]),
		);

		expect(await spacing.read()).toBe(COUNCIL_START_SPACING_MS);
		expect(await spacing.read(), "once read").toBeUndefined();
	});

	// A save that renames the old file aside leaves the path empty for a
	// moment, as vim's backupcopy=auto does.
	it("keeps the spacing a config set while the config is gone for a moment", async () => {
		const spacing = spacingKeptAcrossFailedReads(
			readsOf([{ ms: 600_000 }, GONE, { ms: 600_000 }]),
		);

		await spacing.read();

		expect(await spacing.read(), "the file was gone").toBe(600_000);
	});

	it("reads no config at all as none, so a machine without one never waits for it", async () => {
		const spacing = spacingKeptAcrossFailedReads(readsOf([GONE, GONE]));

		expect(await spacing.read()).toBeUndefined();
		expect(await spacing.read(), "still none").toBeUndefined();
		expect(spacing.held(), "nothing held").toBeUndefined();
	});

	it("says why it held a spacing, and only while it holds one", async () => {
		const spacing = spacingKeptAcrossFailedReads(
			readsOf([FAILED, { ms: 600_000 }, GONE, { ms: 600_000 }]),
		);

		await spacing.read();
		expect(spacing.held()).toBe(
			"The config couldn't be read at the last look (Could not parse package config), so the line's default of 3 minutes held.",
		);
		await spacing.read();
		expect(spacing.held(), "read again").toBeUndefined();
		await spacing.read();
		expect(spacing.held()).toBe(
			"The config at /config.json was gone at the last look, so the spacing it last set held.",
		);
		await spacing.read();
		expect(spacing.held(), "back again").toBeUndefined();
	});
});

describe("the spacing this machine's config sets", () => {
	let folder: string;
	let path: string;

	beforeEach(() => {
		folder = mkdtempSync(join(tmpdir(), "spacing-config-"));
		path = join(folder, "config.json");
	});

	afterEach(() => {
		rmSync(folder, { recursive: true, force: true });
	});

	const config = (ask: object) =>
		writeFileSync(path, JSON.stringify({ sections: { review: { ask } } }));

	it("reads the minutes set", async () => {
		config({ startSpacingMinutes: 10 });

		expect(await configuredSpacing(path)).toEqual({ ms: 600_000 });
	});

	it("reads a config without the setting as none", async () => {
		config({ maxReviewers: 4 });

		expect(await configuredSpacing(path)).toEqual({ ms: undefined });
	});

	// Round 2's blocker: a config that can't be read may set a wide
	// spacing, so it never reads as setting none.
	it("reads a config that won't parse as unread, saying why", async () => {
		writeFileSync(path, '{ "sections": { "review": {} }, }');

		const read = await configuredSpacing(path);

		expect(read).toEqual({ unread: expect.stringContaining(path) });
	});

	it("reads minutes that aren't a number as unread, not none", async () => {
		config({ startSpacingMinutes: "10" });

		expect(await configuredSpacing(path)).toEqual({
			unread: `startSpacingMinutes in ${path} is "10", not a number of minutes`,
		});
	});

	it("reads a config gone from its path as missing, not none", async () => {
		config({ startSpacingMinutes: 10 });
		const kept = spacingKeptAcrossFailedReads(() => configuredSpacing(path));
		await kept.read();
		unlinkSync(path);

		expect(await configuredSpacing(path)).toEqual({ missing: path });
		expect(await kept.read(), "the spacing it set holds").toBe(600_000);
	});
});

describe("a start that waited under a held spacing", () => {
	it("says why after what the line said", () => {
		expect(withSpacingHeld({ waited: "It waited." }, "Held.").waited).toBe(
			"It waited. Held.",
		);
		expect(
			withSpacingHeld({ cancelled: "It was stopped." }, "Held.").cancelled,
		).toBe("It was stopped. Held.");
	});

	it("says nothing for a round that started at once", () => {
		expect(withSpacingHeld({}, "Held.")).toEqual({});
	});
});
