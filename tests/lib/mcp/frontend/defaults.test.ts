import { describe, expect, it, vi } from "vitest";
import {
	defaultWriteSignal,
	identityShape,
	makeDefaultWrap,
	makeTruncatingShape,
	nameWords,
	toAgentContent,
	WRITE_VERBS,
} from "../../../../lib/mcp/frontend/defaults.ts";
import { CANCELLED_TEXT } from "../../../../lib/mcp/render/result.ts";
import type {
	McpContent,
	McpTool,
	McpToolResult,
} from "../../../../lib/mcp/types.ts";

function tool(name: string, annotations?: McpTool["annotations"]): McpTool {
	return {
		serverId: "s",
		name,
		description: "",
		inputSchema: { type: "object" },
		annotations,
		raw: {},
	};
}

function result(
	content: McpContent[],
	extra: Partial<McpToolResult> = {},
): McpToolResult {
	return { content, ...extra };
}

/**
 * One real tool name for each word `WRITE_VERBS` lists, each holding no
 * other listed word, so taking any word out of the list in `defaults.ts`
 * fails its own row, and a word added without a row fails the pairing case.
 */
const ONE_NAME_PER_WORD = [
	"create_issue",
	"update_record",
	"delete_branch",
	"write_file",
	"append_block",
	"clear_cache",
	"insert_rows",
	"replace_text",
	"add_label",
	"remove_member",
	"send_email",
	"post_message",
	"move_card",
	"rename_file",
	"escalate_incident",
	"comment_on_issue",
	"upload_attachment",
	"edit_page",
	"modify_record",
	"patch_issue",
	"put_object",
	"set_status",
	"unset_env",
	"upsert_record",
	"save_file",
	"merge_pull_request",
	"git_commit",
	"revert_change",
	"rollback_release",
	"push_files",
	"fork_repository",
	"import_data",
	"apply_migration",
	"transitionJiraIssue",
	"close_issue",
	"reopen_issue",
	"dismiss_alert",
	"mark_as_read",
	"archive_channel",
	"unarchive_channel",
	"publish-page",
	"unpublish-page",
	"approve_request",
	"submit_form",
	"assign_issue",
	"unassignIssue",
	"invite_member",
	"share_file",
	"grant_role",
	"revokeToken",
	"transfer_funds",
	"refund_order",
	"cancel_job",
	"drop_table",
	"purge_cache",
	"destroy_stack",
	"executeQuery",
	"pods_exec",
	"run_sql",
	"invoke_function",
	"trigger_workflow",
	"deploy_site",
	"undeploy_site",
	"install_package",
	"uninstall_package",
	"enable_feature",
	"disable_feature",
	"toggle_flag",
	"lock_issue",
	"unlock_issue",
	"StartInstances",
	"StopInstances",
	"pause_project",
	"restart_service",
	"restore_project",
	"reset_password",
	"kill_process",
	"TerminateInstances",
	"scale_deployment",
	"reply_to_thread",
	"react_to_message",
	"RebootInstances",
	"shutdown_vm",
	"truncate_table",
	"wipe_device",
	"erase_disk",
	"overwrite_file",
	"fs_rm",
	"redis_del",
	"rerun_failed_jobs",
	"redeploy_service",
	"retry_job",
	"resend_invitation",
	"reassign_issue",
	"rebase_branch",
	"confirm_payment_intent",
	"void_invoice",
	"charge_customer",
	"migrate_database",
	"upgrade_plan",
	"subscribe_to_topic",
	"unsubscribe_from_topic",
	"follow_user",
	"unfollow_user",
	"star_repository",
	"unstar_repository",
	"pin_message",
	"unpin_message",
	"attach_volume",
	"detach_volume",
	"resume_job",
	"unpause_project",
	"reject_request",
	"decline_invitation",
	"deny_access",
	"accept_invitation",
	"rotate_api_key",
	"git_checkout",
	"git_init",
	"suspend_user",
	"clone_repository",
	"duplicate_page",
	"mute_channel",
	"unmute_channel",
	"unshare_file",
	"reinstall_package",
	"rewrite_history",
	"resubmit_form",
	"republish_page",
	"recreate_index",
	"flush_cache",
	"prune_images",
	"drain_node",
	"evict_pod",
	"acknowledge_incident",
	"kick_member",
	"ban_user",
];

describe("identityShape", () => {
	it("returns the content unchanged", () => {
		const content: McpContent[] = [{ type: "text", text: "x" }];
		expect(identityShape(result(content))).toEqual(content);
	});
});

describe("makeTruncatingShape", () => {
	it("caps a long text block and appends a marker", () => {
		const shape = makeTruncatingShape({ maxLines: 2, maxBytes: 1000 });
		const [block] = shape(result([{ type: "text", text: "1\n2\n3\n4" }]));
		expect(block?.type).toBe("text");
		expect((block as { text: string }).text).toContain("Truncated");
	});

	it("passes a short block and non-text through untouched", () => {
		const shape = makeTruncatingShape({ maxLines: 40, maxBytes: 1000 });
		const content: McpContent[] = [
			{ type: "text", text: "short" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		];
		expect(shape(result(content))).toEqual(content);
	});
});

describe("defaultWriteSignal", () => {
	it("uses a read-only or destructive hint when present, ignoring the name", () => {
		expect(
			defaultWriteSignal(tool("delete_everything", { readOnlyHint: true })),
			"a read-only hint makes even delete_everything a read",
		).toBe(false);
		expect(
			defaultWriteSignal(tool("harmless", { destructiveHint: true })),
			"a destructive hint makes even harmless a write",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("harmless", { readOnlyHint: false })),
			"a read-only hint of false makes even harmless a write",
		).toBe(true);
		expect(
			defaultWriteSignal(
				tool("delete_everything", {
					readOnlyHint: true,
					destructiveHint: true,
				}),
			),
			"a read-only hint decides even beside a destructive one",
		).toBe(false);
		expect(
			defaultWriteSignal(
				tool("harmless", { readOnlyHint: false, destructiveHint: false }),
			),
			"a non-read-only tool that only adds is still a write",
		).toBe(true);
	});

	it("gates a destructive hint of false with no read-only hint", () => {
		// The spec reads a missing read-only hint as false, so this says
		// the tool writes, only by adding: a post or a create.
		expect(
			defaultWriteSignal(tool("post_comment", { destructiveHint: false })),
			"post_comment that only adds is a write",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("harmless", { destructiveHint: false })),
			"the hint decides, not the name",
		).toBe(true);
	});

	it("reads a hint that isn't a boolean as no hint", () => {
		// The connection passes a server's annotations on unchecked, so a
		// string can arrive where the spec says a boolean goes.
		const said = { readOnlyHint: "true" } as unknown as McpTool["annotations"];
		expect(
			defaultWriteSignal(tool("delete_item", said)),
			"a string read-only hint leaves delete_item a write, by its verb",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("search_items", said)),
			"a string read-only hint leaves search_items a read, by its verb",
		).toBe(false);
		const destructive = {
			destructiveHint: "true",
		} as unknown as McpTool["annotations"];
		expect(
			defaultWriteSignal(tool("harmless", destructive)),
			"a string destructive hint leaves harmless a read, by its name",
		).toBe(false);
	});

	it("falls back to a name-verb match when the annotations carry no hint", () => {
		expect(
			defaultWriteSignal(tool("delete_everything", {})),
			"empty annotations leave delete_everything a write, by its verb",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("delete_everything", { idempotentHint: true })),
			"an idempotent hint alone says nothing of writing",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("search_items", { idempotentHint: true })),
			"nor does it make search_items a write",
		).toBe(false);
		expect(
			defaultWriteSignal(tool("grokt_search_code", { openWorldHint: true })),
			"grokt_search_code, with no read or write hint, is a read by its verb",
		).toBe(false);
	});

	it("falls back to a name-verb match when no annotations exist", () => {
		expect(
			defaultWriteSignal(tool("slack_post")),
			"slack_post, by its post verb, is a write",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("grokt_search_code")),
			"grokt_search_code, by its search verb, is a read",
		).toBe(false);
	});

	it.each([
		"delete_item",
		"delete-item",
		"deleteItem",
		"DeleteItem",
		"Delete_Item",
		"DELETE_ITEM",
		"item.delete",
		"HTTPDelete",
		"v2DeleteItem",
		"delete2Items",
		"v2_delete",
		"v2delete",
	])("reads the write verb in %s in any case it is spelt", (name) => {
		expect(
			defaultWriteSignal(tool(name)),
			`${name} holds the word delete, so it is a write`,
		).toBe(true);
	});

	it.each(ONE_NAME_PER_WORD)("counts %s a write by its verb", (name) => {
		expect(
			defaultWriteSignal(tool(name)),
			`${name} names a write verb, so it is a write`,
		).toBe(true);
	});

	it("pairs each listed word with the one name only it gates", () => {
		expect(
			ONE_NAME_PER_WORD,
			"the table holds one name for each listed word",
		).toHaveLength(WRITE_VERBS.size);
		const gating = ONE_NAME_PER_WORD.map((name) =>
			nameWords(name).filter((word) => WRITE_VERBS.has(word)),
		);
		for (const [at, words] of gating.entries()) {
			expect(
				words,
				`${ONE_NAME_PER_WORD[at]} holds exactly one listed word`,
			).toHaveLength(1);
		}
		// With as many names as words, each holding one, covering every word
		// means each word is held once.
		expect(new Set(gating.flat()), "the names hold every listed word").toEqual(
			WRITE_VERBS,
		);
	});

	it("refuses to change the exported list", () => {
		const words: ReadonlySet<string> = WRITE_VERBS;
		if (!(words instanceof Set)) throw new Error("WRITE_VERBS is a Set");
		const before = [...words];
		expect(() => words.add("provision")).toThrow(/read only.*writeSignal/);
		expect(() => words.delete("delete")).toThrow(/read only/);
		expect(() => words.clear()).toThrow(/read only/);
		expect([...words], "the refusals leave the list whole").toEqual(before);
	});

	it("keeps its own words whatever an importer does to the list", () => {
		Set.prototype.delete.call(WRITE_VERBS, "delete");
		try {
			expect(
				defaultWriteSignal(tool("delete_branch")),
				"delete_branch still gates after delete is taken off the exported list",
			).toBe(true);
		} finally {
			// Back in the list, though at its end, so no case reads its order.
			Set.prototype.add.call(WRITE_VERBS, "delete");
		}
	});

	it.each([
		"get_settings",
		"listOutputs",
		"search_closed_issues",
		"readDeletedItems",
	])("leaves %s a read, matching only whole words", (name) => {
		expect(
			defaultWriteSignal(tool(name)),
			`${name} holds no write verb as a whole word, so it is a read`,
		).toBe(false);
	});

	it.each([
		"get_merge_request",
		"getPost",
		"API-post-search",
		"get_workflow_run",
	])("asks first for %s, a read holding a noun the list names", (name) => {
		// A missing word lets a write run unasked, which costs more than
		// a read asking first, so these gate on purpose.
		expect(
			defaultWriteSignal(tool(name)),
			`${name} holds a listed word as a noun, and asks first by design`,
		).toBe(true);
	});

	it.each(["get_schedule", "resolve-library-id"])(
		"leaves %s a read, by a word kept off the list",
		(name) => {
			expect(
				defaultWriteSignal(tool(name)),
				`${name}'s words are kept off the list since reads use them most, so it is a read`,
			).toBe(false);
		},
	);
});

describe("toAgentContent", () => {
	it("maps text and image blocks", () => {
		const content: McpContent[] = [
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		];
		expect(toAgentContent(result(content))).toEqual([
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});
});

describe("makeDefaultWrap", () => {
	const ctx = {} as never;
	const okResult = result([{ type: "text", text: "done" }]);

	it("calls straight through when the tool is not a write", async () => {
		const invoke = vi.fn(async () => okResult);
		const wrapped = makeDefaultWrap({ writeSignal: () => false })(
			invoke,
			tool("read_thing"),
		);
		const out = await wrapped({ a: 1 }, ctx);
		expect(invoke).toHaveBeenCalledOnce();
		expect(out.content).toEqual([{ type: "text", text: "done" }]);
	});

	it("invokes with the approved args when the gate approves", async () => {
		const invoke = vi.fn(async () => okResult);
		const showGate = vi.fn(async () => ({
			approved: true as const,
			data: { a: 2 },
		}));
		const wrapped = makeDefaultWrap({ writeSignal: () => true, showGate })(
			invoke,
			tool("write_thing"),
		);
		await wrapped({ a: 1 }, ctx);
		expect(invoke).toHaveBeenCalledWith({ a: 2 }, undefined);
	});

	it("returns the cancel sentinel and does not invoke when cancelled", async () => {
		const invoke = vi.fn(async () => okResult);
		const showGate = vi.fn(async () => null);
		const wrapped = makeDefaultWrap({ writeSignal: () => true, showGate })(
			invoke,
			tool("write_thing"),
		);
		const out = await wrapped({ a: 1 }, ctx);
		expect(invoke).not.toHaveBeenCalled();
		expect(out.content).toEqual([{ type: "text", text: CANCELLED_TEXT }]);
	});

	it("returns the redirect note and does not invoke when redirected", async () => {
		const invoke = vi.fn(async () => okResult);
		const showGate = vi.fn(async () => ({
			approved: false as const,
			redirect: "do it differently",
		}));
		const wrapped = makeDefaultWrap({ writeSignal: () => true, showGate })(
			invoke,
			tool("write_thing"),
		);
		const out = await wrapped({ a: 1 }, ctx);
		expect(invoke).not.toHaveBeenCalled();
		expect(JSON.stringify(out.content)).toContain("do it differently");
	});

	it("passes an errored transport result through for the core to handle", async () => {
		const invoke = vi.fn(async () =>
			result([{ type: "text", text: "boom" }], { isError: true }),
		);
		const wrapped = makeDefaultWrap({ writeSignal: () => false })(
			invoke,
			tool("read_thing"),
		);
		const out = await wrapped({}, ctx);
		expect(out).toMatchObject({ isError: true });
		expect(out.content).toEqual([{ type: "text", text: "boom" }]);
	});
});
