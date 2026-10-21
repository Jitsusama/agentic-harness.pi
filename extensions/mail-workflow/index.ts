/**
 * Mail between the pi sessions on one machine, as context rather than
 * a prompt, over networks a session chooses to be on.
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
 *
 * Meant for whoever it concerns and no one else. Sessions work towards
 * different ends, so beside the global channel every session is on
 * there are named channels a session joins (lib/mail/channels.ts), and
 * a sender picks the narrowest audience that reaches everyone affected.
 * Each mail says what it asks of its readers, as a kind, so a reader
 * knows whether to answer, note it, or simply know it.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import {
	channelName,
	createMemberships,
	hears,
	type Membership,
} from "../../lib/mail/channels.ts";
import {
	clock,
	createMailbox,
	isFor,
	isMailFile,
	kindOf,
	MAIL_KINDS,
	type Mail,
	type Mailbox,
	type MailKind,
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
 * What the model is told after every delivery.
 *
 * Said every time rather than once in the prompt, because it is what
 * stops a model treating the note in front of it as the next task, and
 * the note is what it is looking at.
 */
export const ADVISORY =
	"Mail is context, not a new task: keep on with what you were doing. It needs no acknowledgement, and no mention to the person unless it changes what you are doing for them.";

/** What each kind asks of its reader, said only for the kinds present. */
export const ASKS: Readonly<Record<MailKind, string>> = {
	hold: "A hold: do not start what it names until its sender says the hold is over. Reply with mail_send only if you are already in the middle of it or cannot hold.",
	question:
		"A question: answer its sender with mail_send, briefly, then carry on.",
	finding:
		"A finding: if you own what it is about, note it in your plan or journal and act on it in its turn; if you do not, let it go. No reply.",
	fyi: "An fyi: context only. No reply and no action.",
};

/**
 * The most messages one mail_read hands back.
 *
 * Mail is short by request, so this keeps the answer to a few
 * thousand characters rather than the whole history.
 */
const MOST_READ = 50;

/** What mail_send hands back beside its words. */
interface SendDetails {
	readonly sent: boolean;
	/** The channels nobody else is on, when that is why it was not sent. */
	readonly empty?: readonly string[];
	readonly mail?: Mail;
	/** The sessions it reaches, by the name each signs with. */
	readonly reached?: readonly string[];
}

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
			`Mail (${kindOf(mail)}) from ${mail.from} to ${mail.to.join(", ")} at ${clock(mail.at)}:\n\n${mail.text}`,
	);
	const kinds = MAIL_KINDS.filter((kind) =>
		mails.some((mail) => kindOf(mail) === kind),
	);
	return [...each, kinds.map((kind) => ASKS[kind]).join(" "), ADVISORY].join(
		"\n\n",
	);
}

/**
 * The sessions, other than this one, that a message would reach, by
 * the name each signs with. Read from the memberships, so a session
 * still on the interim mailbox, which keeps none, is not counted.
 */
function reach(
	mail: Mail,
	everyone: readonly Membership[],
	self: string,
): string[] {
	return everyone
		.filter((one) => one.session !== self && one.names.length > 0)
		.filter((one) => isFor(mail, one.names, -1, one.channels))
		.map((one) => one.names[0] as string);
}

/**
 * Whether this pi is a fleet's subagent, which the supervisor marks in
 * the environment it starts the child with.
 *
 * A subagent is a worker inside another session's turn, answering to
 * that session alone: on the mailbox it would be handed the machine's
 * coordination in the middle of its one job, and would show up as a
 * session other senders reach.
 */
export function isSubagent(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.SUBAGENT_SUPERVISOR === "1" || Boolean(env.SUBAGENT_RUN_ID);
}

/** The extension, reading and writing mail at these paths. */
export function mailWorkflow(
	paths: MailPaths = machinePaths(),
	env: NodeJS.ProcessEnv = process.env,
) {
	return (pi: ExtensionAPI) => {
		// Not on the mailbox at all: see isSubagent.
		if (isSubagent(env)) return;
		const mailbox: Mailbox = createMailbox(paths.box);
		const memberships = createMemberships(join(paths.box, ".members"));
		let ctx: ExtensionContext | undefined;
		let session = "";
		let names: string[] = [];
		let channels: string[] = [];
		let watcher: FSWatcher | undefined;
		// Every file already looked at, so a watcher that reports one
		// file twice, as inotify does for a rename, hands it over once.
		const seen = new Set<string>();

		/** Named afresh, since loading another quest renames a session. */
		const rename = () => {
			if (!ctx) return;
			session = ctx.sessionManager.getSessionId();
			names = namesFor(session, paths);
			channels = [...memberships.of(session).channels];
			keep();
		};
		const keep = () => {
			try {
				memberships.keep({ session, names, channels });
			} catch {
				// Unkept, this session still hears its channels until it ends;
				// it is only other senders who cannot see it there.
			}
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
			if (!mail || !isFor(mail, names, process.pid, channels)) {
				return undefined;
			}
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
				const on =
					channels.length > 0
						? `, on ${channels.map((c) => `#${c}`).join(", ")}`
						: "";
				started.ui.notify(
					`Mailbox: this session is ${names.join(" or ")}${on}`,
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
				"Message other pi sessions on this machine without interrupting them: mail joins their conversation as context. Send only what changes what another session should do (a hold before a reboot, a switch, a merge or a heavy build; a question only it can answer) or what concerns something it owns (a finding). Never send progress, acknowledgements or thanks. Address the narrowest audience that reaches everyone affected: a session by its quest name (P9R1KI), a channel (#harness), or all, which is only for what touches every session on the machine. mail_channels lists the channels and who is on them.",
			parameters: Type.Object({
				to: Type.String({
					description:
						"Comma-separated: session names such as P9R1KI, channels such as #harness, or all",
				}),
				kind: StringEnum(MAIL_KINDS, {
					description:
						"hold: put off something until you say it is over; question: wants an answer; finding: for whoever owns what it is about; fyi: context only",
				}),
				text: Type.String({
					description: "The message, plain and short, standing on its own",
				}),
			}),
			async execute(_id, params) {
				rename();
				const to = recipients(params.to);
				const everyone = memberships.all();
				// A channel nobody is on reaches nobody, now or later, so it is
				// refused rather than sent to be lost.
				const empty = to
					.filter((one) => one.startsWith("#"))
					.filter(
						(one) =>
							channelName(one) === undefined ||
							!everyone.some(
								(member) =>
									member.session !== session &&
									hears(member.channels, one.slice(1)),
							),
					);
				if (empty.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Not sent: no other session is on ${empty.join(", ")}. ${channelsText(everyone, session, channels)}`,
							},
						],
						details: { sent: false, empty } as SendDetails,
					};
				}
				const mail: Mail = {
					at: new Date().toISOString(),
					from: names[0] ?? `PID${process.pid}`,
					to,
					text: params.text,
					kind: params.kind,
					pid: process.pid,
				};
				seen.add(mailbox.send(mail));
				const reached = reach(mail, everyone, session);
				const known = new Set(everyone.flatMap((one) => one.names));
				const unknown = to.filter(
					(one) => one !== "ALL" && !one.startsWith("#") && !known.has(one),
				);
				const notes = [
					reached.length > 0
						? `It reaches ${reached.join(", ")}.`
						: "No session on this mailbox is reached by it yet.",
					unknown.length > 0
						? `No session here goes by ${unknown.join(", ")}; one still on the interim mailbox may, and one never will if the name is wrong.`
						: "",
				].filter(Boolean);
				return {
					content: [
						{
							type: "text",
							text: `Sent as ${mail.from}: ${oneLine(mail)}\n${notes.join(" ")}`,
						},
					],
					details: { sent: true, mail, reached } as SendDetails,
				};
			},
		});

		pi.registerTool({
			name: "mail_read",
			label: "Mail",
			description:
				"Read the latest mail this session can hear, and what it sent, to catch up after a reload or compaction.",
			parameters: Type.Object({
				count: Type.Optional(
					Type.Number({
						description: `How many of the latest to show; default 15, at most ${MOST_READ}`,
					}),
				),
			}),
			async execute(_id, params) {
				rename();
				const wanted = Math.min(
					MOST_READ,
					Math.max(1, Math.floor(params.count ?? 15)),
				);
				const latest = mailbox
					.list()
					.map((file) => mailbox.read(file))
					.filter((mail): mail is Mail => mail !== undefined)
					.filter(
						(mail) =>
							mail.pid === process.pid ||
							names.includes(mail.from) ||
							isFor(mail, names, -1, channels),
					)
					.slice(-wanted);
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

		pi.registerTool({
			name: "mail_join",
			label: "Mail",
			description:
				"Join a mail channel, so this session hears what is sent to it and to its parents. Join the channels for the work this session does (#harness, #optimus/power), not every channel there is.",
			parameters: Type.Object({
				channel: Type.String({
					description:
						"A channel such as #harness, or a sub-channel such as #optimus/power",
				}),
			}),
			async execute(_id, params) {
				rename();
				const name = channelName(params.channel);
				if (name === undefined) {
					return refusal(
						`${params.channel} is not a channel name: use letters, digits and dashes, with / between a channel and its sub-channel, as #optimus/power. Everyone is on the global channel already.`,
					);
				}
				if (!channels.includes(name)) channels = [...channels, name].sort();
				keep();
				return {
					content: [
						{
							type: "text",
							text: `On #${name}. ${channelsText(memberships.all(), session, channels)}`,
						},
					],
					details: { channels },
				};
			},
		});

		pi.registerTool({
			name: "mail_leave",
			label: "Mail",
			description:
				"Leave a mail channel this session no longer works on, so its mail stops reaching it.",
			parameters: Type.Object({
				channel: Type.String({ description: "The channel to leave" }),
			}),
			async execute(_id, params) {
				rename();
				const name = channelName(params.channel);
				const was = name !== undefined && channels.includes(name);
				if (was) channels = channels.filter((one) => one !== name);
				keep();
				return {
					content: [
						{
							type: "text",
							text: was
								? `Left #${name}. ${channelsText(memberships.all(), session, channels)}`
								: `Not on ${params.channel}, so nothing changed. ${channelsText(memberships.all(), session, channels)}`,
						},
					],
					details: { channels },
				};
			},
		});

		pi.registerTool({
			name: "mail_channels",
			label: "Mail",
			description:
				"List the mail channels, who is on each, and which this session is on.",
			parameters: Type.Object({}),
			async execute(_id, _params) {
				rename();
				return {
					content: [
						{
							type: "text",
							text: channelsText(memberships.all(), session, channels),
						},
					],
					details: { channels },
				};
			},
		});
	};
}

/** Every channel with who is on it, and where this session stands. */
function channelsText(
	everyone: readonly Membership[],
	self: string,
	own: readonly string[],
): string {
	const members = new Map<string, string[]>();
	for (const one of everyone) {
		const name = one.names[0];
		if (!name) continue;
		const list = one.session === self ? own : one.channels;
		for (const channel of list) {
			members.set(channel, [...(members.get(channel) ?? []), name]);
		}
	}
	const lines = [...members.keys()]
		.sort()
		.map((channel) => `#${channel}: ${members.get(channel)?.join(", ")}`);
	const mine =
		own.length > 0
			? `This session is on ${own.map((one) => `#${one}`).join(", ")}, and global.`
			: "This session is on global only.";
	return lines.length > 0
		? `${mine}\nChannels:\n${lines.join("\n")}`
		: `${mine} No named channels yet.`;
}

/** A tool answer that did nothing, and says what would. */
function refusal(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

export default mailWorkflow();
