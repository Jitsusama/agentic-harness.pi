import { describe, expect, it } from "vitest";
import {
	changeOf,
	type GitFacts,
	repoOfUrl,
	settle,
	writeInTool,
	writesInBash,
} from "../../../../lib/internal/pineapple/writes.ts";

const HERE = "/work/shop";
const TREES = "/trees";

describe("writesInBash", () => {
	it("sees no write in reads, builds and commits", () => {
		for (const command of [
			"git status && git log --oneline",
			"git commit -m 'fix: it'",
			"gh pr view 12",
			"gh pr checks 12",
			"dt pr diff 12",
			"gh api repos/example/shop/pulls/12",
			"nix build .#checks",
			"echo git push",
		]) {
			expect(writesInBash(command, HERE), command).toEqual([]);
		}
	});

	it("reads a push's remote and branch, and where it runs", () => {
		expect(writesInBash("cd /other && git push origin fix-it", HERE)).toEqual([
			{
				action: "git push",
				kind: "change",
				dir: "/other",
				remote: "origin",
				branch: "fix-it",
			},
		]);
		expect(
			writesInBash("git -C sub push -u origin HEAD:refs/heads/x", HERE),
		).toEqual([
			{
				action: "git push",
				kind: "change",
				dir: "/work/shop/sub",
				remote: "origin",
				branch: "x",
			},
		]);
		expect(writesInBash("git push", HERE)).toEqual([
			{ action: "git push", kind: "change", dir: HERE },
		]);
		expect(
			writesInBash("git push https://github.com/Example/Shop.git +b", HERE),
		).toEqual([
			{
				action: "git push",
				kind: "change",
				dir: HERE,
				repo: "example/shop",
				branch: "b",
			},
		]);
	});

	it("reads a pull request's writes through gh and dt", () => {
		expect(writesInBash("gh pr merge 12 --squash", HERE)).toEqual([
			{ action: "gh pr merge", kind: "change", dir: HERE, pr: 12 },
		]);
		expect(
			writesInBash(
				'gh pr comment https://github.com/example/shop/pull/12 --body "/merge"',
				HERE,
			),
		).toEqual([
			{
				action: "gh pr comment",
				kind: "change",
				dir: HERE,
				repo: "example/shop",
				pr: 12,
			},
		]);
		expect(writesInBash("gh pr ready -R example/shop fix-it", HERE)).toEqual([
			{
				action: "gh pr ready",
				kind: "change",
				dir: HERE,
				repo: "example/shop",
				branch: "fix-it",
			},
		]);
		expect(writesInBash("gh pr create --title t --body b", HERE)).toEqual([
			{ action: "gh pr create", kind: "repo", dir: HERE },
		]);
		expect(writesInBash("dt pr review 7 --approve", HERE)).toEqual([
			{ action: "dt pr review", kind: "change", dir: HERE, pr: 7 },
		]);
		expect(writesInBash("dt submit", HERE)).toEqual([
			{ action: "dt submit", kind: "change", dir: HERE },
		]);
		expect(
			writesInBash(
				"gh api -X POST repos/example/shop/issues/12/comments -f body=x",
				HERE,
			),
		).toEqual([
			{
				action: "gh api",
				kind: "change",
				dir: HERE,
				repo: "example/shop",
				pr: 12,
			},
		]);
	});

	it("sees through the words that run another command", () => {
		expect(writesInBash("timeout 60 env A=1 git push", HERE)).toHaveLength(1);
		expect(writesInBash("direnv exec . gh pr merge 3", HERE)[0]?.pr).toBe(3);
	});

	it("reads a switch or deploy as a write to the machine", () => {
		expect(writesInBash("switch-system", HERE)).toEqual([
			{ action: "switch-system", kind: "machine" },
		]);
		expect(writesInBash("nixos-rebuild switch --flake .", HERE)).toEqual([
			{ action: "nixos-rebuild switch", kind: "machine" },
		]);
		expect(writesInBash("nixos-rebuild build", HERE)).toEqual([]);
	});

	it("reads pi started, however it is wrapped, as a start of agents", () => {
		const start = (command: string) =>
			writesInBash(command, HERE).map(({ action, kind }) => ({ action, kind }));
		const held = (command: string, action: string) =>
			expect(start(command), command).toEqual([{ action, kind: "start" }]);
		held("pi", "pi");
		held("pi -p 'go on'", "pi");
		held("pi-host --attended", "pi-host");
		held("pi-carry ab12", "pi-carry");
		held("node scripts/pi-host.ts", "pi pi-host");
		held("tsx --env-file x scripts/pi-carry.ts", "pi pi-carry");
		held("./scripts/host-take-up.ts", "pi host-take-up");
		held("systemd-run --user --unit=x -p RuntimeMaxSec=60 -- pi", "pi");
		held("systemd-run --user --unit x --slice app.slice pi", "pi");
		held("setsid nohup pi", "pi");
		held("mycelium run --need machine=mac -- pi", "pi");
		held("bash -c 'pi -p hi'", "pi");
		held("bash -lc 'pi -p hi'", "pi");
		held("sh -ec pi", "pi");
		held("env -i pi", "pi");
		held("env -u HOME -C /tmp pi", "pi");
		held("systemd-run --user --on-active 30 pi", "pi");
		held("stdbuf -o L pi -p go", "pi");
		held("mycelium start --need machine=mac -- worker", "mycelium start");
		held("mycelium carry QEST-X --to mac", "mycelium carry");
		held("mycelium --realm personal sprout QEST-X", "mycelium sprout");
		held("mycelium start --need machine=mac", "mycelium start");
		held(
			"systemctl --user -H mac restart pi-host-work-background",
			"pi host restart",
		);
		held("systemctl --user start 'pi-host-*'", "pi host start");
		held("systemctl --user enable pi-conversation@x", "pi host enable");
		expect(start("pi --version")).toEqual([]);
		expect(start("pip install x")).toEqual([]);
	});

	it("reads pi started by a program that runs it its own way as a start", () => {
		const start = (command: string) =>
			writesInBash(command, HERE).map(({ action, kind }) => ({ action, kind }));
		const held = (command: string, action: string) =>
			expect(start(command), command).toEqual([{ action, kind: "start" }]);
		held("tmux new-window -d 'pi -p go'", "pi");
		held("xargs -n1 pi -p", "xargs pi");
		held("npx pi", "npx pi");
		held("pnpm exec pi", "pnpm pi");
		held("ssh mac pi", "ssh pi");
		held("screen -dm pi", "screen pi");
	});

	it("lets what takes agents away, or only names a host, go", () => {
		const start = (command: string) => writesInBash(command, HERE);
		for (const command of [
			"systemctl --user stop pi-host-work-background",
			"systemctl --user kill pi-conversation-ab12@x",
			"systemctl --user disable pi-host-work-attended",
			"systemctl --user -p ActiveState show pi-host-work-attended",
			"systemctl --user --state running list-units 'pi-host-*'",
			"cat scripts/host-cutover.ts",
			"git diff scripts/pi-host.ts",
			"rg cutover scripts/host-cutover.ts",
			"systemd-run --user --unit=x -- cat scripts/host-cutover.ts",
			"mycelium sessions",
			"mycelium starts list",
			"mycelium sessions --realm start",
			"tmux new-window -d 'htop'",
			"ssh mac uptime",
			"xargs -n1 echo",
			"pnpm exec vitest run",
			"mycelium run --need machine=mac -- uptime",
		]) {
			expect(start(command), command).toEqual([]);
		}
	});

	it("finds a start by pattern in a line the command model can't read", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		expect(
			actions("for u in a b; do systemctl --user restart pi-host-$u; done"),
		).toContain("pi host start");
		expect(actions("for q in a b; do mycelium carry $q; done")).toContain(
			"mycelium start",
		);
		expect(actions("for i in 1; do pi-packages update; done")).toContain(
			"pi-packages update",
		);
		expect(
			actions("for u in a b; do systemctl --user status pi-host-$u; done"),
		).toEqual([]);
		expect(actions('for i in 1 2; do pi -p "go $i" & done')).toContain("pi");
		expect(actions("for i in 1; do nohup pi-host; done")).toContain("pi");
		expect(actions("for i in 1; do pi --version; done")).toEqual([]);
		expect(actions("cd ~/src/pi; for i in 1; do ls; done")).toEqual([]);
	});

	it("reads every write of a shell's line, and where it runs only if known", () => {
		expect(
			writesInBash("bash -c 'pi -p go; git push origin fix'", HERE),
		).toEqual([
			{ action: "pi", kind: "start" },
			{
				action: "git push",
				kind: "change",
				dir: HERE,
				remote: "origin",
				branch: "fix",
			},
		]);
		expect(
			writesInBash('cd "$REPO" && bash -c "git push origin fix"', HERE),
		).toEqual([
			{ action: "git push", kind: "change", remote: "origin", branch: "fix" },
		]);
	});

	it("reads a pi host started, stopped or moved as a start of agents", () => {
		const start = (command: string) =>
			writesInBash(command, HERE).map(({ action, kind }) => ({ action, kind }));
		expect(start("systemctl --user restart pi-host-work-background")).toEqual([
			{ action: "pi host restart", kind: "start" },
		]);
		expect(start("systemctl --user start pi-conversation-ab12@x")).toEqual([
			{ action: "pi host start", kind: "start" },
		]);
		expect(start("node scripts/host-cutover.ts --only P9R1KI")).toEqual([
			{ action: "pi host-cutover", kind: "start" },
		]);
		expect(start("pi-packages update")).toEqual([
			{ action: "pi-packages update", kind: "start" },
		]);
		expect(start("systemctl --user status pi-host-work-attended")).toEqual([]);
		expect(start("systemctl --user restart pineapple")).toEqual([]);
		expect(start("node scripts/host-cutover.test.ts")).toEqual([]);
	});

	it("finds a write by pattern in a line the command model can't read", () => {
		const writes = writesInBash(
			"for b in a c; do git push origin $b; done",
			HERE,
		);
		expect(writes.map((write) => write.action)).toContain("git push");
	});
});

describe("writeInTool", () => {
	it("reads the review tools' change and repo", () => {
		expect(
			writeInTool(
				"review_offer",
				{ action: "merge", change: "https://github.com/Example/Shop/pull/12" },
				HERE,
				TREES,
			),
		).toEqual({
			action: "review_offer merge",
			kind: "change",
			dir: HERE,
			repo: "example/shop",
			pr: 12,
		});
		expect(
			writeInTool("review_say", { action: "reply", change: "7" }, HERE, TREES),
		).toEqual({
			action: "review_say reply",
			kind: "change",
			dir: HERE,
			pr: 7,
		});
	});

	it("reads a proposal as a write to the repository from its head", () => {
		expect(
			writeInTool(
				"review_offer",
				{ action: "propose", head: "fix-it", repo: "/t" },
				HERE,
				TREES,
			),
		).toEqual({
			action: "review_offer propose",
			kind: "repo",
			dir: "/t",
			branch: "fix-it",
		});
	});

	it("reads only the work tool's push, from its tree", () => {
		expect(
			writeInTool("work", { action: "record" }, HERE, TREES),
		).toBeUndefined();
		expect(
			writeInTool("work", { action: "push", tree: "shop-fix" }, HERE, TREES),
		).toEqual({
			action: "work push",
			kind: "change",
			dir: "/trees/shop-fix",
		});
	});

	it("reads a spawn, a council or a fleet as a start of agents", () => {
		const start = (tool: string, input: unknown) =>
			writeInTool(tool, input, HERE, TREES);
		expect(start("quest", { action: "spawn-tab" })).toEqual({
			action: "quest spawn-tab",
			kind: "start",
		});
		expect(start("quest", { action: "reopen-sessions", force: true })).toEqual({
			action: "quest reopen-sessions",
			kind: "start",
		});
		expect(start("quest", { action: "reopen-sessions" })).toBeUndefined();
		expect(start("quest", { action: "spawn", dryRun: true })).toBeUndefined();
		expect(start("quest", { action: "journal" })).toBeUndefined();
		expect(start("review_ask", { action: "council" })).toEqual({
			action: "review_ask council",
			kind: "start",
		});
		expect(start("review_ask", {})).toBeUndefined();
		expect(start("review_ask", { action: "collect" })).toBeUndefined();
		expect(start("subagent", { jobs: [] })).toEqual({
			action: "subagent",
			kind: "start",
		});
	});

	it("sees no write in reading tools", () => {
		expect(
			writeInTool("review_see", { action: "diff" }, HERE, TREES),
		).toBeUndefined();
		expect(
			writeInTool("review_draft", { action: "compose" }, HERE, TREES),
		).toBeUndefined();
		expect(writeInTool("read", { path: "x" }, HERE, TREES)).toBeUndefined();
	});
});

describe("settle", () => {
	const git: GitFacts = {
		repoOf: async (dir, remote) =>
			dir === HERE && remote === "origin" ? "example/shop" : undefined,
		branchOf: async () => "fix-it",
	};

	it("fills in the repository and branch the call left to its checkout", async () => {
		expect(
			await settle({ action: "git push", kind: "change", dir: HERE }, git),
		).toEqual({
			action: "git push",
			kind: "change",
			dir: HERE,
			repo: "example/shop",
			branch: "fix-it",
		});
	});

	it("leaves a named change's branch alone, and the machine's writes as they are", async () => {
		const merge = await settle(
			{ action: "gh pr merge", kind: "change", dir: HERE, pr: 12 },
			git,
		);
		expect(merge.branch).toBeUndefined();
		expect(
			await settle({ action: "switch-system", kind: "machine" }, git),
		).toEqual({
			action: "switch-system",
			kind: "machine",
		});
	});
});

describe("references", () => {
	it("reads a remote's owner and name from any form of URL", () => {
		expect(repoOfUrl("git@github.com:Example/Shop.git")).toBe("example/shop");
		expect(repoOfUrl("https://github.com/example/shop")).toBe("example/shop");
		expect(repoOfUrl("ssh://git@code.example.com/example/shop.git")).toBe(
			"example/shop",
		);
		expect(repoOfUrl("shop")).toBeUndefined();
	});

	it("reads a change from a link, owner/name#N, #N or N", () => {
		expect(
			changeOf("https://code.example.com/example/shop/pull/12/files"),
		).toEqual({
			repo: "example/shop",
			pr: 12,
		});
		expect(changeOf("example/shop#12")).toEqual({
			repo: "example/shop",
			pr: 12,
		});
		expect(changeOf("#12")).toEqual({ pr: 12 });
		expect(changeOf("12")).toEqual({ pr: 12 });
		expect(changeOf("fix-it")).toBeUndefined();
	});
});
