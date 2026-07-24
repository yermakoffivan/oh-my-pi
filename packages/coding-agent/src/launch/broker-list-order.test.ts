import { describe, expect, it } from "bun:test";
import { MAX_TERMINAL_DAEMONS_LISTED, orderDaemonsForListing, reapRecoveredSnapshot } from "./broker";
import type { DaemonSnapshot, DaemonState } from "./protocol";

function snapshot(name: string, state: DaemonState, createdAt: number, exitedAt?: number): DaemonSnapshot {
	return {
		name,
		id: name,
		state,
		createdAt,
		startedAt: createdAt,
		exitedAt,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
	};
}

describe("orderDaemonsForListing", () => {
	it("surfaces active daemons ahead of exited history regardless of creation order", () => {
		const daemons = [
			snapshot("old-0", "exited", 1_000, 2_000),
			snapshot("old-1", "exited", 3_000, 4_000),
			snapshot("active", "running", 5_000),
		];
		const ordered = orderDaemonsForListing(daemons).map(d => d.name);
		expect(ordered[0]).toBe("active");
		expect(ordered).toEqual(["active", "old-1", "old-0"]);
	});

	it("orders active daemons oldest-to-newest and terminal daemons newest-exit-first", () => {
		const daemons = [
			snapshot("active-new", "ready", 6_000),
			snapshot("active-old", "running", 5_000),
			snapshot("exit-early", "exited", 1_000, 1_500),
			snapshot("exit-late", "failed", 2_000, 9_000),
		];
		expect(orderDaemonsForListing(daemons).map(d => d.name)).toEqual([
			"active-old",
			"active-new",
			"exit-late",
			"exit-early",
		]);
	});

	it("caps terminal history but never drops active daemons", () => {
		const daemons: DaemonSnapshot[] = [];
		for (let i = 0; i < MAX_TERMINAL_DAEMONS_LISTED + 20; i++) {
			daemons.push(snapshot(`exited-${i}`, "exited", i, i + 1));
		}
		daemons.push(snapshot("active", "running", 999_999));
		const ordered = orderDaemonsForListing(daemons);
		expect(ordered.length).toBe(MAX_TERMINAL_DAEMONS_LISTED + 1);
		expect(ordered[0].name).toBe("active");
		// Only the most-recently-exited history survives the cap.
		const kept = ordered.slice(1).map(d => d.name);
		expect(kept).toContain(`exited-${MAX_TERMINAL_DAEMONS_LISTED + 19}`);
		expect(kept).not.toContain("exited-0");
	});
});

describe("reapRecoveredSnapshot", () => {
	it("preserves the real exit time of already-terminal records", () => {
		const exited = snapshot("done", "exited", 1_000, 2_000);
		exited.exitReason = "process completed";
		const failed = snapshot("boom", "failed", 3_000, 4_000);

		expect(reapRecoveredSnapshot(exited, 9_000)).toBe(false);
		expect(reapRecoveredSnapshot(failed, 9_000)).toBe(false);
		expect(exited.exitedAt).toBe(2_000);
		expect(exited.exitReason).toBe("process completed");
		expect(failed.exitedAt).toBe(4_000);
		expect(failed.state).toBe("failed");
	});

	it("reaps records that were still alive at recovery time", () => {
		const running = snapshot("web", "running", 5_000);
		running.pid = 4242;

		expect(reapRecoveredSnapshot(running, 9_000)).toBe(true);
		expect(running.state).toBe("exited");
		expect(running.exitedAt).toBe(9_000);
		expect(running.exitReason).toBe("previous broker exited");
		expect(running.pid).toBeUndefined();
	});

	it("keeps the genuinely most-recent exit visible after recovery restamps live records", () => {
		// A long-lived project: many old exited daemons plus one that was still
		// running when the broker restarted (reaped to recovery time).
		const recovered: DaemonSnapshot[] = [];
		for (let i = 0; i < MAX_TERMINAL_DAEMONS_LISTED + 5; i++) {
			const s = snapshot(`old-${i}`, "exited", i * 10, i * 10 + 1);
			reapRecoveredSnapshot(s, 100_000); // no-op: already terminal
			recovered.push(s);
		}
		const lastFailed = snapshot("last-failed", "failed", 500, 5_000);
		reapRecoveredSnapshot(lastFailed, 100_000); // no-op: already terminal
		recovered.push(lastFailed);

		const kept = orderDaemonsForListing(recovered).map(d => d.name);
		expect(kept).toContain("last-failed");
	});
});
