/**
 * What a participant id means, and keeping it meaning that.
 *
 * A finding's origin names the reviewer that raised it, and a
 * reader trusts that name to identify one thing. Let an id be
 * re-pointed at a different model halfway through and every origin
 * recorded before the change quietly starts lying, with nothing on
 * the record to say so. So an id that has produced findings is
 * held to what it meant.
 *
 * The ledger is told the findings rather than going to look for
 * them. What counts as attributed is a fact about a finding, and a
 * module that had to know where findings are stored would be
 * answerable to every future place they might be.
 */

import type { Finding } from "../finding.js";

/** What a participant was doing when it raised something. */
export type ParticipantRole = "reviewer" | "judge";

/** How a participant is configured. */
export interface Participant {
	id: string;
	model?: string;
	thinkingLevel?: string;
	tools?: readonly string[];
	persona?: string;
	/**
	 * Clocks this one keeps, where the round's do not suit it.
	 *
	 * One number for a whole fan-out has to be sized for its slowest
	 * member, so a roster mixing a small fast model with a large one at
	 * high thinking either holds slots the fast reviewers do not need
	 * or cuts the slow one off mid-thought.
	 *
	 * Not part of the identity below, deliberately. What a reviewer was
	 * set to think with decides what its findings mean and is held for
	 * the session; how long it was allowed to take does not change what
	 * it said, and holding an id to a clock would refuse the one
	 * adjustment a reader makes after being told a reviewer ran out of
	 * time.
	 */
	backstopMs?: number;
	idleMs?: number;
	answerMs?: number;
}

/** The clocks a participant may keep for itself. */
export type ParticipantClocks = Pick<
	Participant,
	"backstopMs" | "idleMs" | "answerMs"
>;

/** What an id has been taken to mean. */
export interface ParticipantIdentity {
	id: string;
	role: ParticipantRole;
	model?: string;
	thinkingLevel?: string;
	tools?: readonly string[];
	persona?: string;
}

/** Claiming an id either holds it or explains what to do instead. */
export type ClaimOutcome = { held: ParticipantIdentity } | { refusal: string };

/** Which ids mean what, for the life of a session. */
export interface IdentityLedger {
	/**
	 * Take an id for a participant, given the findings raised so
	 * far. Refuses only where a claimed id would change meaning
	 * with findings already attributed to it.
	 */
	claim(
		role: ParticipantRole,
		participant: Participant,
		findings: readonly Finding[],
	): ClaimOutcome;
	/** Free an id, reporting whether it was held. */
	release(id: string): boolean;
	/** Every id currently held, in the order first claimed. */
	held(): ParticipantIdentity[];
}

/**
 * Reduce a participant's config to the identity it claims.
 *
 * Absent fields are left out rather than set undefined, so two
 * identities compare equal when they say the same thing, and a
 * reader is never shown a key that was never configured.
 */
export function participantIdentity(
	role: ParticipantRole,
	participant: Participant,
): ParticipantIdentity {
	return {
		id: participant.id,
		role,
		...(participant.model === undefined ? {} : { model: participant.model }),
		...(participant.thinkingLevel === undefined
			? {}
			: { thinkingLevel: participant.thinkingLevel }),
		...(participant.tools === undefined
			? {}
			: { tools: [...participant.tools] }),
		...(participant.persona === undefined
			? {}
			: { persona: participant.persona }),
	};
}

/**
 * Whether a finding names this id, as its author or as agreement.
 *
 * A consolidating pass records which reviewers raised the same
 * thing, and those ids are as referenced as the author's: a
 * release that ignored them would report that nothing points at an
 * id while several findings name it.
 */
export function attributedTo(finding: Finding, id: string): boolean {
	const origin = finding.origin;
	if (origin.kind !== "hand" && origin.reviewerId === id) return true;
	return finding.raisedBy?.includes(id) ?? false;
}

/** A fresh ledger, holding nothing. */
export function createIdentityLedger(): IdentityLedger {
	const identities = new Map<string, ParticipantIdentity>();

	return {
		claim(role, participant, findings) {
			const next = participantIdentity(role, participant);
			const existing = identities.get(participant.id);
			if (existing && !same(existing, next)) {
				// An id nothing points at can be re-pointed in silence.
				// The trail only matters where there is output to
				// attribute, and refusing otherwise would make fixing a
				// roster typo a chore.
				if (findings.some((f) => attributedTo(f, participant.id))) {
					return { refusal: refuse(existing, next) };
				}
				identities.delete(participant.id);
			}
			identities.set(participant.id, next);
			return { held: next };
		},

		release(id) {
			return identities.delete(id);
		},

		held() {
			return [...identities.values()];
		},
	};
}

/** Whether two identities say the same thing. */
function same(left: ParticipantIdentity, right: ParticipantIdentity): boolean {
	return (
		left.id === right.id &&
		left.role === right.role &&
		left.model === right.model &&
		left.thinkingLevel === right.thinkingLevel &&
		left.persona === right.persona &&
		sameTools(left.tools, right.tools)
	);
}

/**
 * Whether two tool palettes grant the same thing.
 *
 * Compared as sets: what a reviewer can reach is what changes its
 * answers, and the order they were listed in does not. Refusing on
 * a reordering would be a false alarm about a roster nobody
 * meaningfully edited.
 */
function sameTools(
	left: readonly string[] | undefined,
	right: readonly string[] | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.length !== right.length) return false;
	const held = new Set(left);
	return right.every((tool) => held.has(tool));
}

/**
 * The refusal, which names both ways out.
 *
 * One is to use another id, which keeps the trail exact. The other
 * is to release this one, which does not, and saying so plainly is
 * what makes it a choice rather than a workaround someone finds
 * later.
 */
function refuse(
	existing: ParticipantIdentity,
	next: ParticipantIdentity,
): string {
	return (
		`The id "${existing.id}" already means ${describe(existing)}, ` +
		`and findings are attributed to it. Asking it to mean ` +
		`${describe(next)} would change what those findings say about ` +
		`who raised them. Use a different id for ${describe(next)}, or ` +
		`release "${existing.id}" to accept that its findings become ` +
		`ambiguous about which participant they came from.`
	);
}

/** An identity in words, for a sentence a person reads. */
function describe(identity: ParticipantIdentity): string {
	const parts: string[] = [identity.role];
	if (identity.persona) parts.push(`persona ${identity.persona}`);
	if (identity.model) parts.push(`model ${identity.model}`);
	if (identity.thinkingLevel) parts.push(`thinking ${identity.thinkingLevel}`);
	if (identity.tools) parts.push(`tools ${identity.tools.join(", ")}`);
	return parts.join(" · ");
}
