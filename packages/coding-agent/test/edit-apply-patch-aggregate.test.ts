/**
 * Regression test for the multi-file apply_patch aggregate result contract:
 *
 * 1. Once any per-file entry fails, later entries MUST NOT run — later entries
 *    were authored against the assumption that this file's edit landed and can
 *    compound damage after a failure.
 * 2. The aggregate `AgentToolResult` MUST carry top-level `isError: true` so
 *    the agent loop sees the tool call as failed instead of falling through to
 *    the success branch, which would hide the partial application.
 * 3. The content text MUST enumerate applied and not-applied paths so the
 *    model can re-read and retry only the missing work.
 *
 * See can1357/oh-my-pi#4023 for the reported failure mode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, type EditToolDetails } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-apply-patch-aggregate-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("apply_patch mode — multi-file aggregate on failure", () => {
	test("stops after first failure, marks aggregate isError, reports applied/not-applied", async () => {
		await Bun.write(path.join(tempDir, "a.txt"), "a\n");
		// c.txt intentionally exists so an unfixed loop would OVERWRITE it —
		// making the "third entry ran" regression easy to detect.
		await Bun.write(path.join(tempDir, "c.txt"), "c-original\n");

		const tool = new EditTool(makeSession(tempDir));

		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-a",
			"+A",
			"*** Update File: missing.txt",
			"@@",
			"-x",
			"+y",
			"*** Update File: c.txt",
			"@@",
			"-c-original",
			"+C-NEW",
			"*** End Patch",
		].join("\n");

		const result = await tool.execute("call-mixed", { input: patch });

		// (1) Top-level isError set — this is what the agent loop reads.
		expect(result.isError).toBe(true);

		// (2) Third entry did NOT run: pre-existing c.txt is untouched.
		expect(await Bun.file(path.join(tempDir, "c.txt")).text()).toBe("c-original\n");

		// First entry landed before the failure (per-file, in-order).
		expect(await Bun.file(path.join(tempDir, "a.txt")).text()).toBe("A\n");

		// missing.txt never existed and still doesn't.
		expect(await Bun.file(path.join(tempDir, "missing.txt")).exists()).toBe(false);

		// (3) Content enumerates applied/not-applied so the model can retry.
		const contentText = result.content?.find(c => c.type === "text")?.text ?? "";
		expect(contentText).toContain("Error editing");
		expect(contentText).toContain("missing.txt");
		expect(contentText).toMatch(/Applied:.*a\.txt/);
		expect(contentText).toMatch(/Not applied:.*c\.txt/);

		// Per-file results include an error marker on the failing entry only.
		const details = result.details as EditToolDetails;
		const perFile = details.perFileResults;
		expect(perFile?.length).toBe(2); // stopped after the failing one
		expect(perFile?.[0].isError).toBeFalsy();
		expect(perFile?.[1].isError).toBe(true);
	});

	test("all-success multi-file apply_patch has no top-level isError", async () => {
		await Bun.write(path.join(tempDir, "a.txt"), "a\n");
		await Bun.write(path.join(tempDir, "b.txt"), "b\n");

		const tool = new EditTool(makeSession(tempDir));

		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-a",
			"+A",
			"*** Update File: b.txt",
			"@@",
			"-b",
			"+B",
			"*** End Patch",
		].join("\n");

		const result = await tool.execute("call-all-good", { input: patch });

		expect(result.isError).toBeUndefined();
		expect(await Bun.file(path.join(tempDir, "a.txt")).text()).toBe("A\n");
		expect(await Bun.file(path.join(tempDir, "b.txt")).text()).toBe("B\n");
	});
});
