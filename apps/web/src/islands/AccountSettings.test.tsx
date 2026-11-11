import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountSettings from "./AccountSettings";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("AccountSettings", () => {
	it("shows profile details and submits password updates", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/auth/me")) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () =>
						Promise.resolve({
							user: { id: "u1", email: "mmvarma@pybots.ai", name: "Mani Varma" },
							workspaces: [{ id: "w1", name: "Projektor", slug: "projektor", role: "owner" }],
							authMethod: "password",
						}),
				});
			}
			if (u.includes("/auth/password") && init?.method === "POST") {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ ok: true }),
				});
			}
			return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<AccountSettings />);
		expect(await screen.findByText("mmvarma@pybots.ai")).toBeTruthy();

		fireEvent.input(screen.getByLabelText(/Current password/i), {
			target: { value: "OldPassword1!" },
		});
		fireEvent.input(screen.getByLabelText(/^New password/i), {
			target: { value: "NewPassword2!" },
		});
		fireEvent.input(screen.getByLabelText(/Confirm new password/i), {
			target: { value: "NewPassword2!" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Update password" }));

		expect(await screen.findByRole("status")).toBeTruthy();
		await waitFor(() => {
			const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/auth/password"));
			expect(call).toBeTruthy();
			expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({
				currentPassword: "OldPassword1!",
				newPassword: "NewPassword2!",
			});
		});
	});
});
