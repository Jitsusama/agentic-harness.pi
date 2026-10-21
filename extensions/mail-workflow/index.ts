/**
 * Mail between the pi sessions on one machine, as context rather than
 * a prompt.
 *
 * Sessions working beside each other need to say things like "hold
 * heavy builds for twenty minutes" without typing into each other's
 * terminals, where a message lands in whatever the person is typing and
 * can answer a question left open on screen. So a message is a file in
 * a shared folder (lib/mail/), every session watches the folder, and
 * the mail meant for one is put into its conversation.
 *
 * Put in, not prompted with. Mail is something a session takes under
 * advisement, so it never starts a turn and never keeps a finished run
 * going: pi holds it while the agent works and appends it once the
 * current step's tool results are in, so the model reads it at its next
 * call and carries on, and appends it with no turn at all when the
 * session is idle. Delivered as a prompt instead, it stopped every
 * session it reached: an idle one started a turn about it, a busy one
 * picked it up as a new task at the moment it would have finished, and
 * each answered mail that needed no answer.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import {
	clock,
	createMailbox,
	isFor,
	isMailFile,
	type Mail,
	type Mailbox,
	oneLine,
	recipients,
} from "../../lib/mail/mailbox.ts";
import { type NamingPaths, namesFor } from "../../lib/mail/names.ts";

/** The customType mail is put into a conversation under. */
export const MAIL_MESSAGE = "mailbox";

/**
 * How far back a session that has never read anything catches up.
 *
 * An hour rather than the whole folder: what was said before then was
 * said to sessions that were there, and a new one handed a day of other
 * people's coordination has nothing to do with it but read it.
 */
const FIRST_CATCH_UP_MS = 60 * 60 * 1000;

/**
 * What the model is told about every delivery, after the mail itself.
 *
 * Said every time rather than once in the prompt, because it is what
 * stops a model treating the note in front of it as the next task, and
 * the note is what it is looking at.
 */
export const ADVISORY =
	"This mail is for your awareness, not a new task: keep on with what you were doing. Act on it only if it asks you to hold or avoid something you are about to do, or asks you a question, and then answer with mail_send and carry on. It needs no acknowledgement, and no mention to the person unless it changes what you are doing for them.";

/**
 * The most messages one mail_read hands back.
 *
 * Mail is short by request, so this keeps the answer to a few
 * thousand characters rather than the whole history.
 */
const MOST_READ = 50;

/** Where the mail and the names live; the defaults are the machine's. */
export interface MailPaths extends NamingPaths {
	/** The shared folder every session writes to and watches. */
	readonly box: string;
}

/**
 * The machine's mailbox, where the interim one kept it, so sessions
 * still on that one and sessions on this one read each other's mail.
 */
export function machinePaths(): MailPaths {
	const state = process.env.XDG_STATE_HOME;
	return {
		box: join(
			state && state.length > 0 ? state : join(homedir(), ".local", "state"),
			"pi-mailbox",
		),
		sessions: join(stateDir("quest-workflow"), "sessions"),
		quests: join(dataDir("quest-workflow"), "quests"),
	};
}

/** The mail, as the model reads it. */
export function delivery(mails: readonly Mail[]): string {
	const each = mails.map(
		(mail) =>
			`Mail from ${mail.from} to ${mail.to.join(", ")} at ${clock(mail.at)}:\n\n${mail.text}`,
	);
	return `${each.join("\n\n")}\n\n${ADVISORY}`;
}

/** The extension, reading and writing mail at these paths. */
export function mailWorkflow(paths: MailPaths = machinePaths()) {
	return (pi: ExtensionAPI) => {
		const mailbox: Mailbox = createMailbox(paths.box);
		let ctx: ExtensionContext | undefined;
		let names: string[] = [];
		let watcher: FSWatcher | undefined;
		// Every file already looked at, so a watcher that reports one
		// file twice, as inotify does for a rename, hands it over once.
		const seen = new Set<string>();

		const rename = () => {
			if (ctx) names = namesFor(ctx.sessionManager.getSessionId(), paths);
		};

		const hand = (mails: readonly Mail[]) => {
			if (mails.length === 0) return;
			// Never a turn: see the header. pi appends it after the current
			// step while the agent runs, and at once while it is idle.
			pi.sendMessage(
				{
					customType: MAIL_MESSAGE,
					content: delivery(mails),
					display: true,
					details: mails,
				},
				{ triggerTurn: false },
			);
		};

		const take = (file: string): Mail | undefined => {
			if (seen.has(file)) return undefined;
			seen.add(file);
			const mail = mailbox.read(file);
			if (!mail || !isFor(mail, names, process.pid)) return undefined;
			const signing = names[0];
			if (signing) mailbox.markRead(signing, file);
			return mail;
		};

		pi.on("session_start", async (_event, started) => {
			ctx = started;
			rename();
			const since =
				mailbox.lastRead(names) ?? `${Date.now() - FIRST_CATCH_UP_MS}`;
			const missed: Mail[] = [];
			for (const file of mailbox.list()) {
				if (file <= since) {
					seen.add(file);
					continue;
				}
				const mail = take(file);
				if (mail) missed.push(mail);
			}
			hand(missed);
			watcher?.close();
			watcher = undefined;
			try {
				mkdirSync(paths.box, { recursive: true });
				watcher = watch(paths.box, (_kind, file) => {
					if (file && isMailFile(file)) {
						const mail = take(file);
						if (mail) hand([mail]);
					}
				});
			} catch (error) {
				// A folder that cannot be made or watched leaves this session
				// deaf to mail, which nothing else would show.
				if (started.hasUI) {
					started.ui.notify(
						`Mailbox: cannot watch ${paths.box} (${error instanceof Error ? error.message : String(error)}), so mail to this session will arrive only at its next start.`,
						"warning",
					);
				}
			}
			if (started.hasUI) {
				started.ui.notify(
					`Mailbox: this session is ${names.join(" or ")}`,
					"info",
				);
			}
		});

		pi.on("session_shutdown", async () => {
			watcher?.close();
			watcher = undefined;
		});

		pi.registerTool({
			name: "mail_send",
			label: "Mail",
			description:
				"Message the other pi sessions on this machine, by quest ID suffix (as P9R1KI) or 'all'. It is put into their conversation as context, without typing into their terminal or interrupting what they are doing, so send only what they should know, and keep it short.",
			parameters: Type.Object({
				to: Type.String({
					description:
						"Comma-separated recipients: quest ID suffixes such as P9R1KI, or all",
				}),
				text: Type.String({ description: "The message, plain and short" }),
			}),
			async execute(_id, params) {
				// Named afresh, since loading another quest renames a session.
				rename();
				const mail: Mail = {
					at: new Date().toISOString(),
					from: names[0] ?? `PID${process.pid}`,
					to: recipients(params.to),
					text: params.text,
					pid: process.pid,
				};
				seen.add(mailbox.send(mail));
				return {
					content: [
						{ type: "text", text: `Sent as ${mail.from}: ${oneLine(mail)}` },
					],
					details: mail,
				};
			},
		});

		pi.registerTool({
			name: "mail_read",
			label: "Mail",
			description:
				"Read the latest messages between the pi sessions on this machine, to catch up after a reload or compaction.",
			parameters: Type.Object({
				count: Type.Optional(
					Type.Number({
						description: `How many of the latest to show; default 15, at most ${MOST_READ}`,
					}),
				),
			}),
			async execute(_id, params) {
				const wanted = Math.min(
					MOST_READ,
					Math.max(1, Math.floor(params.count ?? 15)),
				);
				const latest = mailbox
					.list()
					.slice(-wanted)
					.map((file) => mailbox.read(file))
					.filter((mail): mail is Mail => mail !== undefined);
				const text =
					latest.length > 0 ? latest.map(oneLine).join("\n") : "No mail yet.";
				return {
					content: [
						{
							type: "text",
							text: `This session is ${names.join(" or ")}.\n${text}`,
						},
					],
					details: {},
				};
			},
		});
	};
}

export default mailWorkflow();
