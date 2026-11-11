import { useCallback, useEffect, useState } from "preact/hooks";
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

	async function setMemberPassword(payload: {
		email: string;
		name?: string;
		role?: string;
		password: string;
	}) {
		setErr(null);
		setNotice(null);
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
			setNotice(`Saved password for ${payload.email.trim().toLowerCase()}.`);
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
			const ok = await setMemberPassword({ email: resetEmail, password: resetPw });
			if (ok) {
				setResetTargetId(null);
				setResetEmail("");
				setResetPw("");
			}
		},
		createUser: setMemberPassword,
	};
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
					<Input
						id="new-member-password"
						type="password"
						required
						placeholder="Min 8 characters"
						value={password}
						onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
						disabled={busy}
					/>
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
