import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { Input } from "./ui/Input";

interface AuthUserRow {
	id: string;
	email: string;
	name: string;
	role: string;
	hasPassword: boolean;
}

export interface SavedCredentials {
	id: number;
	email: string;
	password: string;
	role?: string;
	action: "created" | "reset";
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_";

/** Generate a strong random password safe to copy and share. */
export function generateStrongPassword(length = 16): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
}

function getLoginUrl(): string {
	if (typeof window === "undefined") return "/login";
	return `${window.location.origin}/login`;
}

function formatLoginInfo(creds: SavedCredentials, loginUrl: string): string {
	return `URL: ${loginUrl}\nEmail: ${creds.email}\nPassword: ${creds.password}`;
}

const SELECT_CLASS =
	"w-full px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base font-[inherit]";

export function useMemberPasswords(slug: string, onChanged: () => Promise<void>) {
	const [passwordByUser, setPasswordByUser] = useState<Record<string, boolean>>({});
	const [resetTargetId, setResetTargetId] = useState<string | null>(null);
	const [resetEmail, setResetEmail] = useState<string>("");
	const [resetPw, setResetPw] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [savedCredentials, setSavedCredentials] = useState<SavedCredentials | null>(null);
	const credSeqRef = useRef(0);

	const loadUsers = useCallback(async () => {
		try {
			const res = await apiFetch<{ users?: AuthUserRow[] }>(
				`/auth/users?workspaceSlug=${encodeURIComponent(slug)}`,
				{ workspaceSlug: slug, on401: "throw" }
			);
			if (Array.isArray(res.users)) {
				const next: Record<string, boolean> = {};
				for (const u of res.users) next[u.id] = u.hasPassword;
				setPasswordByUser(next);
			}
		} catch {
			// Non-fatal in case older mock / non-password test omits /auth/users
		}
	}, [slug]);

	useEffect(() => {
		void loadUsers();
	}, [loadUsers]);

	async function setMemberPassword(
		payload: {
			email: string;
			name?: string;
			role?: string;
			password: string;
		},
		action: "created" | "reset"
	) {
		setErr(null);
		setNotice(null);
		setSavedCredentials(null);
		if (payload.password.length < 8) {
			setErr("Password must be at least 8 characters.");
			return false;
		}
		setBusy(true);
		try {
			await apiFetch("/auth/users", {
				method: "POST",
				workspaceSlug: slug,
				body: { ...payload, workspaceSlug: slug },
			});
			await Promise.all([loadUsers(), onChanged()]);
			const email = payload.email.trim().toLowerCase();
			setNotice(`Saved password for ${email}.`);
			setSavedCredentials({
				id: ++credSeqRef.current,
				email,
				password: payload.password,
				role: payload.role,
				action,
			});
			return true;
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setBusy(false);
		}
	}

	return {
		passwordByUser,
		resetTargetId,
		resetEmail,
		resetPw,
		setResetPw,
		busy,
		err,
		notice,
		savedCredentials,
		dismissCredentials: () => setSavedCredentials(null),
		openReset: (id: string, email: string) => {
			setResetTargetId(id);
			setResetEmail(email);
			setResetPw("");
			setErr(null);
			setNotice(null);
		},
		closeReset: () => {
			setResetTargetId(null);
			setResetEmail("");
			setResetPw("");
		},
		saveReset: async (e: Event) => {
			e.preventDefault();
			if (!resetEmail) return;
			const ok = await setMemberPassword({ email: resetEmail, password: resetPw }, "reset");
			if (ok) {
				setResetTargetId(null);
				setResetEmail("");
				setResetPw("");
			}
		},
		createUser: (payload: { email: string; name?: string; role: string; password: string }) =>
			setMemberPassword(payload, "created"),
	};
}

export function SavedCredentialsBanner({
	credentials,
	onDismiss,
}: {
	credentials: SavedCredentials;
	onDismiss: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const [copyErr, setCopyErr] = useState<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loginUrl = getLoginUrl();

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	async function handleCopy() {
		setCopyErr(null);
		try {
			await navigator.clipboard.writeText(formatLoginInfo(credentials, loginUrl));
			setCopied(true);
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			setCopyErr("Clipboard unavailable — copy details manually above.");
		}
	}

	const heading =
		credentials.action === "reset"
			? "Updated login credentials"
			: "Login credentials ready to share";

	return (
		<section aria-label={heading} class="mb-4 p-4 bg-bg border border-border rounded-md">
			<div class="flex flex-wrap items-center justify-between gap-2 mb-2">
				<p class="m-0 font-semibold text-sm text-text-base">
					{heading}: <span class="font-mono text-xs text-text-muted">{credentials.email}</span>
					{credentials.role && (
						<span class="ml-2 text-xs font-normal text-text-muted">({credentials.role})</span>
					)}
				</p>
				<div class="flex items-center gap-2">
					<Button type="button" variant="primary" size="sm" onClick={() => void handleCopy()}>
						{copied ? "Copied!" : "Copy login info"}
					</Button>
					<Button type="button" variant="outline" size="sm" onClick={onDismiss}>
						Dismiss
					</Button>
				</div>
			</div>
			<p class="m-0 mb-2 text-xs text-text-muted">
				Copy and share these credentials now — the password won't be visible after dismissing.
			</p>
			<div class="grid gap-1 text-xs font-mono bg-surface border border-border rounded px-3 py-2 text-text-base break-all">
				<div>URL: {loginUrl}</div>
				<div>Email: {credentials.email}</div>
				<div>Password: {credentials.password}</div>
			</div>
			{copyErr && (
				<p role="alert" class="m-0 mt-2 text-xs text-danger-text">
					{copyErr}
				</p>
			)}
		</section>
	);
}

export function AddMemberPasswordPanel({
	callerRole,
	busy,
	onCreate,
}: {
	callerRole: string;
	busy: boolean;
	onCreate: (payload: {
		email: string;
		name?: string;
		role: string;
		password: string;
	}) => Promise<boolean>;
}) {
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState("member");
	const [password, setPassword] = useState("");
	const [revealPassword, setRevealPassword] = useState(false);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (!email.trim() || !password) return;
		const ok = await onCreate({
			email: email.trim(),
			...(name.trim() ? { name: name.trim() } : {}),
			role,
			password,
		});
		if (ok) {
			setEmail("");
			setName("");
			setRole("member");
			setPassword("");
			setRevealPassword(false);
		}
	}

	return (
		<form onSubmit={handleSubmit} class="mb-5 pb-4 border-b border-border">
			<h3 class="m-0 mb-2 text-sm font-semibold text-text-base">
				Add user or set initial password
			</h3>
			<div class="grid gap-3 grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-end">
				<Field label="Email" htmlFor="new-member-email" required class="m-0">
					<Input
						id="new-member-email"
						type="email"
						required
						placeholder="teammate@example.com"
						value={email}
						onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
						disabled={busy}
					/>
				</Field>
				<Field label="Name" htmlFor="new-member-name" class="m-0">
					<Input
						id="new-member-name"
						type="text"
						maxLength={100}
						placeholder="Optional"
						value={name}
						onInput={(e) => setName((e.target as HTMLInputElement).value)}
						disabled={busy}
					/>
				</Field>
				<Field label="Role" htmlFor="new-member-role" class="m-0">
					<select
						id="new-member-role"
						class={SELECT_CLASS}
						value={role}
						onChange={(e) => setRole((e.target as HTMLSelectElement).value)}
						disabled={busy}
					>
						<option value="member">member</option>
						<option value="admin">admin</option>
						<option value="viewer">viewer</option>
						{callerRole === "owner" && <option value="owner">owner</option>}
					</select>
				</Field>
				<Field label="Initial password" htmlFor="new-member-password" required class="m-0">
					<div class="flex items-center gap-1.5">
						<Input
							id="new-member-password"
							class="flex-1 min-w-0"
							type={revealPassword ? "text" : "password"}
							required
							placeholder="Min 8 characters"
							value={password}
							onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
							disabled={busy}
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => {
								setPassword(generateStrongPassword());
								setRevealPassword(true);
							}}
						>
							Generate
						</Button>
					</div>
				</Field>
				<div>
					<Button type="submit" variant="primary" disabled={busy || !email.trim() || !password}>
						Save user
					</Button>
				</div>
			</div>
		</form>
	);
}
