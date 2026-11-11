// Password hashing & verification using WebCrypto PBKDF2-SHA256 (Workers-native).
// Format: pbkdf2_sha256$<iterations>$<base64url(salt)>$<base64url(derivedKey)>

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;

// Fixed fallback hash used when an unknown email hits POST /auth/login so timing
// stays uniform with real credential verification.
const DUMMY_PBKDF2_HASH =
	"pbkdf2_sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

async function derivePbkdf2(
	password: string,
	salt: Uint8Array,
	iterations: number,
	bitLength: number
): Promise<Uint8Array> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"]
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			hash: "SHA-256",
			salt,
			iterations,
		},
		keyMaterial,
		bitLength
	);
	return new Uint8Array(bits);
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function validatePassword(
	password: unknown
): { ok: true; value: string } | { ok: false; error: string } {
	if (typeof password !== "string") {
		return { ok: false, error: "Password must be a string" };
	}
	if (password.length < MIN_PASSWORD_LEN) {
		return {
			ok: false,
			error: `Password must be at least ${MIN_PASSWORD_LEN} characters`,
		};
	}
	if (password.length > MAX_PASSWORD_LEN) {
		return {
			ok: false,
			error: `Password must be at most ${MAX_PASSWORD_LEN} characters`,
		};
	}
	return { ok: true, value: password };
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const derived = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS, DERIVED_BITS);
	return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
	const parts = storedHash.split("$");
	if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
	const iterations = Number(parts[1]);
	if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 100_000) return false;
	const salt = fromBase64Url(parts[2]);
	const expected = fromBase64Url(parts[3]);
	if (!salt || !expected || expected.length === 0) return false;
	const derived = await derivePbkdf2(password, salt, iterations, expected.length * 8);
	return timingSafeEqual(derived, expected);
}

export async function verifyDummyPassword(password: string): Promise<void> {
	await verifyPassword(password.slice(0, MAX_PASSWORD_LEN), DUMMY_PBKDF2_HASH);
}
