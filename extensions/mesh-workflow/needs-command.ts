/**
 * /needs: what waits on the person, in the window he is in, and the acts
 * he can take on it there (Joel, 24 November: "any interface i'm in
 * should be directly engagable to a meaningful level"). He picks a cell
 * that needs him and goes to it, where he answers it as the launcher
 * lets him; or picks a look and opens or clears it.
 *
 * Only he runs it: a command is typed, never called by the model, and
 * the model's own tool for this (person_needs) only reads. Answering a
 * want from here waits on the node taking a person's word from a pi
 * session (KP0L6A, 24 November), so going to the cell is how he answers
 * for now.
 */

import { hostname } from "node:os";
import type {
	ExtensionAPI,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { clearLook, type Look, openLook } from "../../lib/mesh/looks/looks.ts";
import type { Need } from "../../lib/mesh/needs.ts";
import { oneLine } from "../../lib/mesh/one-line.ts";
import type { SaidTo } from "../../lib/mesh/said-to.ts";
import { lookLine, needLine, saidLine, whatWaits } from "./tools/person.ts";

/** How long opening a link may take before it counts as failed. */
const OPEN_TIMEOUT_MS = 10_000;

/** What /needs acts through. */
export interface NeedsDeps {
	readonly exec: ExtensionAPI["exec"];
	/** The person's looks folder, when this pi keeps one. */
	readonly looks: string | undefined;
	readonly ui: Pick<ExtensionUIContext, "select" | "notify">;
	readonly now?: () => number;
	/** This machine's short name, for a cell that names none. */
	readonly machine?: string;
}

/** One row he can pick: a cell's want, a look, or what he said to one. */
type Row =
	| { readonly label: string; readonly need: Need }
	| { readonly label: string; readonly look: Look }
	| { readonly label: string; readonly said: SaidTo };

/** The acts a look offers. */
const OPEN = "Open it";
const GO = "Go to the session that pointed";
const CLEAR = "Clear it";
const LEAVE = "Leave it";

/** Show what waits on the person, and take the act he picks. */
export async function needsCommand(deps: NeedsDeps): Promise<void> {
	const now = deps.now?.() ?? Date.now();
	const waits = await whatWaits(deps.exec, deps.looks, now);
	if (!waits.needs.ok) {
		deps.ui.notify(
			`The cells couldn't be read: ${waits.needs.reason}`,
			"warning",
		);
	}
	const needs = waits.needs.ok ? waits.needs.needs : [];
	const rows: Row[] = [
		...needs.map((need) => ({ label: needLine(need, now), need })),
		...waits.looks.map((look) => ({ label: `Look: ${lookLine(look)}`, look })),
		...(waits.said.ok ? waits.said.said : []).map((said) => ({
			label: `You said ${saidLine(said, now)}`,
			said,
		})),
	].map((row, index) => ({ ...row, label: `${index + 1}. ${row.label}` }));
	if (rows.length === 0) {
		deps.ui.notify("Nothing waits on you.", "info");
		return;
	}
	const picked = await deps.ui.select("What waits on you", [
		...rows.map((row) => row.label),
	]);
	const row = rows.find((one) => one.label === picked);
	if (!row) return;
	if ("need" in row) {
		await goTo(deps, row.need.name, row.need.machine);
		return;
	}
	if ("said" in row) {
		await goTo(deps, row.said.address, row.said.machine);
		return;
	}
	await actOnLook(deps, row.look);
}

/** Take the act he picks on `look`. */
async function actOnLook(deps: NeedsDeps, look: Look): Promise<void> {
	if (!deps.looks) return;
	const cell = look.cell ?? look.address;
	const acts = [OPEN, ...(cell ? [GO] : []), CLEAR, LEAVE];
	const act = await deps.ui.select(oneLine(look.title), acts);
	if (act === OPEN) {
		const opened =
			look.kind === "terminal"
				? await goTo(deps, cell ?? look.target, undefined)
				: await open(deps, look.target);
		if (opened) openLook(deps.looks, look.id);
	} else if (act === GO && cell) {
		await goTo(deps, cell, undefined);
	} else if (act === CLEAR) {
		const cleared = clearLook(deps.looks, look.id);
		deps.ui.notify(
			cleared
				? "Cleared: it's off your look list."
				: "It had already left your look list.",
			"info",
		);
	}
}

/**
 * Go to the cell `address` on `machine`, its window raised or opened, by
 * the link the map and the launcher go by. Answers whether it went.
 */
function goTo(
	deps: NeedsDeps,
	address: string,
	machine: string | undefined,
): Promise<boolean> {
	const on = machine ?? deps.machine ?? hostname().split(".")[0] ?? "";
	return open(deps, `mycelium:cell/${address}@${on}/go`);
}

/** Open `target` as the desktop opens it. Answers whether it opened. */
async function open(deps: NeedsDeps, target: string): Promise<boolean> {
	try {
		const ran = await deps.exec("xdg-open", [target], {
			timeout: OPEN_TIMEOUT_MS,
		});
		if (ran.code === 0) return true;
		deps.ui.notify(
			`It didn't open (${ran.code}): ${oneLine(ran.stderr) || target}`,
			"warning",
		);
	} catch (error) {
		deps.ui.notify(`It didn't open: ${oneLine(String(error))}`, "warning");
	}
	return false;
}
