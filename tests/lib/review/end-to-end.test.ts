/**
 * The review substrate against a real git repo.
 *
 * Every other test here uses a fake exec, which proves each piece
 * sends the argv it means to and nothing about whether the pieces
 * compose. This one makes real commits and reads them back through
 * the engine, the git provider, the diff model and a draft, because
 * that sequence is the whole point of the substrate and the fake
 * cannot tell whether git agrees.
 *
 * The equivalent test in `lib/work` found a real bug the first time it
 * ran, which is the reason this one exists.
 *
 * One test rather than six, using the shared fixture, so it costs a
 * handful of subprocesses and no repo construction.
 */

import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	addFinding,
	clearReviewProviders,
	compilePlan,
	createDraftStore,
	createGitProvider,
	createReviewEngine,
	type Exec,
	emptyDraft,
	filePath,
	registerReviewProvider,
	renderDraft,
	setVerdict,
} from "../../../lib/review/index.js";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.js";

/** Real exec, since the point is that git actually agrees. */
const exec: Exec = async (command, args) => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	try {
		const { stdout, stderr } = await promisify(execFile)(command, [...args]);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const e = error as { code?: number; stdout?: string; stderr?: string };
		return {
			code: e.code ?? 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
		};
	}
};

describe("reviewing a real range", () => {
	let repo: string;
	let drafts: string;

	beforeAll(async () => {
		repo = await freshRepo("review-e2e");
		drafts = await mkdtemp(join(tmpdir(), "review-e2e-drafts-"));

		// A base commit and a change on top of it, so there is a real
		// range with real hunks to anchor into.
		writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
		await git(repo, "add", "app.ts");
		await git(repo, "commit", "-m", "add app");
		await git(repo, "branch", "base");

		writeFileSync(
			join(repo, "app.ts"),
			"export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
		);
		await git(repo, "add", "app.ts");
		await git(repo, "commit", "-m", "add more");
	});

	afterAll(() => {
		disposeRepo(repo);
		rmSync(drafts, { recursive: true, force: true });
		clearReviewProviders();
	});

	it("binds a local range, reads its diff, and composes a review of it", async () => {
		clearReviewProviders();
		registerReviewProvider(createGitProvider({ exec }));
		const engine = createReviewEngine({
			exec,
			store: createDraftStore(drafts),
		});

		// Binding a range nobody has proposed. This is the case the
		// substrate exists to make ordinary, and the one a forge-shaped
		// design cannot express at all.
		const bound = await engine.fromLocal(repo, {
			base: "base",
			head: "HEAD",
		});
		expect(bound.provider.id).toBe("git");

		// The diff has to come back with the lines git actually wrote,
		// not a shape a fake agreed to.
		const model = await bound.diffModel();
		// filePath rather than a field: a DiffFile carries oldPath and
		// newPath, since a rename has both and a delete has only one.
		const file = model.files.find((one) => filePath(one).endsWith("app.ts"));
		expect(file, "app.ts should be in the diff").toBeTruthy();
		const added = (file?.hunks ?? []).flatMap((hunk) =>
			hunk.lines.filter((line) => line.kind === "added"),
		);
		expect(added.map((line) => line.text.trim())).toEqual([
			"export const b = 2;",
			"export const c = 3;",
		]);

		// An anchor onto a line the diff really carries.
		const line = added[0]?.newLine;
		expect(line, "an added line should carry its new number").toBeTruthy();

		let draft = emptyDraft("e2e", bound.target);
		draft = addFinding(draft, {
			anchor: {
				subject: "line",
				path: file === undefined ? "app.ts" : filePath(file),
				blob: "new",
				line: line ?? 2,
			},
			body: "b and c want a reason",
		});
		draft = setVerdict(draft, "comment", "one remark");

		// A range nobody hosts cannot be published, and the plan has to
		// say so rather than failing at send time. This is the whole
		// bargain: degradation announced up front is a decision.
		const plan = compilePlan(draft, { capabilities: bound.capabilities });
		expect(plan.ops).toEqual([]);

		// But it can be written up, which is what makes the local case
		// useful rather than merely permitted.
		const document = renderDraft(draft);
		expect(document.markdown).toContain("b and c want a reason");
		expect(document.markdown).toContain("app.ts");
	});
});
