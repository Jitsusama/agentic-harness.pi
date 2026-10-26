/**
 * Fake terminals for the planning and opening tests: drivers that
 * record what they were asked and sight themselves from variables the
 * test sets, so no real terminal is involved.
 */

import type {
	LauncherSpec,
	TerminalDriver,
	TerminalKind,
	TerminalLaunchCapability,
	TerminalLayout,
	TerminalRequest,
	TerminalSessionHandle,
	TerminalTypeCapability,
} from "../../../lib/terminal/index.ts";

/** What a fake driver was asked to do. */
export interface FakeCalls {
	spawned: TerminalRequest[];
	launched: TerminalRequest[];
	typed: { handle: TerminalSessionHandle; text: string }[];
}

/** A fake deep driver, sighted when `env[<ID>_PANE]` is set. */
export function fakeDriver(
	id: string,
	options: {
		kind?: TerminalKind;
		layouts?: TerminalLayout[];
		launch?: boolean;
		failSpawn?: boolean;
		failLaunch?: boolean;
	} = {},
): TerminalDriver &
	TerminalTypeCapability &
	Partial<TerminalLaunchCapability> & { calls: FakeCalls } {
	const calls: FakeCalls = { spawned: [], launched: [], typed: [] };
	let next = 100;
	const handle = (scope: string): TerminalSessionHandle => ({
		driverId: id,
		kind: `${id}-pane`,
		hostId: "host",
		scope,
		value: String(next++),
	});
	const variable = `${id.toUpperCase()}_PANE`;
	const layouts = options.layouts ?? ["window", "tab", "pane"];
	return {
		id,
		kind: options.kind ?? "emulator",
		binary: id,
		programs: [id],
		layouts: Object.fromEntries(layouts.map((layout) => [layout, layout])),
		available: () => true,
		sight(env) {
			const pane = env[variable];
			if (!pane) return undefined;
			return {
				driverId: id,
				handle: {
					driverId: id,
					kind: `${id}-pane`,
					hostId: "host",
					scope: `${id}-sock`,
					value: pane,
				},
				reachable: env[`${id.toUpperCase()}_SOCK`] !== "none",
				source: "environment",
			};
		},
		async spawn(request) {
			calls.spawned.push(request);
			if (options.failSpawn) throw new Error(`${id} refused`);
			return handle(request.near?.scope ?? `${id}-sock`);
		},
		...(options.launch
			? {
					async launch(request) {
						calls.launched.push(request);
						if (options.failLaunch) throw new Error(`${id} would not launch`);
						return handle(`${id}-launched`);
					},
				}
			: {}),
		async typeInto(target, text) {
			calls.typed.push({ handle: target, text });
		},
		calls,
	};
}

/** A launcher whose binary is the id itself. */
export function fakeLauncher(id: string, tab = false): LauncherSpec {
	return {
		id,
		binary: id,
		window: ["--cwd={cwd}", "--", "{argv}"],
		...(tab ? { tab: ["--tab", "--", "{argv}"] } : {}),
	};
}

/** A locate that finds exactly the named binaries, at /bin/<name>. */
export function locating(...found: string[]) {
	return (_id: string, name: string) =>
		found.includes(name) ? `/bin/${name}` : undefined;
}
