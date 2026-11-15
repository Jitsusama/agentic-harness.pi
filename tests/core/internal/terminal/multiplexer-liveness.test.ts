/**
 * What tmux and zellij say of the panes they were asked about.
 *
 * Both multiplexers answer the same way, so a pane is present when its
 * server lists it, absent when the server answers without it, and
 * unknown whenever nothing trustworthy was heard: a server that would
 * not answer, a pane recorded on another host, or a probe stopped
 * before it asked.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetBinaries } from "../../../../lib/core/internal/terminal/binaries.ts";
import { createKittyDriver } from "../../../../lib/core/internal/terminal/drivers/kitty.ts";
import { createTmuxDriver } from "../../../../lib/core/internal/terminal/drivers/tmux.ts";
import { createWeztermDriver } from "../../../../lib/core/internal/terminal/drivers/wezterm.ts";
import { createZellijDriver } from "../../../../lib/core/internal/terminal/drivers/zellij.ts";
import {
	type TerminalSessionHandle,
	terminalHandleKey,
} from "../../../../lib/terminal/index.ts";

/** How each multiplexer is faked, and the pane ids its fake lists. */
const MULTIPLEXERS = [
	{
		id: "tmux",
		make: () => createTmuxDriver({ cliTimeoutMs: 5000 }),
		listing: "printf '%%1\\n%%2\\n'",
		listed: "%1",
		missing: "%9",
	},
	{
		id: "zellij",
		make: () => createZellijDriver({ cliTimeoutMs: 5000 }),
		listing: `echo '[{"id":1,"is_plugin":false},{"id":4,"is_plugin":true}]'`,
		listed: "terminal_1",
		missing: "terminal_4",
	},
] as const;

/** A handle on a pane of the given multiplexer, on this host by default. */
function pane(
	driverId: string,
	value: string,
	scope: string,
	hostId = hostname(),
): TerminalSessionHandle {
	return { driverId, kind: `${driverId}-pane`, hostId, scope, value };
}

/** What the probe said of each handle, in the order they were given. */
function said(
	out: ReadonlyMap<string, string>,
	handles: TerminalSessionHandle[],
): (string | undefined)[] {
	return handles.map((handle) => out.get(terminalHandleKey(handle)));
}

/** A folder put first on PATH for each test, to hold fake terminals. */
function fakeBinaries(): {
	readonly dir: () => string;
	readonly fake: (name: string, script: string) => void;
} {
	let bin = "";
	let savedPath: string | undefined;

	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "fake-mux-"));
		savedPath = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
		forgetBinaries();
	});

	afterEach(() => {
		process.env.PATH = savedPath;
		forgetBinaries();
		rmSync(bin, { recursive: true, force: true });
	});

	return {
		dir: () => bin,
		fake: (name, script) => {
			const file = join(bin, name);
			writeFileSync(file, `#!/bin/sh\n${script}\n`);
			chmodSync(file, 0o755);
		},
	};
}

describe.each([
	{ id: "kitty", make: () => createKittyDriver({ cliTimeoutMs: 5000 }) },
	{ id: "wezterm", make: () => createWeztermDriver({ cliTimeoutMs: 5000 }) },
	...MULTIPLEXERS,
])("$id's liveness probe, for a pane it cannot reach", (driver) => {
	const binaries = fakeBinaries();

	it("asks no terminal about a pane on another host, and says unknown", async () => {
		const asked = join(binaries.dir(), "asked");
		binaries.fake(driver.id, `touch ${asked}`);
		const handles = [pane(driver.id, "1", "/run/one", "elsewhere")];

		const out = await driver.make().probe(handles);

		expect(said(out, handles)).toEqual(["unknown"]);
		expect(() => rmSync(asked)).toThrow();
	});
});

describe.each(MULTIPLEXERS)("$id's liveness probe", (mux) => {
	const binaries = fakeBinaries();
	const bin = (): string => binaries.dir();
	const fake = (script: string): void => binaries.fake(mux.id, script);

	it("says present for a listed pane and absent for one its server left out", async () => {
		fake(mux.listing);
		const handles = [
			pane(mux.id, mux.listed, "/run/one"),
			pane(mux.id, mux.missing, "/run/one"),
		];

		const out = await mux.make().probe(handles);

		expect(said(out, handles)).toEqual(["present", "absent"]);
	});

	it("says unknown for every pane of a server that will not answer", async () => {
		fake("exit 1");
		const handles = [pane(mux.id, mux.listed, "/run/one")];

		expect(said(await mux.make().probe(handles), handles)).toEqual(["unknown"]);
	});

	it("says unknown for a pane on another host or recorded without its server", async () => {
		fake(mux.listing);
		const handles = [
			pane(mux.id, mux.listed, "/run/one", "elsewhere"),
			pane(mux.id, mux.listed, ""),
		];

		expect(said(await mux.make().probe(handles), handles)).toEqual([
			"unknown",
			"unknown",
		]);
	});

	it("asks nothing once stopped, and says unknown", async () => {
		const asked = join(bin(), "asked");
		fake(`touch ${asked}; ${mux.listing}`);
		const handles = [pane(mux.id, mux.listed, "/run/one")];

		const out = await mux.make().probe(handles, AbortSignal.abort());

		expect(said(out, handles)).toEqual(["unknown"]);
		expect(() => rmSync(asked)).toThrow();
	});
});
