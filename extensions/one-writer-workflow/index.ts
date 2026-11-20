/**
 * One Writer Workflow: a plain pi refuses a conversation a host holds,
 * open now or kept for its next start, so no log ever has two writers.
 *
 * At each session start in plain pi, the conversation is looked up in
 * the lists and rosters the machine's hosts keep
 * (lib/internal/session/writer-hold.ts). Held by one, the pi says which
 * host holds it and how to reach it there, takes no prompt, and ends
 * with HELD_ELSEWHERE_EXIT. In its terminal, under a holder that runs it
 * itself, it hands that window to the host's view instead and ends as a
 * park, so the window shows the conversation rather than closing: on 19
 * November four windows opened on plain pi closed within seconds this
 * way. A hosted conversation is its host's own, and a session with no log
 * has none to share, so neither is looked up.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hosted } from "../../lib/core/session/host.ts";
import {
	goQuiet,
	handingOf,
	toldHolder,
} from "../../lib/internal/session/hand-over.ts";
import {
	type HostHold,
	heldByHost,
	viewWords,
} from "../../lib/internal/session/host-holds.ts";
import { HELD_ELSEWHERE_EXIT } from "../../lib/internal/session/one-writer.ts";
import { holderCommand, promptIn } from "../../lib/internal/session/park.ts";
import {
	type WriterLooking,
	writerHold,
} from "../../lib/internal/session/writer-hold.ts";

/** This pi's own process, as a hand-over reads it; a test gives its own. */
export interface OwnProcess {
	readonly env?: NodeJS.ProcessEnv;
	readonly pid?: number;
	/** The arguments pi was started with. */
	readonly args?: readonly string[];
	/** Go quiet on the terminal and end as a park; a test says otherwise. */
	readonly quiet?: () => void;
}

/** The extension, looking where `looking` says; the machine's unless a test sets it. */
export function oneWriterWorkflow(looking: WriterLooking & OwnProcess = {}) {
	return (pi: ExtensionAPI) => {
		// Set once this pi refused its conversation; nothing is taken after.
		let refused = false;
		pi.on("session_start", async (event, ctx) => {
			if (hosted() || ctx.sessionManager.getSessionFile() === undefined) return;
			const sessionId = ctx.sessionManager.getSessionId();
			const hold = await writerHold(sessionId, looking);
			if (!hold) return;
			refused = true;
			const startup = event.reason === "startup";
			if (
				ctx.mode === "tui" &&
				handedOver(ctx, sessionId, hold, { ...looking, startup })
			)
				return;
			refuse(ctx, heldByHost(sessionId, hold));
		});
		// A prompt given on the command line, or typed before the end lands.
		pi.on("input", () =>
			refused ? { action: "handled" as const } : undefined,
		);
	};
}

/**
 * Hand this pi's window to its host's view, as a launcher opens one on a
 * hosted conversation, and end as a park, so the holder starts the view
 * at once in the same window. Only a pi its holder runs itself, with a
 * log, no prompt at start-up and no flags plain pi would drop should the
 * view fall back to it, on a hold its host can still run; false for any
 * other, or when the holder's files can't be written, leaving neither.
 * It goes quiet first, as a move does, so pi's last frame stays until
 * the view draws over it: no restored screen, resume hint or notice
 * flashes in between, which the view's first frame would wipe anyway.
 */
function handedOver(
	ctx: ExtensionContext,
	sessionId: string,
	hold: HostHold,
	own: OwnProcess & { readonly startup: boolean },
): boolean {
	const env = own.env ?? process.env;
	const args = own.args ?? process.argv.slice(2);
	const handing = handingOf({
		env,
		pid: own.pid ?? process.pid,
		args,
		sessionFile: ctx.sessionManager.getSessionFile(),
	});
	if (handing === undefined) return false;
	// A stranded hold's remedy is a host restart only the refusal names,
	// and a prompt given at start-up would be lost once the view takes
	// over; a later start, as a resume, sent that prompt long before.
	if (hold.stranded || (own.startup && promptIn(args))) return false;
	const view = viewWords(
		sessionId,
		holderCommand(handing.sessionFile, args, env),
	);
	const told = toldHolder(handing.files, view, {
		session: sessionId,
		view: true,
		at: new Date().toISOString(),
	});
	// A holder that can't be told what's next ends with its window on a
	// refusal, which still says how to reach the conversation.
	if (!told) return false;
	(own.quiet ?? goQuiet)();
	ctx.shutdown();
	return true;
}

/**
 * End this pi, saying why. In its terminal, pi's own shutdown puts the
 * screen back first and an exit listener sets the code, as a park does;
 * elsewhere pi's shutdown waits for a command or run that must not come,
 * so it exits at once.
 */
function refuse(ctx: ExtensionContext, line: string): void {
	if (ctx.mode === "tui") {
		ctx.ui.notify(line, "error");
		// pi ends a quit with process.exit(0); an exit listener's code wins.
		process.once("exit", () => {
			process.exitCode = HELD_ELSEWHERE_EXIT;
			process.stderr.write(`\r\n${line}\r\n`);
		});
		ctx.shutdown();
		return;
	}
	process.stderr.write(`${line}\n`);
	process.exit(HELD_ELSEWHERE_EXIT);
}

export default oneWriterWorkflow();
