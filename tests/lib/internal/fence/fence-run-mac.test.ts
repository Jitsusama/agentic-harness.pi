/**
 * pi-fence's run on a Mac (lib/internal/fence/fence-run.ts): the
 * sandbox-exec profile a fenced command runs under, read as sandbox-exec
 * reads it, the last matching rule deciding. It tries itself first, hides
 * ssh's keys and pi's and mycelium's state whatever is granted, writes
 * only the folder when strict, grants a held broker tree again after
 * every hide, and reads npm's settings only as the copy without tokens.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type FenceRunAsk,
	fenceRunText,
} from "../../../../lib/internal/fence/fence-run.ts";

/** A file rule in a sandbox-exec profile: what it does, to which operations, on which path. */
const RULE =
	/^\((allow|deny) ((?:[a-z-]+\*? )+)\((subpath|literal) "([^"]*)"\)\)$/;

/**
 * The rule that decides `op` on `target` in the profile a Mac's fenced
 * command runs under, as sandbox-exec reads it: the last that matches.
 * None means the profile's `(allow default)`.
 */
function deciding(
	text: string,
	target: string,
	op: "file-read*" | "file-write*" | "file-read-metadata" | "file-write-unlink",
): string | undefined {
	const lines = (text.split("\nexec ")[1] ?? "").split("\n");
	const matching = lines.filter((line) => {
		const [, , ops = "", kind, path = ""] = RULE.exec(line) ?? [];
		// file-read* names every read, file-read-metadata included.
		const names = (each: string) =>
			each === op || (each.endsWith("*") && op.startsWith(each.slice(0, -1)));
		if (!ops.trim().split(" ").some(names)) return false;
		return kind === "literal"
			? target === path
			: target === path || target.startsWith(`${path}/`);
	});
	return matching[matching.length - 1];
}

describe("the fence on a Mac", () => {
	let home: string;
	let folder: string;

	beforeAll(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "fm-")));
		folder = join(home, "work");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		mkdirSync(join(home, ".cache"), { recursive: true });
		mkdirSync(folder, { recursive: true });
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	const onMac = (kind: FenceRunAsk["kind"]) => {
		const made = fenceRunText(
			{ kind, folder, words: ["echo", "it's here"] },
			{
				env: {},
				home,
				platform: "darwin",
				sandboxExec: "/usr/bin/sandbox-exec",
			},
		);
		if (!("text" in made)) throw new Error(JSON.stringify(made));
		return made.text;
	};

	it("tries the profile first and refuses with 126 when it doesn't apply", () => {
		const text = onMac("fence");

		expect(text).toMatch(
			/^unset SSH_AUTH_SOCK\n'\/usr\/bin\/sandbox-exec' -p '\(version 1\)[^']*' \/usr\/bin\/true \|\| \{ [^\n]* exit 126; \}\nexec '\/usr\/bin\/sandbox-exec' -p '\(version 1\)[^']*' \/bin\/bash -c /,
		);
	});

	it("hides ~/.ssh and keeps home's visible entries read-only but the folder's", () => {
		const text = onMac("fence");

		expect(text).toContain(
			`(deny file-read* file-write* (subpath "${join(home, ".ssh")}"))`,
		);
		expect(text).toContain(`(deny file-write* (subpath "${home}"))`);
		expect(text).toContain(
			`(allow file-read* file-write* (subpath "${folder}"))`,
		);
	});

	it("hides the Aquifer cells' provider logins, under either kind", () => {
		const logins = join(
			home,
			".local/state/aquifer-cell/basin-1/aquifer/credentials",
		);
		mkdirSync(logins, { recursive: true });
		const login = join(logins, "basin-1.json");
		writeFileSync(login, "{}");

		for (const kind of ["fence", "strict"] as const) {
			expect(deciding(onMac(kind), login, "file-read*"), kind).toMatch(
				/^\(deny /,
			);
		}
	});

	it("sends no Apple Event, and points caches where the fence lets them write", () => {
		const text = onMac("fence");

		// The command is quoted again inside bash -c, and its quotes with it.
		const within = (words: string) => words.replaceAll("'", "'\\''");

		expect(text).toContain("(deny appleevent-send)");
		expect(text).toContain(
			within(
				`[ -n "\${XDG_CACHE_HOME:-}" ] || export XDG_CACHE_HOME='${join(home, ".cache")}'`,
			),
		);
		expect(text).toContain(
			within(
				`[ -n "\${GOCACHE:-}" ] || export GOCACHE='${join(home, ".cache", "go-build")}'`,
			),
		);
		expect(text).toContain(
			`(allow file-read* file-write* (subpath "${join(home, ".cache")}"))`,
		);
	});

	it("leaves caches be where strict keeps them read-only, or ~/.cache isn't there, and execs the command", () => {
		const within = (words: string) => words.replaceAll("'", "'\\''");
		const bare = realpathSync(mkdtempSync(join(tmpdir(), "fm-bare-")));
		mkdirSync(join(bare, "work"));
		try {
			const made = fenceRunText(
				{ kind: "fence", folder: join(bare, "work"), words: ["true"] },
				{
					env: {},
					home: bare,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
				},
			);
			expect(JSON.stringify(made)).not.toContain("XDG_CACHE_HOME");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}

		expect(onMac("strict")).not.toContain("XDG_CACHE_HOME");
		expect(onMac("fence")).toContain(within("; exec 'echo' "));
	});

	it("reads npm's settings only as the copy without tokens, and empties Docker's logins", () => {
		const own = realpathSync(mkdtempSync(join(tmpdir(), "fm-own-")));
		const work = join(own, "work");
		mkdirSync(work);
		mkdirSync(join(own, ".docker"));
		writeFileSync(
			join(own, ".npmrc"),
			"//npm.example/:_authToken=not-a-token\n",
		);
		writeFileSync(
			join(own, ".docker", "config.json"),
			JSON.stringify({ auths: { "ghcr.io": { auth: "bm90LWEtbG9naW4=" } } }),
		);
		const temporary = join(own, "tmp");
		mkdirSync(temporary);
		try {
			const made = fenceRunText(
				{ kind: "fence", folder: work, words: ["npm", "ping"] },
				{
					env: { TMPDIR: temporary },
					home: own,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
				},
			);
			if (!("text" in made)) throw new Error(JSON.stringify(made));
			const copy = /export NPM_CONFIG_USERCONFIG='\\''([^']+)'\\''/.exec(
				made.text,
			)?.[1];
			expect(copy, "npm is pointed at a copy").toBeDefined();
			expect(readFileSync(copy ?? "", "utf8")).not.toContain("not-a-token");
			expect(made.text).toContain(
				`(deny file-write* (subpath "${dirname(copy ?? "")}"))`,
			);
			for (const hidden of [".npmrc", ".docker/config.json"]) {
				expect(made.text).toContain(
					`(deny file-read* file-write* (literal "${join(own, hidden)}"))`,
				);
			}
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	it("writes npm's copy over a link put in its place, never through it", () => {
		const own = realpathSync(mkdtempSync(join(tmpdir(), "fm-link-")));
		const work = join(own, "work");
		const temporary = join(own, "tmp");
		const victim = join(own, "victim");
		mkdirSync(work);
		mkdirSync(join(temporary, "pi-fence"), { recursive: true });
		writeFileSync(
			join(own, ".npmrc"),
			"//npm.example/:_authToken=not-a-token\n",
		);
		writeFileSync(victim, "the person's own\n");
		symlinkSync(victim, join(temporary, "pi-fence", "npmrc"));
		try {
			const made = fenceRunText(
				{ kind: "fence", folder: work, words: ["true"] },
				{
					env: { TMPDIR: temporary },
					home: own,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
				},
			);
			const replaced = lstatSync(join(temporary, "pi-fence", "npmrc"));

			expect(made).toHaveProperty("text");
			expect(readFileSync(victim, "utf8")).toBe("the person's own\n");
			expect(replaced.isSymbolicLink(), "the link is replaced").toBe(false);
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	it("hides npm's settings, pointing at nothing, where pi's folder is a link", () => {
		const own = realpathSync(mkdtempSync(join(tmpdir(), "fm-linked-")));
		const work = join(own, "work");
		const temporary = join(own, "tmp");
		mkdirSync(work);
		mkdirSync(temporary);
		mkdirSync(join(own, "elsewhere"));
		writeFileSync(
			join(own, ".npmrc"),
			"//npm.example/:_authToken=not-a-token\n",
		);
		symlinkSync(join(own, "elsewhere"), join(temporary, "pi-fence"));
		try {
			const made = fenceRunText(
				{ kind: "fence", folder: work, words: ["true"] },
				{
					env: { TMPDIR: temporary },
					home: own,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
				},
			);
			if (!("text" in made)) throw new Error(JSON.stringify(made));

			expect(made.text).not.toContain("NPM_CONFIG_USERCONFIG");
			expect(made.text).toContain(
				`(deny file-read* file-write* (literal "${join(own, ".npmrc")}"))`,
			);
			expect(
				existsSync(join(own, "elsewhere", "npmrc")),
				"nothing written there",
			).toBe(false);
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	it("reads no ssh key, whatever kind and grants", () => {
		for (const kind of ["fence", "strict"] as const) {
			expect(
				deciding(onMac(kind), join(home, ".ssh", "id_ed25519"), "file-read*"),
				kind,
			).toMatch(/^\(deny /);
		}
	});

	it("writes only its folder when strict, so nothing it plants runs later", () => {
		const text = onMac("strict");
		for (const planted of [
			".lldbinit",
			".zsh_history",
			".local/state/mycelium/x",
		]) {
			expect(
				deciding(text, join(home, planted), "file-write*"),
				planted,
			).toMatch(/^\(deny /);
		}
		expect(deciding(text, join(folder, "out"), "file-write*")).toMatch(
			/^\(allow /,
		);
	});

	it("reads nothing of pi's or mycelium's state, so no realm's messages reach the asker", () => {
		for (const kind of ["fence", "strict"] as const) {
			for (const state of [
				".pi/agent/sessions/one/session.jsonl",
				".local/state/pi/agentic-harness.pi/mesh/messages/m.json",
				".local/state/mycelium/work.json",
			]) {
				expect(
					deciding(onMac(kind), join(home, state), "file-read*"),
					`${kind} ${state}`,
				).toMatch(/^\(deny /);
			}
		}
	});

	it("reads and writes a tree the work broker cut, though pi's state is hidden", () => {
		const trees = join(home, ".local/state/pi/agentic-harness.pi/work/trees");
		const tree = join(trees, "worktree-one");
		// A worktree of a repository beside the home, as the broker cuts one.
		const own = join(home, "src", "repo", ".git", "worktrees", "one");
		mkdirSync(join(home, "src", "repo", ".git", "objects"), {
			recursive: true,
		});
		mkdirSync(own, { recursive: true });
		mkdirSync(join(tree, "src"), { recursive: true });
		writeFileSync(join(tree, ".git"), `gitdir: ${own}\n`);
		writeFileSync(join(own, "gitdir"), `${join(tree, ".git")}\n`);
		// A hidden folder the fence's own list names, and a program's folder.
		mkdirSync(join(home, ".local/share/keyrings"), { recursive: true });
		mkdirSync(join(home, ".bun/bin"), { recursive: true });
		// pi's agent folder, as a Mac has it, so ~/.pi is bound writable.
		mkdirSync(join(home, ".pi/agent/sessions"), { recursive: true });
		for (const kind of ["fence", "strict"] as const) {
			const made = fenceRunText(
				{ kind, folder: join(tree, "src"), words: ["true"] },
				{
					env: { PATH: join(home, ".bun/bin") },
					home,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
					treesRoot: trees,
					heldTrees: [tree],
				},
			);
			if (!("text" in made)) throw new Error(JSON.stringify(made));
			for (const op of ["file-read*", "file-write*"] as const) {
				expect(
					deciding(made.text, join(tree, "src", "file"), op),
					`${kind} ${op}`,
				).toMatch(/^\(allow /);
			}
			expect(
				deciding(made.text, join(tree, "README.md"), "file-read*"),
				`${kind}: reads the whole tree, not just its subfolder`,
			).toMatch(/^\(allow /);
			expect(
				deciding(made.text, join(tree, "README.md"), "file-write*"),
				kind === "fence"
					? "fence writes the whole tree, as on Linux"
					: "strict writes only its folder, not the tree's root",
			).toMatch(kind === "fence" ? /^\(allow / : /^\(deny /);
			// Strict keeps the whole home from writes, so only fence's
			// writable home needs the rule, and shows it.
			for (const above of kind === "fence"
				? [
						join(home, ".local"),
						join(home, ".local/state"),
						join(home, ".pi"),
						join(home, ".local/share"),
						join(home, ".bun"),
					]
				: []) {
				expect(
					deciding(made.text, above, "file-write-unlink"),
					`${kind}: ${above} can't be moved aside, taking what's hidden in it`,
				).toMatch(/^\(deny file-write-unlink /);
			}
			expect(
				deciding(made.text, join(tree, ".git"), "file-write*"),
				`${kind}: the tree's .git stays read-only`,
			).toMatch(/^\(deny /);
			expect(
				deciding(made.text, trees, "file-read-metadata"),
				`${kind}: the way down to it`,
			).toMatch(/^\(allow /);
			for (const [what, path, op] of [
				["pi's state beside it", join(home, ".local/state/pi/x"), "file-read*"],
				["pi's state listed", join(home, ".local/state/pi"), "file-read*"],
				["the trees listed", trees, "file-read*"],
				[
					"a sibling tree's stat",
					join(trees, "worktree-two"),
					"file-read-metadata",
				],
				[
					"a session log",
					join(home, ".pi/agent/sessions/one/session.jsonl"),
					"file-read*",
				],
				[
					"a mesh message",
					join(home, ".local/state/pi/agentic-harness.pi/mesh/messages/m.json"),
					"file-read*",
				],
			] as const) {
				expect(deciding(made.text, path, op), `${kind}: ${what}`).toMatch(
					/^\(deny /,
				);
			}
		}
	});
});
