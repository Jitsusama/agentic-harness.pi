/**
 * The batching trial: half an orchestration's builders are told to
 * send independent looks together, and a session whose work slips
 * comes out at once.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BATCHING_LINE,
	batchingTrial,
	inTrialHalf,
	type TrialPlan,
} from "../../../extensions/quest-workflow/batching-trial.ts";

const MISSION = "QEST-20260101-MISSON";
const BUILDER = "QEST-20260101-BUILDR";
const SWITCHER = "QEST-20260101-SWITCH";
const LONER = "QEST-20260101-LONERQ";

/** A session id whose second-to-last hex digit is odd: in the half. */
const IN = "01a1b8be-44ff-77aa-be03-5ca923cefb70";
/** One whose second-to-last hex digit is even: the other half. */
const OUT = "01a1b8be-44ff-77aa-be03-5ca923cefb80";

const PLAN: TrialPlan = {
	orchestration: MISSION,
	except: [MISSION, SWITCHER],
	until: "2026-11-16",
};

let root: string;

function quest(id: string, parent: string | null, marked = false) {
	mkdirSync(join(root, "quests", id), { recursive: true });
	writeFileSync(
		join(root, "quests", id, "README.md"),
		`---\nid: ${id}\nkind: ${parent ? "subquest" : "quest"}\nparent: ${parent ?? "null"}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-11-01\nupdated: 2026-11-01\n${marked ? "orchestrator: true\n" : ""}---\n\n# ${id}\n`,
	);
}

function trial(
	session: string,
	over: { now?: string; env?: Record<string, string> } = {},
) {
	return batchingTrial(
		{
			questsRoot: () => join(root, "quests"),
			out: join(root, "batching-out"),
			session: () => session,
			now: () => Date.parse(over.now ?? "2026-11-14T15:00:00Z"),
			zone: "America/Toronto",
			env: over.env ?? {},
		},
		PLAN,
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "batching-"));
	quest(MISSION, null, true);
	quest(BUILDER, MISSION);
	quest(SWITCHER, MISSION);
	quest(LONER, null);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the batching trial", () => {
	it("splits sessions by the second-to-last digit of their id", () => {
		expect(
			[inTrialHalf(IN), inTrialHalf(OUT), inTrialHalf(`2026-11-08_${IN}.jsonl`)],
			"odd in, even out, a log's name read as its id",
		).toEqual([true, false, true]);
	});

	it("tells a builder in the half, and nobody else", () => {
		expect(
			[
				trial(IN)(BUILDER),
				trial(OUT)(BUILDER),
				trial(IN)(MISSION),
				trial(IN)(SWITCHER),
				trial(IN)(LONER),
				trial(IN)(null),
			],
			"only the builder in the half hears it",
		).toEqual([BATCHING_LINE, null, null, null, null, null]);
	});

	it("takes a session out at once when its quest is listed out", () => {
		const read = trial(IN);
		const before = read(BUILDER);
		writeFileSync(join(root, "batching-out"), `${LONER}\n${BUILDER}\n`);
		expect([before, read(BUILDER)], "said, then not").toEqual([
			BATCHING_LINE,
			null,
		]);
	});

	it("ends after its last day, or when turned off", () => {
		expect(
			[
				trial(IN, { now: "2026-11-17T04:59:00Z" })(BUILDER),
				trial(IN, { now: "2026-11-17T05:00:00Z" })(BUILDER),
				trial(IN, { env: { PI_BATCHING_TRIAL: "off" } })(BUILDER),
			],
			"its last day in Toronto, the day after, and off",
		).toEqual([BATCHING_LINE, null, null]);
	});
});
