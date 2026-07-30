/**
 * A diff a backend will not answer for is still readable.
 *
 * A big change is the one a diff is most wanted for, and it was the one
 * that failed hardest: a backend capping its own diff route answered with a
 * raw upstream refusal, and the read was simply over. Meanwhile the same
 * provider offered `fetchAsRef`, which exists for exactly this, and nothing
 * reached for it. Measured on a real change of 222 files and 47,586 lines:
 * `HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)`.
 *
 * Bringing the commits down and diffing them locally has no such cap. What
 * these pin is that the fallback is taken, that it diffs against the base
 * the provider names rather than a guessed default branch, and that the
 * original refusal survives into whatever is said afterwards. That last one
 * matters most: a fallback fails for its own reasons, and hearing only the
 * second reason sends somebody after the wrong problem.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearReviewProviders,
	clearTargetBindings,
	createDraftStore,
	createReviewEngine,
	registerReviewProvider,
} from "../../../lib/review/index.js";
import { fakeExec, type Reply } from "./support/fake-exec.js";
import { stubProvider } from "./support/stub-provider.js";

const REPO = { key: "capped:o/r", localPath: "/src/app" };
const CAP =
	"HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "diff-fallback-"));
});

afterEach(async () => {
	clearReviewProviders();
	clearTargetBindings();
	await rm(root, { recursive: true, force: true });
});

/** A provider whose diff route refuses the way a capped backend does. */
function capped(options: { fetchAsRef?: false; base?: string } = {}) {
	const asked: string[] = [];
	const proposals = {
		async fetch(ref: { id: string }) {
			return {
				ref: {
					provider: "capped",
					repo: REPO,
					id: ref.id,
					label: `o/r#${ref.id}`,
				},
				title: "a big change",
				body: "",
				state: "open" as const,
				draft: false,
				author: { name: "someone" },
				base: options.base ?? "main",
				head: "feature",
			};
		},
		async diff() {
			throw new Error(CAP);
		},
		...(options.fetchAsRef === false
			? {}
			: {
					async fetchAsRef(ref: { id: string }, repoRoot: string) {
						asked.push(`fetched ${ref.id} into ${repoRoot}`);
						return `refs/pi-review/capped/${ref.id}`;
					},
				}),
	};

	return {
		asked,
		provider: stubProvider({
			id: "capped",
			priority: 1,
			claimReference: (input) => ({
				provider: "capped",
				repo: REPO,
				id: input,
				label: `o/r#${input}`,
			}),
			facets: { proposals: proposals as never },
		}),
	};
}

/** An engine over one provider, with git answering as the replies say. */
function engineOver(
	provider: ReturnType<typeof capped>["provider"],
	replies: Reply[],
) {
	const { exec, calls } = fakeExec(replies);
	registerReviewProvider(provider);
	return {
		calls,
		engine: createReviewEngine({ exec, store: createDraftStore(root) }),
	};
}

describe("a diff the provider's own route refuses", () => {
	it("is read from a fetched ref rather than given up on", async () => {
		const { provider, asked } = capped();
		const { engine } = engineOver(provider, [
			{ when: ["diff"], stdout: "diff --git a/big.ts b/big.ts\n" },
		]);

		const bound = await engine.resolve("418", "/src/app");
		const diff = await bound.diff();

		expect(diff).toContain("diff --git");
		expect(asked).toEqual(["fetched 418 into /src/app"]);
	});

	it("diffs against the base the provider names, not a guessed default", async () => {
		// A repo whose trunk is not called main is the ordinary case in a
		// monorepo, and guessing it wrong reads as an empty change.
		const { provider } = capped({ base: "release/24" });
		const { engine, calls } = engineOver(provider, [
			{ when: ["diff"], stdout: "" },
		]);

		const bound = await engine.resolve("418", "/src/app");
		await bound.diff();

		const diffed = calls.find((call) => call.args.includes("diff"));
		expect(diffed?.args.join(" ")).toContain(
			"release/24...refs/pi-review/capped/418",
		);
	});

	it("keeps the original refusal when there is no way around it", async () => {
		const { provider } = capped({ fetchAsRef: false });
		const { engine } = engineOver(provider, []);

		const bound = await engine.resolve("418", "/src/app");

		await expect(bound.diff()).rejects.toThrow(/exceeded the maximum/);
		await expect(bound.diff()).rejects.toThrow(
			/cannot fetch a change as a ref/,
		);
	});

	it("names both causes when the fallback fails on its own terms", async () => {
		// The usual one is a checkout that has never seen the base.
		const { provider } = capped();
		const { engine } = engineOver(provider, [
			{
				when: ["diff"],
				code: 128,
				stderr: "fatal: ambiguous argument 'main...refs/pi-review/capped/418'",
			},
		]);

		const bound = await engine.resolve("418", "/src/app");

		await expect(bound.diff()).rejects.toThrow(/exceeded the maximum/);
		await expect(bound.diff()).rejects.toThrow(/ambiguous argument/);
	});
});
