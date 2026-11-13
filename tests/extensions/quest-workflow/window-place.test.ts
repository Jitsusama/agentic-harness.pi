/**
 * Where a quest's session window goes: beside its orchestrator's, which
 * stays first, or for an orchestrator beside the sessions it leads.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handedPlaceFor,
	windowPlaceFor,
} from "../../../extensions/quest-workflow/window-place.ts";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../lib/internal/quest/discovery.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";

const LEAD = "QEST-20260101-LEADER";
const WORK = "QEST-20260101-WORKER";
const ALONE = "QEST-20260101-ALONEQ";

let root: string;

function quest(id: string, fields: Record<string, string | boolean>): void {
	const lines = Object.entries(fields).map(
		([key, value]) => `${key}: ${value}`,
	);
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(
		join(root, id, "README.md"),
		`---\nid: ${id}\nkind: quest\nstatus: active\nrank: 1\npriority: active\nstarted: 2026-01-01\nupdated: 2026-01-01\n${lines.join("\n")}\n---\n\n# ${id}\n`,
	);
}

function presence(
	session: string,
	title: string,
	fields: Partial<Presence> = {},
): Presence {
	return {
		session,
		addresses: [],
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: "2026-01-01T00:00:00Z",
		title,
		...fields,
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "window-place-"));
	clearDiscoveryCache();
	quest(LEAD, { orchestrator: true, short: "Lead" });
	quest(WORK, { parent: LEAD, short: "Work" });
	quest(ALONE, { short: "Alone" });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

const lead = presence("s-lead", "π - Lead - core.nix", {
	addresses: ["LEADER"],
	orchestrates: "LEADER",
});
const worker = presence("s-work", "π - Work - old", {
	addresses: ["WORKER"],
	orchestratedBy: "LEADER",
});

describe("a session's window", () => {
	it("goes beside its orchestrator's, which stays first, then its own last one", () => {
		const { index } = discoverQuests(root);

		expect(
			windowPlaceFor(WORK, "/src/core.nix", index, [lead, worker], "s-work"),
		).toEqual({
			beside: ["π - Lead - core.nix", "π - Work - old"],
			first: "π - Lead - core.nix",
			title: "π - Work - core.nix",
		});
	});

	it("goes beside the sessions it leads, first among them, for an orchestrator", () => {
		const { index } = discoverQuests(root);

		expect(
			windowPlaceFor(LEAD, "/src/core.nix", index, [lead, worker], "s-lead"),
		).toEqual({
			beside: ["π - Work - old", "π - Lead - core.nix"],
			first: "π - Lead - core.nix",
			title: "π - Lead - core.nix",
		});
	});

	it("goes beside only its own last window when nothing orchestrates it", () => {
		const { index } = discoverQuests(root);
		const alone = presence("s-alone", "π - Alone - x");

		expect(
			windowPlaceFor(ALONE, "/src/x", index, [lead, alone], "s-alone"),
		).toEqual({ beside: ["π - Alone - x"], title: "π - Alone - x" });
	});
});

describe("what the launcher is told to place a window by", () => {
	it("is the orchestrator its presence will say and its session's name", () => {
		const { index } = discoverQuests(root);

		expect({
			worker: handedPlaceFor(WORK, index),
			lead: handedPlaceFor(LEAD, index),
			alone: handedPlaceFor(ALONE, index),
			unknown: handedPlaceFor("QEST-20260101-NOSUCH", index),
		}).toEqual({
			worker: { orchestratedBy: "LEADER", workspace: "LEADER", title: "Work" },
			lead: { workspace: "LEADER", title: "Lead" },
			alone: { workspace: "ALONEQ", title: "Alone" },
			unknown: {},
		});
	});
});
