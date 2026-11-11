import { useEffect, useState } from "preact/hooks";
import { apiFetch, SessionExpiredError } from "../utils/api-client";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Field } from "./ui/Field";
import { Input } from "./ui/Input";

interface MeData {
	user: { id: string; email: string; name: string };
	workspaces: Array<{ id: string; name: string; slug: string; role: string }>;
	authMethod?: string | null;
}

export default function AccountSettings() {
	const [me, setMe] = useState<MeData | null>(null);
	const [loading, setLoading] = useState(true);
	const [unauthenticated, setUnauthenticated] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		apiFetch<MeData>("/auth/me", { on401: "throw" })
			.then((data) => {
				if (!cancelled) setMe(data);
			})
			.catch((err) => {
				if (cancelled) return;
				if (err instanceof SessionExpiredError || String(err).includes("401")) {
					setUnauthenticated(true);
				} else {
					setLoadError(String(err));
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function handlePasswordSubmit(e: Event) {
		e.preventDefault();
		if (saving) return;
		setSaveError(null);
		setSaveSuccess(null);

		if (newPassword.length < 8) {
			setSaveError("New password must be at least 8 characters.");
			return;
		}
		if (newPassword !== confirmPassword) {
			setSaveError("New passwords do not match.");
			return;
		}

		setSaving(true);
		try {
			await apiFetch<{ ok: boolean }>("/auth/password", {
				method: "POST",
				body: {
					...(currentPassword ? { currentPassword } : {}),
					newPassword,
				},
			});
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
			setSaveSuccess("Password updated. Other active sessions have been signed out.");
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	if (loading) return <p aria-live="polite">Loading account…</p>;
	if (unauthenticated) {
		return (
			<Card class="max-w-md p-5">
				<h2 class="m-0 text-base font-semibold text-text-strong">Sign in required</h2>
				<p class="m-0 text-sm text-text-muted">Sign in to manage your account and password.</p>
				<div>
					<Button
						as="a"
						href="/login?redirect_url=%2Fsettings%2Faccount"
						variant="primary"
						size="sm"
					>
						Sign in
					</Button>
				</div>
			</Card>
		);
	}
	if (loadError || !me) {
		return (
			<p role="alert" class="text-danger-text">
				Failed to load account: {loadError ?? "Unknown error"}
			</p>
		);
	}

	const isPasswordAuth = me.authMethod === "password";

	return (
		<div class="flex flex-col gap-6 max-w-xl">
			<Card class="p-5">
				<h2 class="m-0 text-base font-semibold text-text-strong">Profile</h2>
				<dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					<dt class="text-text-muted">Name</dt>
					<dd class="m-0 text-text-base font-medium">{me.user.name || "—"}</dd>
					<dt class="text-text-muted">Email</dt>
					<dd class="m-0 text-text-base font-mono text-xs self-center">{me.user.email}</dd>
					<dt class="text-text-muted">Auth</dt>
					<dd class="m-0 text-text-base">{me.authMethod ?? "session"}</dd>
				</dl>
				{me.workspaces.length > 0 && (
					<div class="pt-3 mt-1 border-t border-border">
						<div class="text-xs font-semibold text-text-muted mb-2">Workspaces</div>
						<ul class="m-0 pl-4 text-sm text-text-base flex flex-col gap-1">
							{me.workspaces.map((ws) => (
								<li key={ws.id}>
									<span class="font-medium">{ws.name}</span>{" "}
									<span class="text-text-muted text-xs">
										({ws.slug} · {ws.role})
									</span>
								</li>
							))}
						</ul>
					</div>
				)}
			</Card>

			<Card class="p-5">
				<h2 class="m-0 text-base font-semibold text-text-strong">
					{isPasswordAuth ? "Change password" : "Password sign-in"}
				</h2>
				<p class="m-0 text-xs text-text-muted mb-2">
					{isPasswordAuth
						? "Updating your password signs out any other sessions."
						: "Set or update a password so you can also sign in with email and password."}
				</p>

				<form onSubmit={handlePasswordSubmit} class="flex flex-col gap-1">
					<Field
						label={isPasswordAuth ? "Current password" : "Current password (if already set)"}
						htmlFor="current-password"
						required={isPasswordAuth}
					>
						<Input
							id="current-password"
							type="password"
							required={isPasswordAuth}
							autoComplete="current-password"
							value={currentPassword}
							onInput={(e) => setCurrentPassword((e.target as HTMLInputElement).value)}
							disabled={saving}
						/>
					</Field>

					<Field label="New password" htmlFor="new-password" required help="At least 8 characters.">
						<Input
							id="new-password"
							type="password"
							required
							autoComplete="new-password"
							value={newPassword}
							onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
							disabled={saving}
						/>
					</Field>

					<Field label="Confirm new password" htmlFor="confirm-new-password" required>
						<Input
							id="confirm-new-password"
							type="password"
							required
							autoComplete="new-password"
							value={confirmPassword}
							onInput={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
							disabled={saving}
						/>
					</Field>

					{saveError && (
						<p
							role="alert"
							class="m-0 mb-2 rounded border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-text"
						>
							{saveError}
						</p>
					)}
					{saveSuccess && (
						<p
							role="status"
							class="m-0 mb-2 rounded border border-success-border bg-success-bg px-3 py-2 text-xs text-text-base"
						>
							{saveSuccess}
						</p>
					)}

					<div>
						<Button type="submit" variant="primary" disabled={saving}>
							{saving ? "Saving…" : "Update password"}
						</Button>
					</div>
				</form>
			</Card>
		</div>
	);
}
