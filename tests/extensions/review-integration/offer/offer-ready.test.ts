/**
 * A draft marked ready only once its repo's own ready gate passes its
 * head: 1JQPPC, 27 November, after changes went to readers with no
 * check run at the head they read.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateRun } from "../../../../extensions/review-integration/merge-gate.ts";
import { readyRefusal } from "../../../../extensions/review-integration/tools/offer-ready.ts";
import {
	type BoundTarget,
	clearReviewProviders,
	clearTargetBindings,
	createDraftStore,
	createReviewEngine,
	registerReviewProvider,
} from "../../../../lib/core/review/index.ts";
import { fakeExec } from "../../../support/fake-exec.ts";
import { stubProvider } from "../../../support/stub-provider.ts";

const REPO = "meteorite:shop/world";
const HEAD = "b8210c7420448a5390ca3b2d8bc65c5ceab2af0f";
const PUSHED = "0f3c9a1d7e2b4c6a8d0e1f2a3b4c5d6e7f8a9b0c";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ready-gate-"));
});

afterEach(() => {
	clearReviewProviders();
	clearTargetBindings();
	rmSync(root, { recursive: true, force: true });
});

/** A change whose head reads as `heads` says, one read after another. */
async function changeAt(
	...heads: (string | undefined)[]
): Promise<BoundTarget> {
	let reads = 0;
	registerReviewProvider(
		stubProvider({
			id: "meteorite",
			priority: 50,
			claimRepo: () => ({ key: REPO }),
			facets: {
				changes: {
					fetch: async (ref) => {
						const at = heads[Math.min(reads, heads.length - 1)];
						reads += 1;
						return {
							ref,
							title: "Gate a Ready",
							body: "",
							state: "open",
							draft: true,
							author: { id: "Jitsusama" },
							base: "main",
							head: "jitsusama/ready",
							...(at === undefined ? {} : { headCommit: at }),
							url: "https://example.invalid/9",
						};
					},
					diff: async () => "",
				},
			},
		}),
	);
	const { exec } = fakeExec([]);
	const engine = createReviewEngine({ exec, store: createDraftStore(root) });
	return await engine.bound({
		provider: "meteorite",
		repo: { key: REPO, localPath: root },
		id: "9",
		label: "shop/world#9",
	});
}

/** The change `bound` names, as the offer tool reads it. */
function changeOf(bound: BoundTarget) {
	if (bound.target.kind !== "change") throw new Error("not a change");
	return bound.target.change;
}

/** A review section naming `gate` as the repo's ready gate. */
const readyGate = (gate: unknown) => ({
	review: { ready: { gates: { [REPO]: gate } } },
});

/** A gate runner answering `ran`, keeping each line it was given. */
function runner(ran: Partial<GateRun> = {}) {
	const lines: string[] = [];
	return {
		lines,
		run: async (line: string): Promise<GateRun> => {
			lines.push(line);
			return { code: 0, stdout: "", stderr: "", killed: false, ...ran };
		},
	};
}

describe("marking a draft ready behind its repo's gate", () => {
	it("runs no gate for a repo that names none, even with a merge gate", async () => {
		const bound = await changeAt(HEAD);
		const { lines, run } = runner({ code: 1 });
		const review = { merge: { gates: { [REPO]: "merge-net ready" } } };

		const refused = await readyRefusal(
			{ review, cwd: root, run },
			bound,
			changeOf(bound),
		);

		expect(refused).toBeUndefined();
		expect(lines).toEqual([]);
	});

	it("runs the gate with the head's full sha and lets a pass through", async () => {
		const bound = await changeAt(HEAD);
		const { lines, run } = runner();

		const refused = await readyRefusal(
			{ ...readyGate("bash ready-gate.sh"), cwd: root, run },
			bound,
			changeOf(bound),
		);

		expect(refused).toBeUndefined();
		expect(lines).toEqual([`bash ready-gate.sh '${HEAD}'`]);
	});

	it("leaves a draft refused by its gate, saying what the gate said", async () => {
		const bound = await changeAt(HEAD);
		const { run } = runner({
			code: 1,
			stderr: "ready-gate: no changed-checks run passed at this head",
		});

		const refused = await readyRefusal(
			{ ...readyGate("bash ready-gate.sh"), cwd: root, run },
			bound,
			changeOf(bound),
		);

		expect(refused).toContain(
			`The ready gate \`bash ready-gate.sh\` refused ${HEAD.slice(0, 12)} (exit 1). Left as a draft.`,
		);
		expect(refused).toContain("no changed-checks run passed at this head");
	});

	it("refuses a head that moved while its gate ran, naming both", async () => {
		const bound = await changeAt(HEAD, PUSHED);
		const { run } = runner();

		const refused = await readyRefusal(
			{ ...readyGate("bash ready-gate.sh"), cwd: root, run },
			bound,
			changeOf(bound),
		);

		expect(refused).toContain(HEAD.slice(0, 12));
		expect(refused).toContain(PUSHED.slice(0, 12));
		expect(refused).toContain("Left as a draft");
	});

	it("refuses when the backend reports no head to hold the gate to", async () => {
		const bound = await changeAt(undefined);
		const { lines, run } = runner();

		const refused = await readyRefusal(
			{ ...readyGate("bash ready-gate.sh"), cwd: root, run },
			bound,
			changeOf(bound),
		);

		expect(refused).toContain("doesn't report the head");
		expect(lines).toEqual([]);
	});

	it("refuses a ready gate naming a base, which only a merge reads", async () => {
		const bound = await changeAt(HEAD);
		const { lines, run } = runner();

		const refused = await readyRefusal(
			{
				...readyGate({ command: "bash ready-gate.sh", base: "queued" }),
				cwd: root,
				run,
			},
			bound,
			changeOf(bound),
		);

		expect(refused).toContain(`review.ready.gates["${REPO}"]`);
		expect(refused).toContain('"base"');
		expect(refused).toContain("Left as a draft.");
		expect(lines).toEqual([]);
	});

	it("refuses when the config couldn't be read, rather than running no gate", async () => {
		const bound = await changeAt(HEAD);
		const { run } = runner();

		const refused = await readyRefusal(
			{ unread: "config.json isn't JSON.", cwd: root, run },
			bound,
			changeOf(bound),
		);

		expect(refused).toContain("config.json isn't JSON");
		expect(refused).toContain("names a ready gate can't be known");
	});
});
