import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { HunkSelector } from "../src/commit/agentic/state";
import { createSplitCommitTool } from "../src/commit/agentic/tools/split-commit";

async function createStagedRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "omp-issue-2098-"));
	await $`git init --initial-branch=main`.cwd(dir).quiet();
	await $`git config user.email tester@example.com`.cwd(dir).quiet();
	await $`git config user.name Tester`.cwd(dir).quiet();
	await writeFile(path.join(dir, "a.txt"), "one\n");
	await writeFile(path.join(dir, "b.txt"), "two\n");
	await $`git add a.txt b.txt`.cwd(dir).quiet();
	await $`git commit -m baseline`.cwd(dir).quiet();
	await writeFile(path.join(dir, "a.txt"), "one changed\n");
	await writeFile(path.join(dir, "b.txt"), "two changed\n");
	await $`git add a.txt b.txt`.cwd(dir).quiet();
	return dir;
}

async function evaluateSelector(hunks: HunkSelector) {
	const dir = await createStagedRepo();
	try {
		const state = {};
		const tool = createSplitCommitTool(dir, state, []);
		const context = {
			sessionManager: undefined!,
			modelRegistry: undefined!,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort() {},
		};
		return await tool.execute(
			"call-1",
			{
				commits: [
					{
						changes: [{ path: "a.txt", hunks }],
						type: "chore",
						scope: null,
						summary: "updated alpha",
					},
					{
						changes: [{ path: "b.txt", hunks: { type: "all" } }],
						type: "chore",
						scope: null,
						summary: "updated beta",
					},
				],
			},
			undefined,
			context,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("issue #2098 split commit hunk selector validation", () => {
	it("rejects an out-of-range hunk index before storing a proposal", async () => {
		const result = await evaluateSelector({ type: "indices", indices: [2] });

		expect(result.details.valid).toBe(false);
		expect(result.details.proposal).toBeUndefined();
		expect(result.details.errors).toContain("Commit 1: hunk index out of range for a.txt");
	});

	it("rejects a line range that overlaps no parsed hunk", async () => {
		const result = await evaluateSelector({ type: "lines", start: 100, end: 110 });

		expect(result.details.valid).toBe(false);
		expect(result.details.proposal).toBeUndefined();
		expect(result.details.errors).toContain("Commit 1: line range selects no hunks for a.txt");
	});
});
