/**
 * OpenAI Codex OAuth workspace capture. Login must record the ChatGPT
 * workspace (`chatgpt_account_id`) as the org-scoped identity qualifier and
 * the plan type as its display label; refresh results must never carry org
 * fields so the stored workspace identity is preserved verbatim by the merge
 * sites (re-keying a credential during a background refresh would silently
 * collapse same-email workspaces again).
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { exchangeCodeForToken, refreshOpenAICodexToken } from "../src/registry/oauth/openai-codex";

function makeJwt(claims: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${header}.${payload}.sig`;
}

function tokenEndpoint(body: Record<string, unknown>): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	return fn as unknown as typeof fetch;
}

describe("openai-codex OAuth workspace capture", () => {
	it("captures the workspace as orgId and the plan type as orgName at token exchange", async () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "ws-team-1", chatgpt_plan_type: "Enterprise" },
			"https://api.openai.com/profile": { email: "User@Example.com" },
		});
		const credentials = await exchangeCodeForToken(
			"code",
			"verifier",
			"http://localhost:1455/auth/callback",
			tokenEndpoint({ access_token: accessToken, refresh_token: "rt-1", expires_in: 3600 }),
		);

		expect(credentials.accountId).toBe("ws-team-1");
		expect(credentials.orgId).toBe("ws-team-1");
		expect(credentials.orgName).toBe("enterprise");
		expect(credentials.email).toBe("user@example.com");
	});

	it("falls back to the id_token for the plan label when the access token omits it", async () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "ws-personal-1" },
			"https://api.openai.com/profile": { email: "user@example.com" },
		});
		const idToken = makeJwt({
			"https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
		});
		const credentials = await exchangeCodeForToken(
			"code",
			"verifier",
			"http://localhost:1455/auth/callback",
			tokenEndpoint({ access_token: accessToken, refresh_token: "rt-1", id_token: idToken, expires_in: 3600 }),
		);

		expect(credentials.orgId).toBe("ws-personal-1");
		expect(credentials.orgName).toBe("plus");

		// No plan claim anywhere: the workspace still qualifies identity, only
		// the display label is absent.
		const unlabeled = await exchangeCodeForToken(
			"code",
			"verifier",
			"http://localhost:1455/auth/callback",
			tokenEndpoint({ access_token: accessToken, refresh_token: "rt-1", expires_in: 3600 }),
		);
		expect(unlabeled.orgId).toBe("ws-personal-1");
		expect(unlabeled.orgName).toBeUndefined();
	});

	it("refresh results never carry org fields", async () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "ws-team-1", chatgpt_plan_type: "enterprise" },
			"https://api.openai.com/profile": { email: "user@example.com" },
		});
		const credentials = await refreshOpenAICodexToken(
			"rt-old",
			tokenEndpoint({ access_token: accessToken, refresh_token: "rt-new", expires_in: 3600 }),
		);

		expect(credentials.accountId).toBe("ws-team-1");
		expect(credentials.refresh).toBe("rt-new");
		expect(credentials.orgId).toBeUndefined();
		expect(credentials.orgName).toBeUndefined();
	});
});
