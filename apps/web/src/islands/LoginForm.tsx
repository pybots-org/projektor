import { useEffect, useState } from "preact/hooks";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Field } from "./ui/Field";
import { Input } from "./ui/Input";

interface AuthStatus {
	passwordAuth: boolean;
	hasUsersWithPasswords: boolean;
	allowSignup: boolean;
	cfAccessConfigured: boolean;
	adminSetupRestricted: boolean;
}

interface MeResponse {
	user?: { id: string; email: string; name: string };
}

type Mode = "login" | "setup" | "signup";

export function safeRedirectUrl(raw: string | null): string {
	if (!raw) return "/";
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
	return trimmed;
}

export default function LoginForm() {
	const [status, setStatus] = useState<AuthStatus | null>(null);
	const [currentUser, setCurrentUser] = useState<{ email: string; name: string } | null>(null);
	const [mode, setMode] = useState<Mode>("login");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);

	const redirectUrl =
		typeof window !== "undefined"
			? safeRedirectUrl(new URLSearchParams(window.location.search).get("redirect_url"))
			: "/";

	useEffect(() => {
		let cancelled = false;
		async function load() {
			try {
				const [statusRes, meRes] = await Promise.all([
					fetch("/auth/status", { credentials: "same-origin" }),
					fetch("/auth/me", { credentials: "same-origin" }),
				]);
				if (cancelled) return;
				if (statusRes.ok) {
					const s = (await statusRes.json()) as AuthStatus;
					setStatus(s);
					if (!s.hasUsersWithPasswords) {
						setMode("setup");
					}
				}
				if (meRes.ok) {
					const me = (await meRes.json()) as MeResponse;
					if (me.user && me.user.email !== "public-viewer@projektor.local") {
						setCurrentUser({ email: me.user.email, name: me.user.name });
					}
				}
			} catch {
				if (!cancelled) setError("Unable to reach authentication service.");
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (submitting) return;
		setError(null);

		const trimmedEmail = email.trim();
		if (!trimmedEmail || !password) {
			setError("Email and password are required.");
			return;
		}
		if (mode === "setup" || mode === "signup") {
			if (password.length < 8) {
				setError("Password must be at least 8 characters.");
				return;
			}
			if (password !== confirmPassword) {
				setError("Passwords do not match.");
				return;
			}
		}

		setSubmitting(true);
		try {
			const endpoint =
				mode === "setup" ? "/auth/setup" : mode === "signup" ? "/auth/signup" : "/auth/login";
			const payload =
				mode === "login"
					? { email: trimmedEmail, password }
					: { email: trimmedEmail, password, ...(name.trim() ? { name: name.trim() } : {}) };

			const res = await fetch(endpoint, {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setError(data.error ?? `Request failed (${res.status})`);
				return;
			}
			try {
				sessionStorage.removeItem("projektor:reauth-attempted-at");
			} catch {
				// ignore storage errors
			}
			window.location.assign(redirectUrl);
		} catch {
			setError("Network error while signing in.");
		} finally {
			setSubmitting(false);
		}
	}

	async function handleSignOut() {
		setSubmitting(true);
		try {
			await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
			setCurrentUser(null);
			setPassword("");
		} finally {
			setSubmitting(false);
		}
	}

	if (loading) {
		return (
			<Card class="p-6">
				<p class="m-0 text-sm text-text-muted" aria-live="polite">
					Loading…
				</p>
			</Card>
		);
	}

	if (currentUser) {
		return (
			<Card class="p-6 gap-4">
				<div>
					<h1 class="m-0 mb-1 text-lg font-bold text-text-strong">Already signed in</h1>
					<p class="m-0 text-sm text-text-muted">
						Signed in as{" "}
						<strong class="text-text-base">{currentUser.name || currentUser.email}</strong> (
						{currentUser.email}).
					</p>
				</div>
				<div class="flex flex-wrap gap-2">
					<Button as="a" href={redirectUrl} variant="primary">
						Continue to Projektor
					</Button>
					<Button type="button" variant="outline" disabled={submitting} onClick={handleSignOut}>
						Sign out
					</Button>
				</div>
			</Card>
		);
	}

	const title =
		mode === "setup"
			? "Create admin account"
			: mode === "signup"
				? "Create account"
				: "Sign in to Projektor";

	const subtitle =
		mode === "setup"
			? status?.adminSetupRestricted
				? "Set the initial password for your configured admin email to unlock this workspace."
				: "Create the initial administrator account to secure your workspace."
			: mode === "signup"
				? "Create a new account with your email and a password."
				: "Enter your email and password to continue.";

	return (
		<Card class="p-6 gap-4">
			<div>
				<h1 class="m-0 mb-1 text-lg font-bold text-text-strong">{title}</h1>
				<p class="m-0 text-xs text-text-muted">{subtitle}</p>
			</div>

			<form onSubmit={handleSubmit} class="flex flex-col gap-1">
				{(mode === "setup" || mode === "signup") && (
					<Field label="Name" htmlFor="auth-name">
						<Input
							id="auth-name"
							type="text"
							autoComplete="name"
							maxLength={100}
							placeholder="Your name (optional)"
							value={name}
							onInput={(e) => setName((e.target as HTMLInputElement).value)}
							disabled={submitting}
						/>
					</Field>
				)}

				<Field label="Email" htmlFor="auth-email" required>
					<Input
						id="auth-email"
						type="email"
						required
						autoComplete="email"
						placeholder="you@example.com"
						value={email}
						onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
						disabled={submitting}
					/>
				</Field>

				<Field
					label="Password"
					htmlFor="auth-password"
					required
					help={mode !== "login" ? "At least 8 characters." : undefined}
				>
					<Input
						id="auth-password"
						type="password"
						required
						autoComplete={mode === "login" ? "current-password" : "new-password"}
						placeholder={mode === "login" ? "Enter your password" : "Create a strong password"}
						value={password}
						onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
						disabled={submitting}
					/>
				</Field>

				{(mode === "setup" || mode === "signup") && (
					<Field label="Confirm password" htmlFor="auth-password-confirm" required>
						<Input
							id="auth-password-confirm"
							type="password"
							required
							autoComplete="new-password"
							placeholder="Repeat your password"
							value={confirmPassword}
							onInput={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
							disabled={submitting}
						/>
					</Field>
				)}

				{error && (
					<p
						role="alert"
						class="m-0 mb-3 rounded border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-text"
					>
						{error}
					</p>
				)}

				<Button type="submit" variant="primary" disabled={submitting} class="w-full">
					{submitting
						? "Please wait…"
						: mode === "setup"
							? "Create admin account"
							: mode === "signup"
								? "Create account"
								: "Sign in"}
				</Button>
			</form>

			{status?.hasUsersWithPasswords && status.allowSignup && (
				<div class="pt-3 border-t border-border text-center text-xs text-text-muted">
					{mode === "signup" ? (
						<button
							type="button"
							class="bg-transparent border-0 p-0 text-accent cursor-pointer underline font-[inherit]"
							onClick={() => {
								setMode("login");
								setError(null);
							}}
						>
							Already have an account? Sign in
						</button>
					) : (
						<button
							type="button"
							class="bg-transparent border-0 p-0 text-accent cursor-pointer underline font-[inherit]"
							onClick={() => {
								setMode("signup");
								setError(null);
							}}
						>
							Need an account? Sign up
						</button>
					)}
				</div>
			)}

			{status?.cfAccessConfigured && (
				<div class="pt-3 border-t border-border text-center">
					<a
						href={`/auth/login?redirect_url=${encodeURIComponent(redirectUrl)}`}
						class="text-xs text-text-muted hover:text-text-base underline"
					>
						Sign in with Cloudflare Access
					</a>
				</div>
			)}
		</Card>
	);
}
