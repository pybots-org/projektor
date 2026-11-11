import type { HonoEnv } from "@projektor/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
	hashPassword,
	normalizeEmail,
	validatePassword,
	verifyDummyPassword,
	verifyPassword,
} from "../auth/password";
import {
	adminSetMemberPassword,
	createInitialAdminUser,
	getPasswordCredentialByEmail,
	hasAnyPasswordUser,
	listWorkspaceUsersWithPasswordStatus,
	signupPasswordUser,
	updateOwnPassword,
	userHasPassword,
} from "../auth/password-store";
import {
	buildClearSessionCookie,
	buildSessionCookie,
	isTruthFlag,
	parseAdminEmails,
	signSessionToken,
} from "../auth/session";
import { jsonBody } from "../http/body";
import { authMiddleware, provisionUser, requireInteractiveHuman } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { getUserWorkspaces } from "../services/user-tokens";

const EmailSchema = z.string().trim().email().max(320);

const SetupBodySchema = z.object({
	email: EmailSchema,
	password: z.string(),
	name: z.string().trim().max(100).optional(),
});

const LoginBodySchema = z.object({
	email: EmailSchema,
	password: z.string().min(1),
});

const PasswordChangeSchema = z.object({
	currentPassword: z.string().optional(),
	newPassword: z.string(),
});

const AdminSetUserPasswordSchema = z.object({
	email: EmailSchema,
	name: z.string().trim().max(100).optional(),
	role: z.enum(["owner", "admin", "member", "viewer"]).default("member"),
	password: z.string(),
	workspaceSlug: z.string().trim().min(1).max(100).optional(),
});

async function resolveTargetWorkspace(
	c: Context<HonoEnv>,
	explicitSlug?: string
): Promise<{ id: string; slug: string; name: string } | null> {
	const slug =
		explicitSlug?.trim() ||
		c.req.header("x-workspace-slug")?.trim() ||
		c.req.query("workspaceSlug")?.trim() ||
		c.env.DEFAULT_WORKSPACE_SLUG?.trim() ||
		"projektor";

	return c.env.DB.prepare("SELECT id, slug, name FROM workspaces WHERE slug = ? LIMIT 1")
		.bind(slug)
		.first<{ id: string; slug: string; name: string }>();
}

async function getMemberRole(
	db: D1Database,
	workspaceId: string,
	userId: string
): Promise<string | null> {
	const row = await db
		.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
		.bind(workspaceId, userId)
		.first<{ role: string }>();
	return row?.role ?? null;
}

const router = new Hono<HonoEnv>();

router.get("/status", async (c) => {
	const [hasUsers, allowSignup] = await Promise.all([
		hasAnyPasswordUser(c.env.DB),
		Promise.resolve(isTruthFlag(c.env.ALLOW_PASSWORD_SIGNUP)),
	]);
	return c.json({
		passwordAuth: true,
		hasUsersWithPasswords: hasUsers,
		allowSignup,
		cfAccessConfigured: Boolean(c.env.CF_ACCESS_TEAM_DOMAIN && c.env.CF_ACCESS_AUDIENCE),
		adminSetupRestricted: parseAdminEmails(c.env.ADMIN_EMAILS).length > 0,
	});
});

router.post("/setup", rateLimitMiddleware, async (c) => {
	if (!c.env.JWT_SECRET) {
		return c.json({ error: "Server session secret is not configured" }, 500);
	}

	const raw = await jsonBody(c);
	const parsed = SetupBodySchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Valid email and password are required" }, 400);
	}

	const pwCheck = validatePassword(parsed.data.password);
	if (!pwCheck.ok) {
		return c.json({ error: pwCheck.error }, 400);
	}

	const email = normalizeEmail(parsed.data.email);
	const adminEmails = parseAdminEmails(c.env.ADMIN_EMAILS);
	if (adminEmails.length > 0 && !adminEmails.includes(email)) {
		return c.json(
			{ error: "Initial admin setup is restricted to configured ADMIN_EMAILS addresses" },
			403
		);
	}

	const passwordHash = await hashPassword(pwCheck.value);
	const created = await createInitialAdminUser(c.env.DB, {
		email,
		name: parsed.data.name,
		passwordHash,
	});
	if (!created.ok) {
		return c.json({ error: "Initial setup has already been completed" }, 409);
	}

	await provisionUser(c.env, created.user);
	const token = await signSessionToken(c.env.JWT_SECRET, {
		sub: created.user.id,
		email: created.user.email,
		v: created.sessionVersion,
	});
	c.header("Set-Cookie", buildSessionCookie(token, c.req.url));
	const workspaces = await getUserWorkspaces({ db: c.env.DB, userId: created.user.id });
	return c.json({ user: created.user, workspaces, authMethod: "password" }, 201);
});

router.post("/login", rateLimitMiddleware, async (c) => {
	if (!c.env.JWT_SECRET) {
		return c.json({ error: "Server session secret is not configured" }, 500);
	}

	const raw = await jsonBody(c);
	const parsed = LoginBodySchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Email and password are required" }, 400);
	}

	const email = normalizeEmail(parsed.data.email);
	const cred = await getPasswordCredentialByEmail(c.env.DB, email);
	if (!cred) {
		await verifyDummyPassword(parsed.data.password);
		return c.json({ error: "Invalid email or password" }, 401);
	}

	const valid = await verifyPassword(parsed.data.password, cred.passwordHash);
	if (!valid) {
		return c.json({ error: "Invalid email or password" }, 401);
	}

	const user = { id: cred.id, email: cred.email, name: cred.name };
	await provisionUser(c.env, user);
	const token = await signSessionToken(c.env.JWT_SECRET, {
		sub: cred.id,
		email: cred.email,
		v: cred.sessionVersion,
	});
	c.header("Set-Cookie", buildSessionCookie(token, c.req.url));
	const workspaces = await getUserWorkspaces({ db: c.env.DB, userId: cred.id });
	return c.json({ user, workspaces, authMethod: "password" });
});

router.post("/signup", rateLimitMiddleware, async (c) => {
	if (!isTruthFlag(c.env.ALLOW_PASSWORD_SIGNUP)) {
		return c.json(
			{ error: "Public sign-up is disabled. Ask a workspace admin to create your account." },
			403
		);
	}
	if (!c.env.JWT_SECRET) {
		return c.json({ error: "Server session secret is not configured" }, 500);
	}

	const raw = await jsonBody(c);
	const parsed = SetupBodySchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Valid email and password are required" }, 400);
	}

	const pwCheck = validatePassword(parsed.data.password);
	if (!pwCheck.ok) {
		return c.json({ error: pwCheck.error }, 400);
	}

	const email = normalizeEmail(parsed.data.email);
	const passwordHash = await hashPassword(pwCheck.value);
	const created = await signupPasswordUser(c.env.DB, {
		email,
		name: parsed.data.name,
		passwordHash,
	});
	if (!created.ok) {
		return c.json({ error: "An account with this email already exists" }, 409);
	}

	await provisionUser(c.env, created.user);
	const token = await signSessionToken(c.env.JWT_SECRET, {
		sub: created.user.id,
		email: created.user.email,
		v: created.sessionVersion,
	});
	c.header("Set-Cookie", buildSessionCookie(token, c.req.url));
	const workspaces = await getUserWorkspaces({ db: c.env.DB, userId: created.user.id });
	return c.json({ user: created.user, workspaces, authMethod: "password" }, 201);
});

router.post("/logout", (c) => {
	c.header("Set-Cookie", buildClearSessionCookie(c.req.url));
	return c.json({ ok: true });
});

router.post("/password", rateLimitMiddleware, authMiddleware, async (c) => {
	const denied = requireInteractiveHuman(c, "Interactive human session is required");
	if (denied) return denied;
	if (!c.env.JWT_SECRET) {
		return c.json({ error: "Server session secret is not configured" }, 500);
	}

	const user = c.get("user") as { id: string; email: string; name: string };
	const raw = await jsonBody(c);
	const parsed = PasswordChangeSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Invalid request body" }, 400);
	}

	const pwCheck = validatePassword(parsed.data.newPassword);
	if (!pwCheck.ok) {
		return c.json({ error: pwCheck.error }, 400);
	}

	const hasExisting = await userHasPassword(c.env.DB, user.id);
	if (hasExisting) {
		const cred = await getPasswordCredentialByEmail(c.env.DB, user.email);
		if (!cred || !parsed.data.currentPassword) {
			return c.json({ error: "Current password is required" }, 403);
		}
		const valid = await verifyPassword(parsed.data.currentPassword, cred.passwordHash);
		if (!valid) {
			return c.json({ error: "Current password is incorrect" }, 403);
		}
	}

	const nextHash = await hashPassword(pwCheck.value);
	const nextVersion = await updateOwnPassword(c.env.DB, {
		userId: user.id,
		passwordHash: nextHash,
	});
	const token = await signSessionToken(c.env.JWT_SECRET, {
		sub: user.id,
		email: user.email,
		v: nextVersion,
	});
	c.header("Set-Cookie", buildSessionCookie(token, c.req.url));
	return c.json({ ok: true });
});

router.get("/users", authMiddleware, async (c) => {
	const denied = requireInteractiveHuman(c, "Interactive human session is required");
	if (denied) return denied;
	const workspace = await resolveTargetWorkspace(c);
	if (!workspace) {
		return c.json({ error: "Workspace not found" }, 404);
	}

	const caller = c.get("user") as { id: string };
	const callerRole = await getMemberRole(c.env.DB, workspace.id, caller.id);
	if (callerRole !== "owner" && callerRole !== "admin") {
		return c.json({ error: "Only workspace owners and admins can manage user accounts" }, 403);
	}

	const users = await listWorkspaceUsersWithPasswordStatus(c.env.DB, workspace.id);
	return c.json({ workspace, currentUserRole: callerRole, users });
});

router.post("/users", rateLimitMiddleware, authMiddleware, async (c) => {
	const denied = requireInteractiveHuman(c, "Interactive human session is required");
	if (denied) return denied;

	const raw = await jsonBody(c);
	const parsed = AdminSetUserPasswordSchema.safeParse(raw);
	if (!parsed.success) {
		return c.json({ error: "Valid email, role, and password are required" }, 400);
	}

	const pwCheck = validatePassword(parsed.data.password);
	if (!pwCheck.ok) {
		return c.json({ error: pwCheck.error }, 400);
	}

	const workspace = await resolveTargetWorkspace(c, parsed.data.workspaceSlug);
	if (!workspace) {
		return c.json({ error: "Workspace not found" }, 404);
	}

	const caller = c.get("user") as { id: string };
	const callerRole = await getMemberRole(c.env.DB, workspace.id, caller.id);
	if (callerRole !== "owner" && callerRole !== "admin") {
		return c.json({ error: "Only workspace owners and admins can manage user passwords" }, 403);
	}

	const passwordHash = await hashPassword(pwCheck.value);
	const result = await adminSetMemberPassword(c.env.DB, {
		workspaceId: workspace.id,
		callerRole,
		email: parsed.data.email,
		name: parsed.data.name,
		role: parsed.data.role,
		passwordHash,
	});
	if (!result.ok) {
		if (result.reason === "forbidden_target_owner") {
			return c.json({ error: "Only a workspace owner can change an owner's password" }, 403);
		}
		return c.json({ error: "Only a workspace owner can assign the owner role" }, 403);
	}

	return c.json(
		{ user: result.user, created: result.created, passwordSet: true },
		result.created ? 201 : 200
	);
});

export default router;
