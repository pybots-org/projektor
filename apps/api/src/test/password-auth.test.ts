import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME, signSessionToken } from "../auth/session";
import { resetAuthCachesForTests } from "../middleware/auth";
import { authHeaders, seedMember, seedToken, seedUser, seedWorkspace } from "./helpers";
import { resetRateLimits } from "./rate-limit-reset";

function extractCookiePair(setCookieHeader: string | null): string {
	if (!setCookieHeader) throw new Error("Missing Set-Cookie header");
	return setCookieHeader.split(";")[0];
}

async function clearPasswordUsers(): Promise<void> {
	await env.DB.prepare("DELETE FROM user_passwords").run();
}

describe("Email + password authentication", () => {
	const origEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		origEnv.ADMIN_EMAILS = env.ADMIN_EMAILS;
		origEnv.ALLOW_PASSWORD_SIGNUP = env.ALLOW_PASSWORD_SIGNUP;
		origEnv.DEFAULT_WORKSPACE_SLUG = env.DEFAULT_WORKSPACE_SLUG;
		origEnv.DEFAULT_WORKSPACE_NAME = env.DEFAULT_WORKSPACE_NAME;
		origEnv.PUBLIC_READ_ONLY = env.PUBLIC_READ_ONLY;
		env.ADMIN_EMAILS = "mmvarma@pybots.ai";
		env.ALLOW_PASSWORD_SIGNUP = undefined;
		env.DEFAULT_WORKSPACE_SLUG = "pw-ws";
		env.DEFAULT_WORKSPACE_NAME = "Password WS";
		env.PUBLIC_READ_ONLY = undefined;
		resetAuthCachesForTests();
		await clearPasswordUsers();
	});

	afterEach(() => {
		env.ADMIN_EMAILS = origEnv.ADMIN_EMAILS;
		env.ALLOW_PASSWORD_SIGNUP = origEnv.ALLOW_PASSWORD_SIGNUP;
		env.DEFAULT_WORKSPACE_SLUG = origEnv.DEFAULT_WORKSPACE_SLUG;
		env.DEFAULT_WORKSPACE_NAME = origEnv.DEFAULT_WORKSPACE_NAME;
		env.PUBLIC_READ_ONLY = origEnv.PUBLIC_READ_ONLY;
	});

	it("GET /auth/status reports setup and signup state", async () => {
		const res = await SELF.fetch("http://localhost/auth/status");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			passwordAuth: true,
			hasUsersWithPasswords: false,
			allowSignup: false,
			cfAccessConfigured: false,
			adminSetupRestricted: true,
		});
	});

	it("POST /auth/setup enforces ADMIN_EMAILS, validates password, creates admin + workspace, and locks out second setup", async () => {
		// Short password rejected
		const shortRes = await SELF.fetch("http://localhost/auth/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "short" }),
		});
		expect(shortRes.status).toBe(400);

		// Non-admin email rejected when ADMIN_EMAILS is configured
		const nonAdminRes = await SELF.fetch("http://localhost/auth/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "attacker@example.com", password: "StrongPassword1!" }),
		});
		expect(nonAdminRes.status).toBe(403);

		// Valid admin setup on https sets Secure HttpOnly SameSite=Lax cookie
		const okRes = await SELF.fetch("https://localhost/auth/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "MMVarma@PyBots.AI",
				name: "Mani Varma",
				password: "StrongPassword1!",
			}),
		});
		expect(okRes.status).toBe(201);
		const setCookie = okRes.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Secure");

		const body = (await okRes.json()) as {
			user: { id: string; email: string; name: string };
			workspaces: Array<{ slug: string; role: string }>;
			authMethod: string;
		};
		expect(body.user.email).toBe("mmvarma@pybots.ai");
		expect(body.user.name).toBe("Mani Varma");
		expect(body.authMethod).toBe("password");
		expect(body.workspaces.some((w) => w.slug === "pw-ws" && w.role === "owner")).toBe(true);

		// /auth/status now reports initialized
		const statusAfter = (await (await SELF.fetch("http://localhost/auth/status")).json()) as {
			hasUsersWithPasswords: boolean;
		};
		expect(statusAfter.hasUsersWithPasswords).toBe(true);

		// Second setup attempt must return 409 Conflict (reset rate limits so we test conflict, not 429)
		await resetRateLimits();
		const replayRes = await SELF.fetch("http://localhost/auth/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "OtherPassword1!" }),
		});
		expect(replayRes.status).toBe(409);
	});

	it("POST /auth/login authenticates valid credentials, supports /auth/me & PAT minting, and rejects bad credentials/cookies", async () => {
		const setupRes = await SELF.fetch("http://localhost/auth/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "CorrectHorseBattery!" }),
		});
		expect(setupRes.status).toBe(201);

		// Unknown user & wrong password return 401
		const badUser = await SELF.fetch("http://localhost/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "nobody@example.com", password: "CorrectHorseBattery!" }),
		});
		expect(badUser.status).toBe(401);

		const badPass = await SELF.fetch("http://localhost/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "WrongPassword1!" }),
		});
		expect(badPass.status).toBe(401);

		await resetRateLimits();

		// Valid login (case-insensitive email)
		const loginRes = await SELF.fetch("http://localhost/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "MMVARMA@PYBOTS.AI", password: "CorrectHorseBattery!" }),
		});
		expect(loginRes.status).toBe(200);
		const cookie = extractCookiePair(loginRes.headers.get("set-cookie"));

		// Session cookie works on /auth/me, /api/projects, and interactive PAT creation
		const meRes = await SELF.fetch("http://localhost/auth/me", { headers: { Cookie: cookie } });
		expect(meRes.status).toBe(200);
		const meBody = (await meRes.json()) as {
			user: { email: string };
			authMethod: string;
		};
		expect(meBody.user.email).toBe("mmvarma@pybots.ai");
		expect(meBody.authMethod).toBe("password");

		const projRes = await SELF.fetch("http://localhost/api/projects", {
			headers: { Cookie: cookie },
		});
		expect(projRes.status).toBe(200);

		const patRes = await SELF.fetch("http://localhost/auth/tokens", {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "my-cli", scopes: ["read"] }),
		});
		expect(patRes.status).toBe(201);

		// Forged or tampered cookie is rejected
		const tamperedRes = await SELF.fetch("http://localhost/auth/me", {
			headers: { Cookie: `${SESSION_COOKIE_NAME}=eyJzdWIiOiJ4In0.bad_sig` },
		});
		expect(tamperedRes.status).toBe(401);

		// Expired cookie is rejected
		const expiredToken = await signSessionToken(
			env.JWT_SECRET,
			{ sub: "nonexistent", email: "mmvarma@pybots.ai", v: 1 },
			Math.floor(Date.now() / 1000) - 10 * 24 * 3600
		);
		const expiredRes = await SELF.fetch("http://localhost/auth/me", {
			headers: { Cookie: `${SESSION_COOKIE_NAME}=${expiredToken}` },
		});
		expect(expiredRes.status).toBe(401);
	});

	it("POST /auth/logout clears session cookie", async () => {
		const res = await SELF.fetch("https://localhost/auth/logout", { method: "POST" });
		expect(res.status).toBe(200);
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
		expect(setCookie).toContain("Max-Age=0");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
	});

	it("POST /auth/password rotates password and invalidates prior sessions", async () => {
		const setupRes = await SELF.fetch("http://localhost/auth/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "InitialPassword1!" }),
		});
		const oldCookie = extractCookiePair(setupRes.headers.get("set-cookie"));

		// Wrong current password rejected
		const wrongRes = await SELF.fetch("http://localhost/auth/password", {
			method: "POST",
			headers: { Cookie: oldCookie, "Content-Type": "application/json" },
			body: JSON.stringify({
				currentPassword: "WrongPassword1!",
				newPassword: "UpdatedPassword2!",
			}),
		});
		expect(wrongRes.status).toBe(403);

		// Valid password change issues new cookie & bumps session_version
		const changeRes = await SELF.fetch("http://localhost/auth/password", {
			method: "POST",
			headers: { Cookie: oldCookie, "Content-Type": "application/json" },
			body: JSON.stringify({
				currentPassword: "InitialPassword1!",
				newPassword: "UpdatedPassword2!",
			}),
		});
		expect(changeRes.status).toBe(200);
		const newCookie = extractCookiePair(changeRes.headers.get("set-cookie"));

		// Old cookie must now fail
		const oldMe = await SELF.fetch("http://localhost/auth/me", { headers: { Cookie: oldCookie } });
		expect(oldMe.status).toBe(401);

		// New cookie stays authenticated
		const newMe = await SELF.fetch("http://localhost/auth/me", { headers: { Cookie: newCookie } });
		expect(newMe.status).toBe(200);

		// Old password fails; new password succeeds
		await resetRateLimits();
		const oldLogin = await SELF.fetch("http://localhost/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "InitialPassword1!" }),
		});
		expect(oldLogin.status).toBe(401);

		const newLogin = await SELF.fetch("http://localhost/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "UpdatedPassword2!" }),
		});
		expect(newLogin.status).toBe(200);
	});

	it("POST /auth/signup respects ALLOW_PASSWORD_SIGNUP toggle and prevents account takeover", async () => {
		await SELF.fetch("http://localhost/auth/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "AdminPassword1!" }),
		});

		// Disabled by default
		const disabledRes = await SELF.fetch("http://localhost/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "newuser@example.com", password: "UserPassword1!" }),
		});
		expect(disabledRes.status).toBe(403);

		// Enable signup
		env.ALLOW_PASSWORD_SIGNUP = "true";
		await resetRateLimits();

		const duplicateRes = await SELF.fetch("http://localhost/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "TakeoverPassword1!" }),
		});
		expect(duplicateRes.status).toBe(409);

		const okRes = await SELF.fetch("http://localhost/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "signup@example.com",
				name: "Sign Up User",
				password: "UserPassword1!",
			}),
		});
		expect(okRes.status).toBe(201);
		const cookie = extractCookiePair(okRes.headers.get("set-cookie"));
		const meRes = await SELF.fetch("http://localhost/auth/me", { headers: { Cookie: cookie } });
		expect(meRes.status).toBe(200);
	});

	it("admin /auth/users creates members with passwords, resets member passwords, and enforces RBAC", async () => {
		const setupRes = await SELF.fetch("http://localhost/auth/setup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "AdminPassword1!" }),
		});
		const setupBody = (await setupRes.json()) as {
			user: { id: string };
			workspaces: Array<{ id: string; slug: string }>;
		};
		const ownerCookie = extractCookiePair(setupRes.headers.get("set-cookie"));
		const wsId = setupBody.workspaces[0].id;

		// Bearer API token cannot access interactive user/password endpoints
		const apiTok = await seedToken(wsId, setupBody.user.id, { scopes: ["*"] });
		const bearerCreate = await SELF.fetch("http://localhost/auth/users", {
			method: "POST",
			headers: authHeaders(apiTok, "pw-ws"),
			body: JSON.stringify({
				email: "alice@example.com",
				role: "member",
				password: "AlicePassword1!",
			}),
		});
		expect(bearerCreate.status).toBe(403);

		// Owner creates Alice (member) with password
		const createAlice = await SELF.fetch("http://localhost/auth/users", {
			method: "POST",
			headers: {
				Cookie: ownerCookie,
				"Content-Type": "application/json",
				"X-Workspace-Slug": "pw-ws",
			},
			body: JSON.stringify({
				email: "alice@example.com",
				name: "Alice",
				role: "member",
				password: "AlicePassword1!",
			}),
		});
		expect(createAlice.status).toBe(201);

		// Owner sees Alice with hasPassword=true
		const listRes = await SELF.fetch("http://localhost/auth/users?workspaceSlug=pw-ws", {
			headers: { Cookie: ownerCookie },
		});
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as {
			users: Array<{ email: string; role: string; hasPassword: boolean }>;
		};
		expect(listBody.users).toContainEqual(
			expect.objectContaining({ email: "alice@example.com", role: "member", hasPassword: true })
		);

		// Alice logs in and gets rejected by GET /auth/users & POST /auth/users
		const aliceLogin = await SELF.fetch("http://localhost/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "alice@example.com", password: "AlicePassword1!" }),
		});
		expect(aliceLogin.status).toBe(200);
		const aliceCookie = extractCookiePair(aliceLogin.headers.get("set-cookie"));

		const aliceList = await SELF.fetch("http://localhost/auth/users?workspaceSlug=pw-ws", {
			headers: { Cookie: aliceCookie },
		});
		expect(aliceList.status).toBe(403);

		// Seed a workspace admin; verify admin cannot create an owner or reset an owner's password
		const ws = await seedWorkspace("rbac-ws");
		const ownerUser = await seedUser("owner2@example.com");
		const adminUser = await seedUser("admin2@example.com");
		await seedMember(ws.id, ownerUser.id, "owner");
		await seedMember(ws.id, adminUser.id, "admin");
		await env.DB.prepare(
			"INSERT INTO user_passwords (user_id, password_hash, session_version, updated_at) VALUES (?, ?, 1, 1)"
		)
			.bind(adminUser.id, "dummy")
			.run();
		const adminTok = await signSessionToken(env.JWT_SECRET, {
			sub: adminUser.id,
			email: adminUser.email,
			v: 1,
		});
		const adminCookie = `${SESSION_COOKIE_NAME}=${adminTok}`;

		await resetRateLimits();
		const escalateRes = await SELF.fetch("http://localhost/auth/users", {
			method: "POST",
			headers: {
				Cookie: adminCookie,
				"Content-Type": "application/json",
				"X-Workspace-Slug": "rbac-ws",
			},
			body: JSON.stringify({
				email: "newowner@example.com",
				role: "owner",
				password: "NewOwnerPassword1!",
			}),
		});
		expect(escalateRes.status).toBe(403);

		const resetOwnerRes = await SELF.fetch("http://localhost/auth/users", {
			method: "POST",
			headers: {
				Cookie: adminCookie,
				"Content-Type": "application/json",
				"X-Workspace-Slug": "rbac-ws",
			},
			body: JSON.stringify({
				email: "owner2@example.com",
				role: "member",
				password: "HijackPassword1!",
			}),
		});
		expect(resetOwnerRes.status).toBe(403);

		// Owner resets Alice's password -> invalidates Alice's old cookie
		await resetRateLimits();
		const resetAliceRes = await SELF.fetch("http://localhost/auth/users", {
			method: "POST",
			headers: {
				Cookie: ownerCookie,
				"Content-Type": "application/json",
				"X-Workspace-Slug": "pw-ws",
			},
			body: JSON.stringify({
				email: "alice@example.com",
				password: "AliceNewPassword2!",
			}),
		});
		expect(resetAliceRes.status).toBe(200);

		const aliceOldMe = await SELF.fetch("http://localhost/auth/me", {
			headers: { Cookie: aliceCookie },
		});
		expect(aliceOldMe.status).toBe(401);
	});

	it("rate-limits repeated POST /auth/login attempts with 429", async () => {
		for (let i = 0; i < 3; i++) {
			const res = await SELF.fetch("http://localhost/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "WrongPassword1!" }),
			});
			expect(res.status).toBe(401);
		}
		const limited = await SELF.fetch("http://localhost/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mmvarma@pybots.ai", password: "WrongPassword1!" }),
		});
		expect(limited.status).toBe(429);
	});
});
