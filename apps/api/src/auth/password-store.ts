import { normalizeEmail } from "./password";

export interface PasswordUserRecord {
	id: string;
	email: string;
	name: string;
	passwordHash: string;
	sessionVersion: number;
}

export interface SessionUserRecord {
	id: string;
	email: string;
	name: string;
	sessionVersion: number;
}

export interface WorkspaceUserPasswordRow {
	id: string;
	email: string;
	name: string;
	role: string;
	hasPassword: boolean;
}

function defaultDisplayName(email: string, providedName?: string): string {
	const trimmed = providedName?.trim();
	if (trimmed && trimmed.length > 0) return trimmed;
	return email.split("@")[0] || email;
}

export async function hasAnyPasswordUser(db: D1Database): Promise<boolean> {
	const row = await db.prepare("SELECT 1 FROM user_passwords LIMIT 1").first();
	return Boolean(row);
}

export async function userHasPassword(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 FROM user_passwords WHERE user_id = ? LIMIT 1")
		.bind(userId)
		.first();
	return Boolean(row);
}

export async function getPasswordCredentialByEmail(
	db: D1Database,
	email: string
): Promise<PasswordUserRecord | null> {
	const norm = normalizeEmail(email);
	const row = await db
		.prepare(
			`SELECT u.id, u.email, u.name, up.password_hash, up.session_version
			 FROM users u
			 JOIN user_passwords up ON up.user_id = u.id
			 WHERE lower(u.email) = ?
			 LIMIT 1`
		)
		.bind(norm)
		.first<{
			id: string;
			email: string;
			name: string;
			password_hash: string;
			session_version: number;
		}>();
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		passwordHash: row.password_hash,
		sessionVersion: row.session_version,
	};
}

export async function getSessionUserById(
	db: D1Database,
	userId: string
): Promise<SessionUserRecord | null> {
	const row = await db
		.prepare(
			`SELECT u.id, u.email, u.name, up.session_version
			 FROM users u
			 JOIN user_passwords up ON up.user_id = u.id
			 WHERE u.id = ?
			 LIMIT 1`
		)
		.bind(userId)
		.first<{ id: string; email: string; name: string; session_version: number }>();
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		sessionVersion: row.session_version,
	};
}

async function ensureUserRow(
	db: D1Database,
	email: string,
	providedName?: string
): Promise<{ id: string; email: string; name: string }> {
	const norm = normalizeEmail(email);
	const displayName = defaultDisplayName(norm, providedName);
	const now = Math.floor(Date.now() / 1000);
	const existing = await db
		.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1")
		.bind(norm)
		.first<{ id: string; email: string; name: string }>();

	if (existing) {
		const trimmed = providedName?.trim();
		if (trimmed && (!existing.name || existing.name === existing.email.split("@")[0])) {
			await db.prepare("UPDATE users SET name = ? WHERE id = ?").bind(trimmed, existing.id).run();
			return { id: existing.id, email: existing.email, name: trimmed };
		}
		return existing;
	}

	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO users (id, email, name, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(email) DO NOTHING`
		)
		.bind(id, norm, displayName, now)
		.run();

	const row = await db
		.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1")
		.bind(norm)
		.first<{ id: string; email: string; name: string }>();
	if (!row) throw new Error("Failed to resolve user record after insert");
	return row;
}

export async function createInitialAdminUser(
	db: D1Database,
	opts: { email: string; name?: string; passwordHash: string }
): Promise<
	| { ok: true; user: { id: string; email: string; name: string }; sessionVersion: number }
	| { ok: false; reason: "already_initialized" }
> {
	const user = await ensureUserRow(db, opts.email, opts.name);
	const now = Math.floor(Date.now() / 1000);
	// Atomic check so concurrent setup requests cannot overwrite the first admin credential.
	const res = await db
		.prepare(
			`INSERT INTO user_passwords (user_id, password_hash, session_version, updated_at)
			 SELECT ?, ?, 1, ?
			 WHERE NOT EXISTS (SELECT 1 FROM user_passwords)`
		)
		.bind(user.id, opts.passwordHash, now)
		.run();
	if ((res.meta?.changes ?? 0) !== 1) {
		return { ok: false, reason: "already_initialized" };
	}
	return { ok: true, user, sessionVersion: 1 };
}

export async function signupPasswordUser(
	db: D1Database,
	opts: { email: string; name?: string; passwordHash: string }
): Promise<
	| { ok: true; user: { id: string; email: string; name: string }; sessionVersion: number }
	| { ok: false; reason: "email_exists" }
> {
	const user = await ensureUserRow(db, opts.email, opts.name);
	const now = Math.floor(Date.now() / 1000);
	const res = await db
		.prepare(
			`INSERT INTO user_passwords (user_id, password_hash, session_version, updated_at)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(user_id) DO NOTHING`
		)
		.bind(user.id, opts.passwordHash, now)
		.run();
	if ((res.meta?.changes ?? 0) !== 1) {
		return { ok: false, reason: "email_exists" };
	}
	return { ok: true, user, sessionVersion: 1 };
}

export async function updateOwnPassword(
	db: D1Database,
	opts: { userId: string; passwordHash: string }
): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	await db
		.prepare(
			`INSERT INTO user_passwords (user_id, password_hash, session_version, updated_at)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   password_hash = excluded.password_hash,
			   session_version = user_passwords.session_version + 1,
			   updated_at = excluded.updated_at`
		)
		.bind(opts.userId, opts.passwordHash, now)
		.run();

	const row = await db
		.prepare("SELECT session_version FROM user_passwords WHERE user_id = ?")
		.bind(opts.userId)
		.first<{ session_version: number }>();
	return row?.session_version ?? 1;
}

export async function listWorkspaceUsersWithPasswordStatus(
	db: D1Database,
	workspaceId: string
): Promise<WorkspaceUserPasswordRow[]> {
	const { results } = await db
		.prepare(
			`SELECT u.id, u.email, u.name, wm.role,
			        CASE WHEN up.user_id IS NOT NULL THEN 1 ELSE 0 END AS has_password
			 FROM workspace_members wm
			 JOIN users u ON u.id = wm.user_id
			 LEFT JOIN user_passwords up ON up.user_id = u.id
			 WHERE wm.workspace_id = ?
			 ORDER BY wm.joined_at ASC, u.email ASC`
		)
		.bind(workspaceId)
		.all<{
			id: string;
			email: string;
			name: string;
			role: string;
			has_password: number;
		}>();
	return results.map((r) => ({
		id: r.id,
		email: r.email,
		name: r.name,
		role: r.role,
		hasPassword: r.has_password === 1,
	}));
}

export async function adminSetMemberPassword(
	db: D1Database,
	opts: {
		workspaceId: string;
		callerRole: string;
		email: string;
		name?: string;
		role: "owner" | "admin" | "member" | "viewer";
		passwordHash: string;
	}
): Promise<
	| {
			ok: true;
			user: { id: string; email: string; name: string; role: string };
			created: boolean;
	  }
	| { ok: false; reason: "forbidden_role" | "forbidden_target_owner" }
> {
	const norm = normalizeEmail(opts.email);
	const existingUser = await db
		.prepare("SELECT id, email, name FROM users WHERE lower(email) = ? LIMIT 1")
		.bind(norm)
		.first<{ id: string; email: string; name: string }>();

	if (existingUser) {
		const existingMember = await db
			.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
			.bind(opts.workspaceId, existingUser.id)
			.first<{ role: string }>();
		if (existingMember?.role === "owner" && opts.callerRole !== "owner") {
			return { ok: false, reason: "forbidden_target_owner" };
		}
		if (!existingMember && opts.role === "owner" && opts.callerRole !== "owner") {
			return { ok: false, reason: "forbidden_role" };
		}
	} else if (opts.role === "owner" && opts.callerRole !== "owner") {
		return { ok: false, reason: "forbidden_role" };
	}

	const user = await ensureUserRow(db, norm, opts.name);
	const now = Math.floor(Date.now() / 1000);
	const existingMembership = await db
		.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
		.bind(opts.workspaceId, user.id)
		.first<{ role: string }>();

	const assignedRole = existingMembership?.role ?? opts.role;
	const createdMember = !existingMembership;

	if (!existingMembership) {
		await db.batch([
			db
				.prepare(
					`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
					 VALUES (?, ?, ?, ?)`
				)
				.bind(opts.workspaceId, user.id, assignedRole, now),
			db
				.prepare("DELETE FROM provisioning_removals WHERE workspace_id = ? AND user_id = ?")
				.bind(opts.workspaceId, user.id),
		]);
	}

	await db
		.prepare(
			`INSERT INTO user_passwords (user_id, password_hash, session_version, updated_at)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   password_hash = excluded.password_hash,
			   session_version = user_passwords.session_version + 1,
			   updated_at = excluded.updated_at`
		)
		.bind(user.id, opts.passwordHash, now)
		.run();

	return {
		ok: true,
		user: { id: user.id, email: user.email, name: user.name, role: assignedRole },
		created: createdMember,
	};
}
