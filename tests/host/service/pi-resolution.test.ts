/** The host program binds the harness's pi and typebox imports to the host's own pi, and nothing else. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { piFromHost } from "../../../host/service/pi-resolution.ts";

const PI = "/nix/store/host-pi/lib/node_modules/pi-monorepo";
const HARNESS = "file:///harness/lib/core/viewer/terminal.ts";

interface Context {
	parentURL?: string;
	conditions?: string[];
}

/** What the hook passed on to node's own resolver. */
function resolved(specifier: string, parentURL: string, packageDir = PI) {
	const asks: { asked: string; context: Context | undefined }[] = [];
	piFromHost(packageDir)(
		specifier,
		{ parentURL, conditions: ["node"] },
		(asked: string, context?: Context) => {
			asks.push({ asked, context });
			return asked;
		},
	);
	expect(asks, "node is asked once").toHaveLength(1);
	const [ask] = asks;
	if (!ask) throw new Error("node was never asked");
	return { asked: ask.asked, context: ask.context ?? {} };
}

describe("piFromHost", () => {
	it("resolves a harness module's pi import from the host's pi, keeping the rest of the context", () => {
		for (const specifier of [
			"@earendil-works/pi-tui",
			"@earendil-works/pi-ai/compat",
			"typebox",
			"typebox/value",
		]) {
			const { asked, context } = resolved(specifier, HARNESS);
			expect(asked).toBe(specifier);
			expect(context).toEqual({
				parentURL: `file://${PI}/package.json`,
				conditions: ["node"],
			});
		}
	});

	describe("for an install with the bundle's host entry", () => {
		const installs: string[] = [];
		afterEach(() => {
			for (const install of installs.splice(0))
				rmSync(install, { recursive: true, force: true });
		});

		/** An install whose bundle has a host entry and host modules for these libraries. */
		function bundledInstall(libraries: readonly string[]): string {
			const install = mkdtempSync(join(tmpdir(), "pi-resolution-"));
			installs.push(install);
			const bundle = join(install, "dist", "bundle");
			for (const file of [
				"host.js",
				...libraries.map((name) => `host-modules/${name}.js`),
			]) {
				mkdirSync(dirname(join(bundle, file)), { recursive: true });
				writeFileSync(join(bundle, file), "export {};\n");
			}
			return install;
		}

		it("resolves a harness module's pi import to the bundle's copy, which pi hands its extensions", () => {
			const install = bundledInstall([
				"pi-tui",
				"pi-ai/compat",
				"typebox",
				"typebox/compile",
			]);
			for (const [specifier, name] of [
				["@earendil-works/pi-tui", "pi-tui"],
				["@earendil-works/pi-ai/compat", "pi-ai/compat"],
				["typebox", "typebox"],
				["typebox/compile", "typebox/compile"],
			] as const) {
				const { asked, context } = resolved(specifier, HARNESS, install);
				expect(asked).toBe(
					pathToFileURL(
						join(install, "dist", "bundle", "host-modules", `${name}.js`),
					).href,
				);
				expect(context).toEqual({ parentURL: HARNESS, conditions: ["node"] });
			}
		});

		it("refuses a pi library the bundle shares no copy of, rather than loading a second", () => {
			const install = bundledInstall(["pi-tui"]);
			for (const specifier of [
				"@earendil-works/pi-durable",
				"@earendil-works/pi-tui/../pi-tui",
			])
				expect(() => resolved(specifier, HARNESS, install)).toThrow(
					`The host's pi bundle shares no ${specifier} with the host`,
				);
		});

		it("takes typebox from the harness's own copy when the bundle shares none, for the program to refuse that bundle as it starts", () => {
			// A bundle from before typebox was shared gives the host none.
			const install = bundledInstall(["pi-tui"]);
			for (const specifier of ["typebox", "typebox/compile"]) {
				const { asked, context } = resolved(specifier, HARNESS, install);
				expect(asked).toBe(specifier);
				expect(context).toEqual({ parentURL: HARNESS, conditions: ["node"] });
			}
		});

		it("leaves pi's own imports to node", () => {
			const install = bundledInstall(["pi-tui"]);
			const own = pathToFileURL(
				join(install, "dist", "bundle", "host.js"),
			).href;
			const { asked, context } = resolved(
				"@earendil-works/pi-tui",
				own,
				install,
			);
			expect(asked).toBe("@earendil-works/pi-tui");
			expect(context.parentURL).toBe(own);
		});
	});

	// node hands every hook in a chain one context, and merges into it each
	// context passed to the next step, so a second ask must name its parent.
	it("takes typebox from the harness's own copy when the install gives none, and never a pi library", () => {
		const root = `file://${PI}/package.json`;
		const asked = (specifier: string) => {
			const parents: (string | undefined)[] = [];
			const hook = piFromHost(PI);
			const merged: Context = { parentURL: HARNESS };
			const found = () =>
				hook(specifier, merged, (_: string, passed?: Context) => {
					const context = Object.assign(merged, passed);
					parents.push(context.parentURL);
					if (context.parentURL === root)
						throw new Error(`Cannot find package '${specifier}'`);
					return "found";
				});
			return { found, parents };
		};
		const typebox = asked("typebox/compile");
		expect(typebox.found()).toBe("found");
		expect(typebox.parents).toEqual([root, HARNESS]);
		const tui = asked("@earendil-works/pi-tui");
		expect(tui.found).toThrow("Cannot find package '@earendil-works/pi-tui'");
		expect(tui.parents).toEqual([root]);
	});

	it("leaves pi's own imports and every other package to node", () => {
		const own = `file://${PI}/packages/coding-agent/dist/index.js`;
		expect(resolved("@earendil-works/pi-ai", own).context.parentURL).toBe(own);
		for (const specifier of [
			"zod",
			"node:fs",
			"./terminal.ts",
			"typeboxes",
			"@sinclair/typebox",
		])
			expect(resolved(specifier, HARNESS).context.parentURL).toBe(HARNESS);
	});
});
