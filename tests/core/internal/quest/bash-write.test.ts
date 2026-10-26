import { describe, expect, it } from "vitest";
import {
	bashWriteTargets,
	classifyBashWrite,
	resolveBashWrites,
} from "../../../../lib/core/internal/quest/bash-write.ts";

describe("resolveBashWrites", () => {
	const where = { cwd: "/session", home: "/home/me" };

	it("places a relative target in the directory a cd moved to", () => {
		const command = "cd /tree/src && cat >> x_test.go <<'EOF'\nbody\nEOF";
		expect(resolveBashWrites(command, where)).toEqual({
			paths: ["/tree/src/x_test.go"],
			removed: [],
			unresolved: [],
		});
	});

	it("places nothing for a command that only reads through a redirect", () => {
		expect(resolveBashWrites("wc -l < /etc/hosts", where)).toEqual({
			paths: [],
			removed: [],
			unresolved: [],
		});
	});

	it("places a target in the session directory when nothing moved it", () => {
		expect(resolveBashWrites("echo x > notes.md", where).paths).toEqual([
			"/session/notes.md",
		]);
	});

	it("follows a cd to a directory the command assigned", () => {
		const command = "Q=~/quests/Q1; cd $Q/lab && echo x > run.log";
		expect(resolveBashWrites(command, where).paths).toEqual([
			"/home/me/quests/Q1/lab/run.log",
		]);
	});

	it("only moves the targets of commands after the cd", () => {
		const command = "echo a > first.txt; cd sub; echo b > second.txt";
		expect(resolveBashWrites(command, where).paths).toEqual([
			"/session/first.txt",
			"/session/sub/second.txt",
		]);
	});

	it("expands a home-relative target", () => {
		expect(resolveBashWrites("echo x > ~/out.txt", where).paths).toEqual([
			"/home/me/out.txt",
		]);
	});

	it("reports a relative target as unresolved after a cd it cannot follow", () => {
		const command = "cd $(git rev-parse --show-toplevel) && echo x > out.txt";
		expect(resolveBashWrites(command, where)).toEqual({
			paths: [],
			removed: [],
			unresolved: ["out.txt"],
		});
	});

	it("still places an absolute target after a cd it cannot follow", () => {
		const command = "cd $(pwd) && echo x > /abs/out.txt";
		expect(resolveBashWrites(command, where).paths).toEqual(["/abs/out.txt"]);
	});

	it("reports a target built from an unknown variable as unresolved", () => {
		expect(resolveBashWrites('echo x > "$OUT/f.txt"', where)).toEqual({
			paths: [],
			removed: [],
			unresolved: ["$OUT/f.txt"],
		});
	});

	it("leaves a relative target in a subshell with a cd unresolved", () => {
		const command = "(cd sub && echo x > b.txt)";
		expect(resolveBashWrites(command, where)).toEqual({
			paths: [],
			removed: [],
			unresolved: ["b.txt"],
		});
	});

	it("reports only the files an in-place sed edits", () => {
		const cases: [string, string[]][] = [
			["sed -i 's/a(t, s)/b(t, s)/' x.go 2>/dev/null", ["/session/x.go"]],
			["sed -i '' 's/a/b/' x.go y.go", ["/session/x.go", "/session/y.go"]],
			["sed -i.bak 's/a/b/' x.go", ["/session/x.go"]],
			["sed -i .bak 's/a/b/' x.go", ["/session/x.go"]],
			["sed -E -i -e 's/a/b/' -e 's/c/d/' x.go", ["/session/x.go"]],
			["sed --in-place=.orig -f fix.sed x.go", ["/session/x.go"]],
			["gsed -i 's/a/b/' x.go", ["/session/x.go"]],
		];
		for (const [command, paths] of cases) {
			expect(resolveBashWrites(command, where).paths, command).toEqual(paths);
		}
	});

	it("reports only the files an in-place perl edits", () => {
		const cases: [string, string[]][] = [
			["perl -pi -e 's/a/b/' x.go", ["/session/x.go"]],
			["perl -i.bak -ne 'print' x.go y.go", ["/session/x.go", "/session/y.go"]],
			["perl -i fix.pl x.go", ["/session/x.go"]],
		];
		for (const [command, paths] of cases) {
			expect(resolveBashWrites(command, where).paths, command).toEqual(paths);
		}
	});

	it("reports where a command creates files without a redirect", () => {
		const cases: [string, string[]][] = [
			["cp a.txt out.txt", ["/session/out.txt"]],
			["cp -R src/ /abs/dest", ["/abs/dest"]],
			["cp a.txt b.png lab/", ["/session/lab/a.txt", "/session/lab/b.png"]],
			["cp -t lab a.txt", ["/session/lab/a.txt"]],
			["mv old.md new.md", ["/session/new.md"]],
			["install -m 0644 a.sh bin/a", ["/session/bin/a"]],
			["ln -s /abs/target link", ["/session/link"]],
			["rsync -a --exclude node_modules src/ lab", ["/session/lab"]],
			["rsync -a src/ host:/srv", []],
			["mkdir -p -m 700 a/b c", ["/session/a/b", "/session/c"]],
			["touch -t 202601010000 stamp", ["/session/stamp"]],
			["dd if=/dev/zero of=blob.bin bs=1m count=1", ["/session/blob.bin"]],
			["git clone --depth 1 https://x.io/o/repo.git", ["/session/repo"]],
			["git clone -b main git@x.io:o/r.git lab/r", ["/session/lab/r"]],
			["git -C /abs clone https://x.io/o/r", ["/abs/r"]],
			["git worktree add -b topic ../wt main", ["/wt"]],
			["curl -sSLo page.html https://x.io/p", ["/session/page.html"]],
			["curl --output=a.json https://x.io/a", ["/session/a.json"]],
			["curl -H 'A: b' -O https://x.io/d/f.tgz", ["/session/f.tgz"]],
			["curl -s https://x.io/p", []],
			["wget -q -O f.zip https://x.io/f", ["/session/f.zip"]],
			["wget -P dl https://x.io/d/f.zip", ["/session/dl/f.zip"]],
			["tar -czf out.tgz dir", ["/session/out.tgz"]],
			["tar xzf in.tgz -C lab", ["/session/lab"]],
			["tar -xf in.tar", ["/session"]],
			["tar -tf in.tar", []],
			["unzip -q in.zip -d lab", ["/session/lab"]],
			["nohup cp a.txt b.txt &", ["/session/b.txt"]],
			["time env X=1 nice -n 5 command mkdir d", ["/session/d"]],
		];
		for (const [command, paths] of cases) {
			expect(resolveBashWrites(command, where).paths, command).toEqual(paths);
		}
	});

	it("reports what a command removes apart from what it writes", () => {
		const cases: [string, string[], string[]][] = [
			["rm -rf build notes.md", [], ["/session/build", "/session/notes.md"]],
			["cd /q && rm -- -odd.md", [], ["/q/-odd.md"]],
			["rmdir -p a/b", [], ["/session/a/b"]],
			["unlink /abs/f", [], ["/abs/f"]],
			["mv plans/a.md lab/", ["/session/lab/a.md"], ["/session/plans/a.md"]],
			[
				"mv -t lab a.md b.md",
				["/session/lab/a.md", "/session/lab/b.md"],
				["/session/a.md", "/session/b.md"],
			],
			["nohup rm -f ~/x.log", [], ["/home/me/x.log"]],
		];
		for (const [command, paths, removed] of cases) {
			const writes = resolveBashWrites(command, where);
			expect(writes.paths, command).toEqual(paths);
			expect(writes.removed, command).toEqual(removed);
		}
	});

	it("expands a brace list into each path bash would write", () => {
		const cases: [string, string[]][] = [
			["mkdir -p lab/{a,b}", ["/session/lab/a", "/session/lab/b"]],
			[
				"mkdir -p {x,y}/{1,2}",
				["/session/x/1", "/session/x/2", "/session/y/1", "/session/y/2"],
			],
			["touch f.{md,png}", ["/session/f.md", "/session/f.png"]],
			["mkdir {a,b{c,d}}", ["/session/a", "/session/bc", "/session/bd"]],
			["touch '{a,b}'", ["/session/{a,b}"]],
			["touch {solo}", ["/session/{solo}"]],
			["cp a.md lab/*.md", ["/session/lab/*.md"]],
		];
		for (const [command, paths] of cases) {
			expect(resolveBashWrites(command, where).paths, command).toEqual(paths);
		}
	});

	it("reports a removal it cannot place as unresolved", () => {
		expect(resolveBashWrites('rm "$DIR/f.md"', where)).toEqual({
			paths: [],
			removed: [],
			unresolved: ["$DIR/f.md"],
		});
	});

	it("reports nothing for an editor that is not editing in place", () => {
		expect(resolveBashWrites("sed 's/a/b/' x.go", where).paths).toEqual([]);
	});

	it("places targets in a loop without a cd in the session directory", () => {
		const command = "for f in a b; do echo $f >> all.txt; done";
		expect(resolveBashWrites(command, where).paths).toEqual([
			"/session/all.txt",
		]);
	});
});

describe("classifyBashWrite", () => {
	it("flags a genuinely git-mutating command as git-mutating", () => {
		expect(classifyBashWrite('git commit -m "wip"')).toBe("git-mutating");
	});

	it("flags a redirect or in-place write as bash-write", () => {
		expect(classifyBashWrite("cat > foo.txt")).toBe("bash-write");
		expect(classifyBashWrite("sed -i 's/a/b/' foo.txt")).toBe("bash-write");
	});

	it("treats a mutating verb in a quoted literal as read-only", () => {
		expect(classifyBashWrite('grep -n "branch -d" file.ts')).toBe("read-only");
		expect(classifyBashWrite('rg "git push origin" extensions/')).toBe(
			"read-only",
		);
	});

	it("treats a mutating verb inside a heredoc body as read-only", () => {
		const command = "python3 - <<'PY'\nprint('git reset --hard')\nPY";
		expect(classifyBashWrite(command)).toBe("read-only");
	});
});

describe("bashWriteTargets", () => {
	it("extracts redirect destinations", () => {
		expect(bashWriteTargets("cat > /tmp/dump.json")).toEqual([
			"/tmp/dump.json",
		]);
		expect(bashWriteTargets("echo hi >> notes.md")).toEqual(["notes.md"]);
	});

	it("extracts a tee destination, skipping flags", () => {
		expect(bashWriteTargets("echo x | tee -a out.log")).toEqual(["out.log"]);
	});

	it("ignores heredoc bodies", () => {
		const command = "cat > real.txt <<'EOF'\necho not > a-target\nEOF";
		expect(bashWriteTargets(command)).toEqual(["real.txt"]);
	});

	it("resolves the file argument of an in-place editor", () => {
		expect(bashWriteTargets("sed -i 's/a/b/' src/foo.ts")).toContain(
			"src/foo.ts",
		);
		expect(bashWriteTargets("gsed -i.bak 's/a/b/g' lib/x.ts")).toContain(
			"lib/x.ts",
		);
		expect(bashWriteTargets("perl -i -pe 's/a/b/' a/b.ts")).toContain("a/b.ts");
	});

	it("does not treat a non-in-place editor as a write target", () => {
		expect(bashWriteTargets("perl -pe 's/a/b/' foo.ts")).toEqual([]);
	});

	it("ignores fd redirects such as 2> and &>", () => {
		expect(bashWriteTargets("cat foo 2> err.log")).not.toContain("err.log");
	});

	it("does not capture a redirect that lived inside quoted data", () => {
		expect(bashWriteTargets('echo "a > b" > real.ts')).toEqual(["real.ts"]);
	});

	it("returns empty when there is no parseable write target", () => {
		expect(bashWriteTargets("ls -la")).toEqual([]);
	});

	it("does not read an input redirect as a write", () => {
		expect(bashWriteTargets("tr a b < /proc/1/environ")).toEqual([]);
		expect(bashWriteTargets('d=notes.md; wc -c < "$d"')).toEqual([]);
		expect(bashWriteTargets("sort <input.txt")).toEqual([]);
	});

	it("still reads the output redirect beside an input one", () => {
		expect(bashWriteTargets("sort < in.txt > out.txt")).toEqual(["out.txt"]);
		expect(bashWriteTargets("cat < in.txt | tee f.log")).toEqual(["f.log"]);
	});
});

describe("a target the command names through a variable", () => {
	// A path held in a shell variable used to come back as the literal
	// `$Q/plans/P.md`, which the gate then resolved against the cwd. That
	// named a file in whatever tree the session happened to be standing in,
	// so a legitimate write to a quest directory was blocked with adoption
	// guidance pointing at an unrelated repository.

	it("resolves an assignment made in the same command", () => {
		expect(bashWriteTargets("Q=/tmp/quest; echo hi >> $Q/plans/P.md")).toEqual([
			"/tmp/quest/plans/P.md",
		]);
	});

	it("reads a quoted destination, which is the ordinary spelling", () => {
		// This was pinned as "sees no target at all", on the reasoning that
		// reading a quoted target meant giving up the strip that stops a `>`
		// inside a string looking like a redirect. That reasoning was wrong:
		// the two are separate questions, because what makes a redirect real
		// is the operator being unquoted, not its target being bare.
		// It also made the expansion above nearly inert, since a path built
		// from a variable is conventionally quoted.
		expect(bashWriteTargets('echo hi >> "/tmp/plain.md"')).toEqual([
			"/tmp/plain.md",
		]);
		expect(bashWriteTargets('Q=/tmp/q; echo hi >> "$Q/f.md"')).toEqual([
			"/tmp/q/f.md",
		]);
		expect(bashWriteTargets("echo hi >> '/tmp/single.md'")).toEqual([
			"/tmp/single.md",
		]);
	});

	it("reads a quoted destination for tee and for an in-place editor", () => {
		expect(bashWriteTargets('Q=/tmp/q; tee "$Q/f.md"')).toEqual([
			"/tmp/q/f.md",
		]);
		// The sed case was answering worse than nothing: it reported the
		// script `s/x/y/` as though it were the file, and missed the file.
		expect(bashWriteTargets('sed -i "" -e s/x/y/ "lib/thing.ts"')).toContain(
			"lib/thing.ts",
		);
	});

	it("still refuses a quoted target it cannot expand", () => {
		expect(bashWriteTargets('echo hi > "$UNKNOWN/f.txt"')).toEqual([]);
	});

	it("reads a write the command grammar declines to model", () => {
		// The command model does not describe a loop or a subshell, and such a
		// command writes as readily as any other. This is why the patterns are
		// kept alongside the model rather than replaced by it.
		expect(
			bashWriteTargets("for f in a b; do echo x >> tracked.ts; done"),
		).toContain("tracked.ts");
		expect(bashWriteTargets("(echo x > inner.ts)")).toContain("inner.ts");
	});

	it("reads the braced spelling too", () => {
		// Assembled rather than written literally, because `${D}` in a plain
		// string is a template placeholder somebody forgot to interpolate as
		// far as the linter can tell, and it is right to say so.
		const braced = `D=/tmp/x; echo hi > $${"{D}"}/out.txt`;

		expect(bashWriteTargets(braced)).toEqual(["/tmp/x/out.txt"]);
	});

	it("takes the last assignment, which is what the shell would use", () => {
		expect(
			bashWriteTargets("P=/tmp/one; P=/tmp/two; echo hi > $P/f.txt"),
		).toEqual(["/tmp/two/f.txt"]);
	});

	it("declines to judge a target it cannot expand", () => {
		// Guessing is worse than declining: resolving an unexpanded sigil
		// against the cwd invents a path nobody wrote to, and blocking the
		// wrong tree is a worse failure than not judging this one.
		expect(bashWriteTargets("echo hi > $UNKNOWN/f.txt")).toEqual([]);
		expect(bashWriteTargets("echo hi > $(dirname x)/f.txt")).toEqual([]);
	});

	it("still reads a plain target alongside one it cannot expand", () => {
		expect(
			bashWriteTargets("echo a > plain.txt; echo b > $NOPE/other.txt"),
		).toEqual(["plain.txt"]);
	});
});

describe("what a heredoc's opening line says after it", () => {
	const where = { cwd: "/session", home: "/home/me" };

	it("counts a redirect written after the heredoc's word", () => {
		const command = "cat <<EOF > out.txt\nhello\nEOF";
		expect(resolveBashWrites(command, where).paths).toEqual([
			"/session/out.txt",
		]);
		expect(bashWriteTargets(command)).toEqual(["out.txt"]);
		expect(classifyBashWrite(command)).toBe("bash-write");
	});

	it("counts a tee the heredoc is piped into, where the command ran", () => {
		const command = "cd /tree && cat <<'EOF' | tee -a log.md\nx\nEOF";
		expect(resolveBashWrites(command, where).paths).toEqual(["/tree/log.md"]);
	});

	it("counts nothing for a heredoc piped into a reader", () => {
		const command = "python3 - <<'PY' 2>&1 | tail -5\nprint(1)\nPY";
		expect(resolveBashWrites(command, where)).toEqual({
			paths: [],
			removed: [],
			unresolved: [],
		});
		expect(bashWriteTargets(command)).toEqual([]);
	});
});

describe("a comparison is not a redirect", () => {
	const where = { cwd: "/session", home: "/home/me" };

	it("reads > inside [[ ]] as a comparison", () => {
		const command = "[[ $count > 9 ]] && echo yes";
		expect(resolveBashWrites(command, where).paths).toEqual([]);
		expect(bashWriteTargets(command)).toEqual([]);
	});

	it("reads > inside arithmetic as a comparison", () => {
		const command = "x=$((3 > 2)); echo $x";
		expect(resolveBashWrites(command, where).paths).toEqual([]);
		expect(bashWriteTargets(command)).toEqual([]);
		expect(classifyBashWrite("echo $((3 > 2))")).toBe("read-only");
	});

	it("still counts a real redirect beside an arithmetic test", () => {
		const command = "(( n > 5 )) && echo big > big.txt";
		expect(resolveBashWrites(command, where).paths).toEqual([
			"/session/big.txt",
		]);
		expect(bashWriteTargets(command)).toEqual(["big.txt"]);
	});
});
