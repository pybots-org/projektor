-- Email + password credentials and session invalidation epoch per user.
-- Stored in a dedicated table so existing users inserts/upserts (CF Access, dev bypass,
-- workspace member invites) remain unchanged and backward-compatible.
CREATE TABLE IF NOT EXISTS user_passwords (
	user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	password_hash TEXT NOT NULL,
	session_version INTEGER NOT NULL DEFAULT 1,
	updated_at INTEGER NOT NULL
);
