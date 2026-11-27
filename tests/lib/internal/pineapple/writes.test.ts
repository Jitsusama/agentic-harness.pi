import { describe, expect, it } from "vitest";
import {
	changeOf,
	type GitFacts,
	pushRemote,
	repoOfPushUrls,
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
		held("jobs-broker run -- pi -p go", "pi");
		held("jobs-broker run --quest 0tud09 -- pi", "pi");
		held("/usr/bin/env pi -p go", "pi");
		held("/run/wrappers/bin/sudo pi -p go", "pi");
		held("/usr/bin/timeout 60 pi", "pi");
		held("/usr/bin/env bash -c 'pi -p go'", "pi");
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
		held("tmux new-window -d 'pi -p go'", "tmux pi");
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
			"jobs-broker run -- nix build .#thing",
			"jobs-broker status pi-agent-proxy.socket",
			"/run/wrappers/bin/sudo systemctl status pi-host-work-attended",
		]) {
			expect(start(command), command).toEqual([]);
		}
	});

	it("finds a start by pattern in a line the command model can't read", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		expect(
			actions("for u in a b; do systemctl --user restart pi-host-$u; done"),
		).toContain("pi host restart");
		expect(actions("for q in a b; do mycelium carry $q; done")).toContain(
			"mycelium carry",
		);
		expect(actions("for i in 1; do pi-packages update; done")).toContain(
			"pi-packages update",
		);
		expect(
			actions("for u in a b; do systemctl --user status pi-host-$u; done"),
		).toEqual([]);
		expect(actions('for i in 1 2; do pi -p "go $i" & done')).toContain("pi");
		expect(actions("for i in 1; do nohup pi-host; done")).toContain("pi-host");
		expect(actions("for i in 1; do pi --version; done")).toEqual([]);
		expect(actions("cd ~/src/pi; for i in 1; do ls; done")).toEqual([]);
	});

	it("reads each command of a line it can't read, through what runs it", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		const held = (command: string, action: string) =>
			expect(actions(command), command).toEqual([action]);
		held("for i in 1; do env A=1 pi -p go; done", "pi");
		held("for i in 1; do timeout 60 pi; done", "pi");
		held("for i in 1; do tmux new-window 'pi'; done", "tmux pi");
		held("for i in 1; do bash -c 'pi -p go'; done", "pi");
		held("for i in 1; do mycelium run --need machine=mac -- pi; done", "pi");
		held("x=$(pi -p go)", "pi");
		held("(cd /x && pi)", "pi");
		for (const command of [
			"git commit -m \"$(cat <<'EOF'\nthen pi (pi-host) restarts\nEOF\n)\" && for f in a; do ls; done",
			'for f in a; do rg "(pi|host)" $f; done',
			"for f in a; do echo 'and then pi restarts'; done",
			"for u in $(systemctl --user list-units --plain); do systemctl --user status $u; done",
		]) {
			expect(actions(command), command).toEqual([]);
		}
	});

	it("reads what a double-quoted substitution, or a shell's stdin, runs", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		const held = (command: string, action: string) =>
			expect(actions(command), command).toEqual([action]);
		held('out="$(pi -p go)"', "pi");
		held('echo "`pi -p go`"', "pi");
		held("bash <<'EOF'\npi -p go\nEOF", "pi");
		held("echo 'pi -p go' | bash", "pi");
		held("bash -s <<< 'pi -p go'", "pi");
		for (const command of [
			"git commit -m \"$(cat <<'EOF'\nthen pi (pi-host) restarts\nEOF\n)\"",
			"cat <<'EOF' | wc -l\npi -p go\nEOF",
			"echo 'pi -p go' | bash script.sh",
		]) {
			expect(actions(command), command).toEqual([]);
		}
	});

	it("reads what an opaque runner runs, not every word it names", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		const held = (command: string, action: string) =>
			expect(actions(command), command).toEqual([action]);
		held("ssh mac systemctl --user restart pi-host-x", "ssh pi host restart");
		held("ssh -p 22 mac pi-packages update", "ssh pi-packages update");
		held("ssh mac mycelium carry X", "ssh mycelium carry");
		held("npx tsx scripts/pi-host.ts", "npx pi pi-host");
		held("pnpm exec tsx scripts/host-cutover.ts", "pnpm pi host-cutover");
		held("tmux send-keys -t w 'pi -p go' Enter", "tmux pi");
		held(
			"nix shell nixpkgs#nodejs_24 -c node scripts/pi-host.ts",
			"pi pi-host",
		);
		held("nix-shell --run 'pi -p go'", "pi");
		held("ssh mac -t pi", "ssh pi");
		held("ssh mac -- pi", "ssh pi");
		held("node scripts/pi-fence.ts --kind fence -- pi -p go", "pi");
		held("tmux send-keys -t w -l 'pi -p go' Enter", "tmux pi");
		held("npx @earendil-works/pi-coding-agent -p go", "npx pi");
		held(
			"node lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js -p go",
			"pi",
		);
		held("eval 'pi -p go'", "pi");
		held("flock /tmp/lock pi -p go", "pi");
		held("watch -n 5 pi -p go", "pi");
		held("doas -u joel pi", "pi");
		held("kitten @ launch --type=tab pi --session X", "kitten pi");
		held("kitty --directory=/x -- pi -p go", "kitty pi");
		held("wezterm start --always-new-process --cwd /x -- pi", "wezterm pi");
		held("ghostty --working-directory=/x -e pi", "ghostty pi");
		for (const command of [
			"command -v pi",
			"command -V pi-host",
			"command -v pi >/dev/null && echo yes",
			"pi --list-models",
			"pi --export s.jsonl out.html",
			"pi list",
			"pi install npm:x",
			"kitty @ ls",
			"ssh mac ls -- pi",
			"tmux send-keys -t w -l 'echo hi' Enter",
			"ssh mac ls ~/.local/state/pi",
			"ssh pi uptime",
			"ls | xargs grep -n pi",
			"xargs grep -lw pi",
			"tmux attach -t pi",
			"tmux kill-session -t pi",
			"screen -r pi",
			"pnpm install",
			"pnpm deploy out",
			"nix shell nixpkgs#jq -c jq . x.json",
		]) {
			expect(actions(command), command).toEqual([]);
		}
	});

	it("reads a heredoc, a comment and stdin as the shell does", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		const held = (command: string, action: string) =>
			expect(actions(command), command).toEqual([action]);
		held("cat <<'EOF' | bash\npi -p go\nEOF", "pi");
		held("cat > notes.md <<'EOF' && pi -p go\nnotes\nEOF", "pi");
		held("cd /tmp\n\necho 'pi-packages update' | bash", "pi-packages update");
		held("(cd /x; echo 'pi -p go' | bash)", "pi");
		held(
			"ssh mac bash -s <<'EOF'\nsystemctl --user restart pi-host-work-background\nEOF",
			"ssh pi host restart",
		);
		held("ssh mac <<'EOF'\npi-packages update\nEOF", "ssh pi-packages update");
		held("echo 'pi -p go' | ssh mac bash", "ssh pi");
		held("# don't wait\npi -p go\necho 'done'", "pi");
		for (const command of [
			"# rebuild first; pi picks it up\npnpm build",
			"# restart the host (pi-host) after\npnpm build",
			"systemctl --user status pi-host-x  # the host (pi-host) runs here",
			"ls  # list them; pi comes next",
			"cat <<'EOF' > notes.md\n# pi; then (pi-host)\nEOF",
			"ssh mac uptime <<< 'pi -p go'",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
			"echo ${#PATH}",
		]) {
			expect(actions(command), command).toEqual([]);
		}
	});

	it("reads quotes, shell options and pipes as bash does", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		const held = (command: string, action: string) =>
			expect(actions(command), command).toEqual([action]);
		held("cat > notes.md <<'EOF' && pi -p go\nit's done\nEOF", "pi");
		held("cat > n.md <<'EOF'\nit's\nEOF\ngit push origin fix", "git push");
		held(
			'git commit -m "$(printf "%s" "$msg")" -m "Refs #12" && git push origin fix',
			"git push",
		);
		held(
			'git commit -m "$(printf "%s #1" "$msg")" && git push origin fix',
			"git push",
		);
		held("bash -euo pipefail <<'EOF'\npi -p go\nEOF", "pi");
		held(
			"ssh mac bash -euo pipefail <<'EOF'\nsystemctl --user restart pi-host-work-background\nEOF",
			"ssh pi host restart",
		);
		held("echo 'pi -p go' |\n  bash", "pi");
		held("echo 'pi -p go' | sh -", "pi");
		held("cat <<EOF > f\n$(pi -p go)\nEOF", "pi");
		held("echo 'pi -p go' | nice bash", "pi");
		held("echo 'pi -p go' | ssh mac sudo bash", "ssh pi");
		expect(actions("cat <<'EOF' > f\n$(pi -p go)\nEOF")).toEqual([]);
	});

	it("finds heredocs, comments and stdin where bash finds them", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		const held = (command: string, action: string) =>
			expect(actions(command), command).toEqual([action]);
		held('cat <<EOF > f\n$(bash -c "pi -p go")\nEOF', "pi");
		held('cat <<EOF > f\nsay \\"hi\\"\n$(pi -p go)\nEOF', "pi");
		held("bash -c \"cat <<'EOF' > f\nit's\nEOF\npi -p go\"", "pi");
		held('echo "<<EOF"\npi -p go\nEOF', "pi");
		held("cat <<-EOF > f\n\tit's done\n\tEOF\npi -p go", "pi");
		held("echo $(date)#; pi -p go", "pi");
		held("echo a\\ #; pi -p go", "pi");
		held("echo 'pi -p go' | sudo -s", "pi");
		held("echo 'pi -p go' | /run/wrappers/bin/sudo bash", "pi");
		held("sudo -i <<'EOF'\npi -p go\nEOF", "pi");
		held("echo 'pi -p go' | su", "pi");
		held("echo 'pi -p go' | run0", "pi");
		held("echo 'pi -p go' | bash /dev/stdin", "pi");
		held("bash -co pipefail 'pi -p go'", "pi");
		held("bash -c -euo pipefail 'pi -p go'", "pi");
		held("sh -c -- 'pi -p go'", "pi");
		held(
			"git commit -m \"$(cat <<'EOF'\nit's done\nEOF\n)\" && git push origin fix",
			"git push",
		);
		held("echo \"$(bash <<'EOF'\necho 'hi'; pi -p go\nEOF\n)\"", "pi");
		expect(actions('cat <<EOF > f\n$(echo "a; pi")\nEOF')).toEqual([]);
		expect(actions("echo 'pi -p go' | ssh mac command -v bash")).toEqual([]);
	});

	it("reads su's lines, option clusters and stdin as getopt and bash do", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		const held = (command: string, action: string) =>
			expect(actions(command), command).toEqual([action]);
		held("su -lc 'pi -p go'", "pi");
		held("su -c'pi -p go'", "pi");
		held("su --session-command 'pi -p go'", "pi");
		held("su joel -s /bin/bash -c 'pi -p go'", "pi");
		held("bash -oc pipefail 'pi -p go'", "pi");
		held("echo 'pi -p go' | source /dev/stdin", "pi");
		held("echo 'pi -p go' | bash /proc/self/fd/0", "pi");
		for (const command of [
			"su joel -c 'ls'",
			"su -l joel",
			"bash -oc pipefail 'ls'",
		]) {
			expect(actions(command), command).toEqual([]);
		}
	});

	it("finds every heredoc opener and $'...' string bash finds", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		const held = (command: string, action: string) =>
			expect(actions(command), command).toEqual([action]);
		held("cat <<< x\npi -p go\nx", "pi");
		held("cat <<< word; pi -p go\nword", "pi");
		held("cat <<\\EOF > f\nit's\nEOF\npi -p go", "pi");
		held("cat <<'END-MSG' > f\nit's\nEND-MSG\npi -p go", "pi");
		held(
			"git commit -m $'Don\\'t break #12' && git push origin fix",
			"git push",
		);
		held("$'pi' -p go", "pi");
		held('echo "<<EOF"\nx=$(pi -p go)\nEOF', "pi");
		held("cat <<A <<B > f\nit's\nA\nit's\nB\npi -p go", "pi");
		held("cat <<A > f && cat <<B > g\na\nA\nb\nB\npi -p go", "pi");
		for (const command of [
			"cat <<\\EOF > f\n$(pi -p go)\nEOF",
			"cat <<A <<B > f\na\nA\npi -p go\nB",
			"cat <<A <<B > f\nB\nA\npi -p go\nB",
			"echo $'a\\'b' # pi -p go",
		]) {
			expect(actions(command), command).toEqual([]);
		}
	});

	it("sees past a wrapper's options that take a value", () => {
		const actions = (command: string) =>
			writesInBash(command, HERE).map((write) => write.action);
		for (const command of [
			"sudo -u joel pi",
			"timeout -k 5 30 pi",
			"env -S 'pi -p go'",
			"run0 -u joel pi",
		]) {
			expect(actions(command), command).toEqual(["pi"]);
		}
		expect(actions("sudo -u pi true"), "a user named pi").toEqual([]);
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
		pushRemoteOf: async () => "origin",
	};

	it("judges a push naming no remote by where git sends it", async () => {
		const forked: GitFacts = {
			...git,
			repoOf: async (_, remote) =>
				remote === "fork" ? "someone/shop" : "example/shop",
			pushRemoteOf: async () => "fork",
		};
		const push = { action: "git push", kind: "change", dir: HERE } as const;
		expect((await settle(push, forked)).repo).toBe("someone/shop");
		const named = { ...push, remote: "origin" };
		expect((await settle(named, forked)).repo).toBe("example/shop");
		const merge = { action: "gh pr merge", kind: "change", dir: HERE } as const;
		expect((await settle(merge, forked)).repo).toBe("example/shop");
	});

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

	it("finds the remote a bare push goes to as git does", async () => {
		const config = (set: Record<string, string>) => async (key: string) =>
			set[key];
		const defaults = {
			"remote.pushDefault": "fork",
			"branch.fix.remote": "upstream",
		};
		const all = { ...defaults, "branch.fix.pushRemote": "mine" };
		expect(await pushRemote("fix", config(all))).toBe("mine");
		expect(await pushRemote("fix", config(defaults))).toBe("fork");
		expect(
			await pushRemote("fix", config({ "branch.fix.remote": "upstream" })),
		).toBe("upstream");
		expect(await pushRemote(undefined, config(all))).toBe("fork");
		expect(await pushRemote("fix", config({}))).toBe("origin");
	});

	it("names where a remote pushes only when it pushes to one place", () => {
		expect(repoOfPushUrls("git@github.com:example/shop.git")).toBe(
			"example/shop",
		);
		expect(
			repoOfPushUrls(
				"git@github.com:example/shop.git\nhttps://github.com/Example/Shop\n",
			),
		).toBe("example/shop");
		expect(
			repoOfPushUrls(
				"git@github.com:example/shop.git\ngit@github.com:example/other.git",
			),
		).toBeUndefined();
		expect(
			repoOfPushUrls("git@github.com:example/shop.git\nshop"),
		).toBeUndefined();
		expect(repoOfPushUrls("")).toBeUndefined();
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
