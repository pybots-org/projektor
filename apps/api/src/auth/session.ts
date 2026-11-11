// Signed HttpOnly cookie session tokens for email+password authentication.
// Uses WebCrypto HMAC-SHA256 keyed from env.JWT_SECRET.

export const SESSION_COOKIE_NAME = "projektor_session";
export const SESSION_TTL_SECS = 7 * 24 * 60 * 60;

export interface SessionPayload {
	sub: string;
	email: string;
	v: number;
	iat: number;
	exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
	const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
	try {
		const bin = atob(padded);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

async function importHmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		[usage]
	);
}

export async function signSessionToken(
	secret: string,
	claims: { sub: string; email: string; v: number },
	nowSec = Math.floor(Date.now() / 1000)
): Promise<string> {
	const payload: SessionPayload = {
		sub: claims.sub,
		email: claims.email,
		v: claims.v,
		iat: nowSec,
		exp: nowSec + SESSION_TTL_SECS,
	};
	const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const key = await importHmacKey(secret, "sign");
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
	return `${encodedPayload}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
	secret: string,
	token: string,
	nowSec = Math.floor(Date.now() / 1000)
): Promise<SessionPayload | null> {
	if (!secret || !token) return null;
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [encodedPayload, encodedSig] = parts;
	if (!encodedPayload || !encodedSig) return null;

	const sigBytes = fromBase64Url(encodedSig);
	const payloadBytes = fromBase64Url(encodedPayload);
	if (!sigBytes || !payloadBytes) return null;

	const key = await importHmacKey(secret, "verify");
	const validSig = await crypto.subtle.verify(
		"HMAC",
		key,
		sigBytes,
		new TextEncoder().encode(encodedPayload)
	);
	if (!validSig) return null;

	try {
		const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<SessionPayload>;
		if (
			typeof parsed.sub !== "string" ||
			parsed.sub.length === 0 ||
			typeof parsed.email !== "string" ||
			parsed.email.length === 0 ||
			typeof parsed.v !== "number" ||
			!Number.isInteger(parsed.v) ||
			typeof parsed.iat !== "number" ||
			typeof parsed.exp !== "number"
		) {
			return null;
		}
		if (parsed.exp <= nowSec) return null;
		return parsed as SessionPayload;
	} catch {
		return null;
	}
}

function isHttpsRequest(requestUrl: string): boolean {
	try {
		return new URL(requestUrl).protocol === "https:";
	} catch {
		return false;
	}
}

export function buildSessionCookie(
	token: string,
	requestUrl: string,
	maxAgeSecs = SESSION_TTL_SECS
): string {
	const parts = [
		`${SESSION_COOKIE_NAME}=${token}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${maxAgeSecs}`,
	];
	if (isHttpsRequest(requestUrl)) parts.push("Secure");
	return parts.join("; ");
}

export function buildClearSessionCookie(requestUrl: string): string {
	const parts = [
		`${SESSION_COOKIE_NAME}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
		"Expires=Thu, 01 Jan 1970 00:00:00 GMT",
	];
	if (isHttpsRequest(requestUrl)) parts.push("Secure");
	return parts.join("; ");
}

export function parseAdminEmails(raw?: string): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter((e) => e.length > 0);
}

export function isTruthFlag(raw?: string): boolean {
	if (!raw) return false;
	const v = raw.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}
