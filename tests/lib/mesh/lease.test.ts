import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	carryLeases,
	changeSubject,
	createBoard,
	heavyWorkIn,
	holdingFrom,
	type Lease,
	leaseEventFrom,
	othersOn,
	ownLeases,
	RUN_KINDS,
} from "../../../lib/mesh/lease.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-lease-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const at = Date.parse("2026-10-22T05:00:00Z");
const minutes = (count: number) => count * 60 * 1000;

function lease(over: Partial<Lease> = {}): Lease {
	return {
		kind: "change",
		subject: "widget:src/a.ts",
		since: new Date(at).toISOString(),
		until: new Date(at + minutes(10)).toISOString(),
		...over,
	};
}

describe("the board", () => {
	it("keeps each peer's leases in a file of its own, gone when it holds none", () => {
		const board = createBoard(join(root, "leases"));

		board.hold({ session: "one", leases: [lease()] });
		board.hold({ session: "two/x", leases: [lease({ kind: "hold" })] });

		expect(board.of("one")?.leases).toEqual([lease()]);
		expect(board.all().map(({ session }) => session)).toEqual(["one", "two/x"]);
		board.hold({ session: "one", leases: [] });
		expect(existsSync(join(root, "leases", "one.json"))).toBe(false);
		expect(board.all().map(({ session }) => session)).toEqual(["two/x"]);
	});

	it("carries a peer's leases to the session it carries on in", () => {
		const board = createBoard(join(root, "leases"));
		const held = lease({ kind: "hold", subject: "1-a" });
		const waited = lease({ kind: "wait", subject: "2-b" });
		board.hold({ session: "old", leases: [held] });
		board.hold({ session: "new", leases: [waited] });

		carryLeases(board, "old", "new");

		expect(board.of("new")?.leases).toEqual([waited, held]);
		expect(board.of("old")).toBeUndefined();
		carryLeases(board, "new", "new");
		expect(board.of("new")?.leases).toEqual([waited, held]);
	});

	it("reads as empty before any peer has written to it", () => {
		expect(createBoard(join(root, "nowhere")).all()).toEqual([]);
	});
});

describe("a holding as read", () => {
	it("keeps only the leases that read", () => {
		expect(
			holdingFrom({
				session: "one",
				leases: [
					lease({ why: "a test" }),
					{ ...lease(), kind: "lock" },
					{ ...lease(), until: 5 },
					"x",
				],
			}),
		).toEqual({ session: "one", leases: [lease({ why: "a test" })] });
	});

	it("keeps the peer a hand claimed it for", () => {
		expect(
			holdingFrom({ session: "me.hand.1", leases: [], handOf: "me" }),
		).toEqual({ session: "me.hand.1", leases: [], handOf: "me" });
		expect(
			holdingFrom({ session: "me.hand.1", leases: [], handOf: "" }),
		).toEqual({ session: "me.hand.1", leases: [] });
	});

	it("is nothing without a session and its leases", () => {
		expect(holdingFrom({ leases: [] })).toBeUndefined();
		expect(holdingFrom({ session: "one" })).toBeUndefined();
		expect(holdingFrom(null)).toBeUndefined();
	});
});

describe("others on a subject", () => {
	it("are the other peers' current leases of that kind on it", () => {
		const board = [
			{ session: "me", leases: [lease()] },
			{
				session: "them",
				leases: [
					lease(),
					lease({ kind: "answer" }),
					lease({ subject: "widget:src/b.ts" }),
				],
			},
			{
				session: "lapsed",
				leases: [lease({ until: new Date(at - 1).toISOString() })],
			},
		];

		expect(othersOn(board, "me", "change", "widget:src/a.ts", at)).toEqual([
			{ session: "them", lease: lease() },
		]);
	});

	it("count a hand's leases as its peer's, and never a peer's own hands or the peer a hand works for", () => {
		const board = [
			{ session: "me", leases: [lease()] },
			{ session: "me.hand.1", handOf: "me", leases: [lease()] },
			{ session: "them.hand.2", handOf: "them", leases: [lease()] },
		];

		expect(othersOn(board, "me", "change", "widget:src/a.ts", at)).toEqual([
			{ session: "them", lease: lease() },
		]);
		// A hand leases as its peer, so neither its peer nor itself is other.
		expect(othersOn(board, "them", "change", "widget:src/a.ts", at)).toEqual([
			{ session: "me", lease: lease() },
			{ session: "me", lease: lease() },
		]);
	});
});

describe("a change's subject", () => {
	it("is alike in two worktrees of one repository", () => {
		const main = join(root, "main");
		mkdirSync(join(main, ".git", "worktrees", "other"), { recursive: true });
		writeFileSync(
			join(main, ".git", "config"),
			'[remote "origin"]\n\turl = git@github.com:someone/widget.git\n',
		);
		writeFileSync(
			join(main, ".git", "worktrees", "other", "commondir"),
			"../..\n",
		);
		const other = join(root, "other");
		mkdirSync(join(other, "src"), { recursive: true });
		writeFileSync(
			join(other, ".git"),
			`gitdir: ${join(main, ".git", "worktrees", "other")}\n`,
		);
		mkdirSync(join(main, "src"), { recursive: true });

		const here = changeSubject("src/a.ts", main);
		const there = changeSubject(join(other, "src", "a.ts"), root);

		expect(here).toMatch(/widget:src\/a\.ts$/);
		expect(there).toBe(here);
	});

	it("is the absolute path outside any checkout", () => {
		expect(changeSubject("notes.md", root)).toBe(join(root, "notes.md"));
	});
});

describe("a peer's own leases", () => {
	it("keep what outlives a run, and drop what a run took or what lapsed", () => {
		const board = createBoard(join(root, "leases"));
		board.hold({
			session: "me",
			leases: [
				lease({ kind: "hold", subject: "kept" }),
				lease({ kind: "change" }),
				lease({ kind: "answer", subject: "asked" }),
				lease({
					kind: "wait",
					subject: "lapsed",
					until: new Date(at - 1).toISOString(),
				}),
			],
		});

		const own = ownLeases(board, "me", at);

		expect(own.leases.map(({ subject }) => subject)).toEqual(["kept"]);
		expect(board.of("me")?.leases.map(({ subject }) => subject)).toEqual([
			"kept",
		]);
	});

	it("are written again only when renewing moves their end a minute or more", () => {
		const dir = join(root, "leases");
		const own = ownLeases(createBoard(dir), "me", at);
		const file = join(dir, "me.json");

		const taken = own.take("change", "x", minutes(10), undefined, at);
		const written = readFileSync(file, "utf8");
		const kept = own.take("change", "x", minutes(10), undefined, at + 59_000);
		expect(kept).toBe(taken);
		expect(readFileSync(file, "utf8")).toBe(written);

		const renewed = own.take(
			"change",
			"x",
			minutes(10),
			undefined,
			at + 60_000,
		);
		expect(renewed.since).toBe(taken.since);
		expect(renewed.until).toBe(new Date(at + minutes(11)).toISOString());
		expect(readFileSync(file, "utf8")).not.toBe(written);
	});

	it("are given up one at a time, or a run's all at once", () => {
		const board = createBoard(join(root, "leases"));
		const own = ownLeases(board, "me", at);
		own.take("change", "x", minutes(10), undefined, at);
		own.take("answer", "q", minutes(10), undefined, at);
		own.take("hold", "h", minutes(10), "builds", at);

		expect(own.release("hold", "h")?.why).toBe("builds");
		expect(own.release("hold", "h")).toBeUndefined();
		expect(own.held("change", "x", at)).toBeDefined();
		own.releaseAll(RUN_KINDS);
		expect(own.leases).toEqual([]);
		expect(board.of("me")).toBeUndefined();
	});

	it("name the peer a hand takes them for", () => {
		const dir = join(root, "leases");
		const own = ownLeases(createBoard(dir), "me.hand.1", at, "me");

		own.take("heavy", "nix", minutes(10), undefined, at);

		expect(createBoard(dir).of("me.hand.1")?.handOf).toBe("me");
	});

	it("are not held past their end", () => {
		const own = ownLeases(createBoard(join(root, "leases")), "me", at);
		own.take("hold", "h", minutes(1), undefined, at);

		expect(own.held("hold", "h", at + minutes(1))).toBeUndefined();
	});
});

describe("heavy work in a shell command", () => {
	it("is named by what it runs, wherever in the command it is", () => {
		expect(heavyWorkIn("cd x && nice -n 10 nix flake check -L")).toBe(
			"nix flake check",
		);
		expect(heavyWorkIn("direnv exec . nix build .#checks.vm")).toBe(
			"nix build",
		);
		expect(heavyWorkIn("nix-build -A vm")).toBe("nix build");
		expect(heavyWorkIn("qemu-system-x86_64 -m 2G")).toBe("qemu");
		expect(heavyWorkIn("sudo nixos-rebuild switch")).toBe("nixos-rebuild");
		expect(heavyWorkIn("cargo build --release")).toBe("cargo build");
	});

	it("is nothing for a command that only looks at things", () => {
		expect(heavyWorkIn("nix flake show")).toBeUndefined();
		expect(heavyWorkIn("cargo fmt")).toBeUndefined();
		expect(heavyWorkIn("git log --grep nixbuild")).toBeUndefined();
	});

	it("is nothing where the work is only named, in quotes or a heredoc", () => {
		expect(heavyWorkIn('echo "nix flake check" >/dev/null')).toBeUndefined();
		expect(heavyWorkIn("rg 'cargo build' lib")).toBeUndefined();
		expect(
			heavyWorkIn('git commit -m "fix: say \\"nix build\\" plainly"'),
		).toBeUndefined();
		expect(
			heavyWorkIn(
				"gh pr create --body-file - <<'EOF'\nRan nix build.\nEOF\nls",
			),
		).toBeUndefined();
		// Outside the quotes it still runs.
		expect(heavyWorkIn('nix build ".#vm" && echo "done"')).toBe("nix build");
		expect(heavyWorkIn("cat <<EOF > x\nhi\nEOF\nnix build")).toBe("nix build");
	});
});

describe("the lease event", () => {
	it("takes or releases heavy work by its subject", () => {
		expect(
			leaseEventFrom({ take: { subject: " qemu ", why: "vm test", ms: 5 } }),
		).toEqual({ take: { subject: "qemu", why: "vm test", ms: 5 } });
		expect(leaseEventFrom({ take: { subject: "qemu", ms: -1 } })).toEqual({
			take: { subject: "qemu" },
		});
		expect(leaseEventFrom({ release: "qemu" })).toEqual({ release: "qemu" });
	});

	it("is nothing without a subject", () => {
		expect(leaseEventFrom({ take: { subject: "" } })).toBeUndefined();
		expect(leaseEventFrom({ release: " " })).toBeUndefined();
		expect(leaseEventFrom({ take: "qemu" })).toBeUndefined();
		expect(leaseEventFrom("qemu")).toBeUndefined();
	});
});
