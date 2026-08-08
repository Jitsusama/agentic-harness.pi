/**
 * A round can read through a lens the repo under review already had.
 *
 * The parsing half is covered where the files are parsed. This is the
 * other half, and the one that keeps being missing: the seam between
 * what is on disk and what a participant is actually handed. Four PRs
 * in a row shipped a tested helper beside an unproven call site, and
 * the call site is where the bugs were, so the composition was moved
 * out of the tool file specifically so it could be driven here.
 *
 * Every case goes through `chartersFor`, which is what the rounds
 * call, rather than through the discovery it wraps.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chartersFor } from "../../extensions/review-integration/lenses.js";
import type { ReadableTree } from "../../extensions/review-integration/work.js";
import type { Roster } from "../../lib/review/index.js";

/** A repo with the agent files named, and a persona dir beside it. */
async function repoWith(
	files: Record<string, string>,
	personas: Record<string, string> = {},
): Promise<{ tree: ReadableTree; personaDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "lens-"));
	const path = join(root, "tree");
	const personaDir = join(root, "personas");
	await mkdir(personaDir, { recursive: true });

	for (const [at, text] of Object.entries(files)) {
		const full = join(path, at);
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, text);
	}
	for (const [name, text] of Object.entries(personas)) {
		await writeFile(join(personaDir, name), text);
	}
	await mkdir(path, { recursive: true });

	// The tree itself, which is what the rounds hand over: the parameter
	// takes no bare path, so a lens cannot be fetched from anywhere but
	// where the round reads.
	return { tree: { path }, personaDir };
}

/** A charter file the way both kinds are written. */
function lens(name: string, body: string): string {
	return `---\nname: ${name}\ndescription: A lens\n---\n\n${body}\n`;
}

const ROSTER = (persona: string): Roster => ({
	reviewers: [{ id: "hawk", persona }],
});

describe("a lens the repo under review defined", () => {
	it("reaches the participant that asked for it", async () => {
		const { tree, personaDir } = await repoWith({
			".claude/agents/code-reviewer.md": lens(
				"code-reviewer",
				"Read this Rust for token efficiency.",
			),
		});

		const charters = await chartersFor(
			ROSTER("repo:code-reviewer"),
			personaDir,
			tree,
		);

		expect(charters.get("hawk")).toBe("Read this Rust for token efficiency.");
	});

	it("comes from the tree the round reads, not the session's own", async () => {
		// The failure this guards is the expensive one. Three councils
		// read the session's repo rather than the change's and returned
		// 225 findings about code the change does not contain, at $75.63.
		// A lens taken from the wrong tree is the same mistake wearing a
		// smaller hat: the round would run under a lens written for a
		// codebase nobody is reviewing.
		const change = await repoWith({
			"agents/owl.md": lens("owl", "The lens the change's repo wrote."),
		});
		const session = await repoWith({
			"agents/owl.md": lens("owl", "The lens the session's repo wrote."),
		});

		const charters = await chartersFor(
			ROSTER("repo:owl"),
			session.personaDir,
			change.tree,
		);

		expect(charters.get("hawk")).toBe("The lens the change's repo wrote.");
	});

	it("cannot quietly stand in for a persona of the same name", async () => {
		// Namespaced ids mean asking for your own lens and asking for the
		// repo's are different requests. Without that, a repo could
		// substitute itself for a lens somebody trusts, and the findings
		// would still file under the name they asked for.
		const { tree, personaDir } = await repoWith(
			{ "agents/architect.md": lens("architect", "The repo's architect.") },
			{ "architect.md": lens("architect", "My own architect.") },
		);

		const mine = await chartersFor(ROSTER("architect"), personaDir, tree);
		const theirs = await chartersFor(
			ROSTER("repo:architect"),
			personaDir,
			tree,
		);

		expect(mine.get("hawk")).toBe("My own architect.");
		expect(theirs.get("hawk")).toBe("The repo's architect.");
	});

	it("refuses a round whose lens the repo does not have", async () => {
		// The same refusal a missing persona gets, and for the same
		// reason: a reviewer running without the lens it was asked for
		// files generic findings under a specialist's name. A repo lens
		// makes this likelier, since the roster is global and the lens is
		// not, so the refusal has to name what went wrong.
		const { tree, personaDir } = await repoWith({});

		await expect(
			chartersFor(ROSTER("repo:nobody"), personaDir, tree),
		).rejects.toThrow(/repo:nobody/);
	});

	it("keeps going past an agent file it cannot read", async () => {
		// Nobody here asked for these files, so one malformed agent in a
		// repo this operator does not maintain must not refuse every
		// round run against it. A persona is the opposite case and still
		// throws: that one somebody named in their own config.
		const { tree, personaDir } = await repoWith({
			".claude/agents/broken.md": "no frontmatter at all",
			".claude/agents/architect.md": lens("architect", "Still readable."),
		});

		const charters = await chartersFor(
			ROSTER("repo:architect"),
			personaDir,
			tree,
		);

		expect(charters.get("hawk")).toBe("Still readable.");
	});
});
