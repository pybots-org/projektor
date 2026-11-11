import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginForm, { safeRedirectUrl } from "./LoginForm";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function mockAuthFetch(opts: {
	status: {
		passwordAuth?: boolean;
		hasUsersWithPasswords: boolean;
		allowSignup: boolean;
		cfAccessConfigured?: boolean;
		adminSetupRestricted?: boolean;
	};
	meStatus?: number;
	meBody?: unknown;
	submitStatus?: number;
	submitBody?: unknown;
}) {
	const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
		const u = String(url);
		if (u === "/auth/status") {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({
						passwordAuth: true,
						cfAccessConfigured: false,
						adminSetupRestricted: false,
						...opts.status,
					}),
			});
		}
		if (u === "/auth/me") {
			const s = opts.meStatus ?? 401;
			return Promise.resolve({
				ok: s >= 200 && s < 300,
				status: s,
				json: () => Promise.resolve(opts.meBody ?? { error: "Unauthorized" }),
			});
		}
		if (init?.method === "POST") {
			const s = opts.submitStatus ?? 200;
			return Promise.resolve({
				ok: s >= 200 && s < 300,
				status: s,
				json: () =>
					Promise.resolve(
						opts.submitBody ?? { user: { id: "u1", email: "mmvarma@pybots.ai", name: "Mani" } }
					),
			});
		}
		return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("safeRedirectUrl", () => {
	it("allows safe relative paths and rejects external or protocol-relative URLs", () => {
		expect(safeRedirectUrl(null)).toBe("/");
		expect(safeRedirectUrl("/my-issues?open=1")).toBe("/my-issues?open=1");
		expect(safeRedirectUrl("https://evil.example.com")).toBe("/");
		expect(safeRedirectUrl("//evil.example.com")).toBe("/");
	});
});

describe("LoginForm", () => {
	it("renders first-time admin setup when no password users exist and submits to /auth/setup", async () => {
		const fetchMock = mockAuthFetch({
			status: { hasUsersWithPasswords: false, allowSignup: false, adminSetupRestricted: true },
			submitStatus: 201,
		});
		const assign = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...originalLocation, assign },
		});

		try {
			render(<LoginForm />);
			await screen.findByRole("heading", { name: "Create admin account" });

			fireEvent.input(screen.getByLabelText(/^Email/i), {
				target: { value: "mmvarma@pybots.ai" },
			});
			fireEvent.input(screen.getByLabelText(/^Password/i), {
				target: { value: "StrongPassword1!" },
			});
			fireEvent.input(screen.getByLabelText(/Confirm password/i), {
				target: { value: "StrongPassword1!" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Create admin account" }));

			await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
			const setupCall = fetchMock.mock.calls.find(([u]) => u === "/auth/setup");
			expect(setupCall).toBeTruthy();
			expect(JSON.parse(String((setupCall?.[1] as RequestInit | undefined)?.body))).toEqual({
				email: "mmvarma@pybots.ai",
				password: "StrongPassword1!",
			});
		} finally {
			Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
		}
	});

	it("renders sign-in form when users exist and shows server errors on invalid login", async () => {
		mockAuthFetch({
			status: { hasUsersWithPasswords: true, allowSignup: false },
			submitStatus: 401,
			submitBody: { error: "Invalid email or password" },
		});

		render(<LoginForm />);
		await screen.findByRole("heading", { name: "Sign in to Projektor" });

		fireEvent.input(screen.getByLabelText(/^Email/i), { target: { value: "mmvarma@pybots.ai" } });
		fireEvent.input(screen.getByLabelText(/^Password/i), { target: { value: "wrongpass" } });
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText("Invalid email or password")).toBeTruthy();
	});

	it("shows sign-up toggle only when allowSignup is true", async () => {
		mockAuthFetch({
			status: { hasUsersWithPasswords: true, allowSignup: true },
		});

		render(<LoginForm />);
		await screen.findByRole("heading", { name: "Sign in to Projektor" });
		fireEvent.click(screen.getByRole("button", { name: /Need an account\? Sign up/i }));
		expect(await screen.findByRole("heading", { name: "Create account" })).toBeTruthy();
	});
});
