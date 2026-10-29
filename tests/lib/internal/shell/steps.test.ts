import { describe, expect, it } from "vitest";
import {
	expandWith,
	stepsOf,
	wordsOf,
} from "../../../../lib/internal/shell/steps.ts";

const HOME = "/home/someone";

/** The shell's `${name}`, which a JavaScript string can't hold plainly. */
const braced = (name: string) => `$${"{"}${name}}`;

describe("a command's steps", () => {
	it("splits at separators outside quotes and substitutions, each in its place", () => {
		const command = `echo 'a; b' && x=$(date; true) || y "c|d"; z | tee f &`;
		const steps = stepsOf(command, "/w", HOME) ?? [];
		expect(steps.map((step) => step.text.trim())).toEqual([
			"echo 'a; b'",
			"x=$(date; true)",
			'y "c|d"',
			"z",
			"tee f",
			"",
		]);
		for (const step of steps) {
			expect(command.slice(step.start, step.end)).toBe(step.text);
		}
		expect(steps.map((step) => step.piped)).toEqual([
			false,
			false,
			false,
			true,
			true,
			true,
		]);
	});

	it("keeps a redirection's ampersand inside its step", () => {
		const steps = stepsOf("a >x 2>&1; b &>y", "/w", HOME) ?? [];
		expect(steps.map((step) => step.text.trim())).toEqual([
			"a >x 2>&1",
			"b &>y",
		]);
		expect(steps.some((step) => step.piped)).toBe(false);
	});

	it("follows the folder through cd and the variables set before it", () => {
		const command = `K=~/trees/one; cd $K && nix build .#a; cd ${braced("K")}/sub; cd; W=$(pwd); cd $W; x`;
		const steps = stepsOf(command, "/start", HOME) ?? [];
		expect(steps.map((step) => step.cwd)).toEqual([
			"/start",
			"/start",
			`${HOME}/trees/one`,
			`${HOME}/trees/one`,
			`${HOME}/trees/one/sub`,
			HOME,
			HOME,
			undefined,
		]);
		expect(steps[2]?.vars.get("K")).toBe(`${HOME}/trees/one`);
		expect(steps[6]?.vars.has("W")).toBe(false);
	});

	it("reads nothing of a command holding a heredoc", () => {
		expect(stepsOf("cat > f <<'EOF'\na; b\nEOF", "/w", HOME)).toBeUndefined();
	});
});

describe("a word as the shell expands it", () => {
	const expand = expandWith(new Map([["T", "/t"]]), "/w", HOME);

	it("expands what it knows, quotes taken off", () => {
		expect(expand('"git+file://$PWD#checks.x.y"')).toBe(
			"git+file:///w#checks.x.y",
		);
		expect(expand(`"path:${braced("T")}#c"`)).toBe("path:/t#c");
		expect(expand("~/x")).toBe(`${HOME}/x`);
		expect(expand("'$T'")).toBe("$T");
	});

	it("is nothing when it names what it can't know", () => {
		expect(expand("$c")).toBeUndefined();
		expect(expand('"$(pwd)#c"')).toBeUndefined();
		expect(expand("*.nix")).toBeUndefined();
	});

	it("splits words as the shell does, quotes kept", () => {
		expect(wordsOf(`nix build "a b" 'c d' e\\ f`)).toEqual([
			"nix",
			"build",
			'"a b"',
			"'c d'",
			"e\\ f",
		]);
	});
});
