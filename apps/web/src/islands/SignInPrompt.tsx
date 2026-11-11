import { Button } from "./ui/Button";
import { Card } from "./ui/Card";

export function SignInPrompt({ redirectPath }: { redirectPath?: string }) {
	const href =
		redirectPath && redirectPath !== "/"
			? `/login?redirect_url=${encodeURIComponent(redirectPath)}`
			: "/login";
	return (
		<Card class="max-w-md mx-auto my-8 p-6 items-start gap-3">
			<h2 class="m-0 text-base font-semibold text-text-strong">Sign in required</h2>
			<p class="m-0 text-sm text-text-muted">
				Sign in with your email and password to view your workspaces and projects.
			</p>
			<Button as="a" href={href} variant="primary" size="sm">
				Sign in
			</Button>
		</Card>
	);
}
