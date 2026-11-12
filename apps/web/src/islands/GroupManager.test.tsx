// GroupManager island — mock-fetch tests for the group rename control.
//
// The detail editor is admin-only, so the workspace stub reports currentUserRole
// "owner". Clicking the group name in the table opens the editor; the name input
// is seeded from the fetched detail.
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import GroupManager from "./GroupManager";

const GROUP = {
	id: "g1",
	name: "Engineering",
	description: null,
	memberCount: 1,
	grantCount: 1,
};

const DETAIL = {
	...GROUP,
	members: [{ userId: "u1", email: "alice@example.com", name: "Alice" }],
	grants: [{ projectId: "p1", projectName: "Apollo", projectKey: "APO", role: "member" }],
};

function mockFetch() {
	const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
		const u = String(url);
		const json = (body: unknown) =>
			Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

		if (u.includes("/groups/g1")) {
			if (init?.method === "PATCH") return json({ ...DETAIL, name: "Platform" });
			return json(DETAIL);
		}
		if (u.includes("/member-groups")) return json([]);
		if (u.includes("/groups")) return json([GROUP]);
		if (u.includes("/api/projects")) return json([{ id: "p1", name: "Apollo", key: "APO" }]);
		return json({ currentUserRole: "owner", members: [] });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function openEditor() {
	await screen.findByRole("table");
	const nameButtons = await screen.findAllByRole("button", { name: "Engineering" });
	fireEvent.click(nameButtons[0]);
	return (await screen.findByLabelText(/Group name/i)) as HTMLInputElement;
}

describe("GroupManager rename", () => {
	it("seeds the name input from the loaded group detail", async () => {
		mockFetch();
		render(<GroupManager workspaceSlug="my-ws" />);
		expect((await openEditor()).value).toBe("Engineering");
	});

	it("disables Rename until the name actually changes", async () => {
		mockFetch();
		render(<GroupManager workspaceSlug="my-ws" />);
		const input = await openEditor();
		const button = screen.getByRole("button", { name: /^Rename$/ }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);

		fireEvent.input(input, { target: { value: "Platform" } });
		expect(button.disabled).toBe(false);
	});

	it("keeps Rename disabled for a blank or whitespace-only name", async () => {
		mockFetch();
		render(<GroupManager workspaceSlug="my-ws" />);
		const input = await openEditor();
		fireEvent.input(input, { target: { value: "   " } });
		expect((screen.getByRole("button", { name: /^Rename$/ }) as HTMLButtonElement).disabled).toBe(
			true
		);
	});

	it("PATCHes the group with the trimmed name", async () => {
		const fetchMock = mockFetch();
		render(<GroupManager workspaceSlug="my-ws" />);
		const input = await openEditor();

		fireEvent.input(input, { target: { value: "  Platform  " } });
		fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));

		await vi.waitFor(() => {
			const patch = fetchMock.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
			);
			expect(patch).toBeTruthy();
			expect(String(patch?.[0])).toContain("/groups/g1");
			const init = patch?.[1] as RequestInit | undefined;
			expect(JSON.parse(String(init?.body))).toEqual({ name: "Platform" });
		});
	});
});

// PROJ-343: Members and Groups now render as separate tabs, defaulting to
// Groups so the flows above stay reachable without switching tabs first.
const REGULAR_MEMBER = { id: "u2", email: "mo@example.com", name: "Mo Member", role: "member" };

function mockFetchForTabs(opts: Readonly<{ role: string }>) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			const json = (body: unknown) =>
				Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
			if (u.includes("/member-groups")) {
				return json([{ userId: "u2", groups: [{ id: "g1", name: "Engineering" }] }]);
			}
			if (u.includes("/groups")) return json([GROUP]);
			if (u.includes("/api/projects")) return json([]);
			return json({ members: [REGULAR_MEMBER], currentUserRole: opts.role });
		})
	);
}

describe("GroupManager tabs", () => {
	it("renders both Members and Groups tabs for an admin, defaulting to Groups", async () => {
		mockFetchForTabs({ role: "admin" });
		render(<GroupManager workspaceSlug="my-ws" />);

		const groupsTab = await screen.findByRole("tab", { name: "Groups" });
		const membersTab = screen.getByRole("tab", { name: "Members" });
		expect(groupsTab.getAttribute("aria-selected")).toBe("true");
		expect(membersTab.getAttribute("aria-selected")).toBe("false");

		expect(screen.getAllByText("Engineering").length).toBeGreaterThan(0);
		expect(screen.queryByText("Mo Member")).toBeNull();
	});

	it("shows the Members panel and hides Groups when the Members tab is clicked", async () => {
		mockFetchForTabs({ role: "admin" });
		render(<GroupManager workspaceSlug="my-ws" />);

		await screen.findAllByText("Engineering");
		fireEvent.click(screen.getByRole("tab", { name: "Members" }));

		expect((await screen.findAllByText("Mo Member")).length).toBeGreaterThan(0);
		expect(screen.queryByPlaceholderText("New group name")).toBeNull();
		expect(screen.getByRole("tab", { name: "Members" }).getAttribute("aria-selected")).toBe("true");
	});

	it("shows no Members tab (or tablist) for a non-admin caller", async () => {
		mockFetchForTabs({ role: "member" });
		render(<GroupManager workspaceSlug="my-ws" />);

		await screen.findByText("Your groups");
		expect(screen.queryByRole("tab", { name: "Members" })).toBeNull();
		expect(screen.queryByRole("tablist")).toBeNull();
	});

	it("renders a mobile-card fallback for the groups table", async () => {
		mockFetchForTabs({ role: "admin" });
		render(<GroupManager workspaceSlug="my-ws" />);
		// Desktop table + mobile card both render (CSS hides one per viewport).
		expect((await screen.findAllByText("Engineering")).length).toBe(2);
	});

	it("renders a mobile-card fallback for the members table", async () => {
		mockFetchForTabs({ role: "admin" });
		render(<GroupManager workspaceSlug="my-ws" />);
		await screen.findAllByText("Engineering");
		fireEvent.click(screen.getByRole("tab", { name: "Members" }));
		expect((await screen.findAllByText("Mo Member")).length).toBe(2);
	});

	it("lets an admin create or set a member password via POST /auth/users", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			const json = (body: unknown) =>
				Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
			if (u.includes("/auth/users") && init?.method === "POST") {
				return json({
					user: { id: "u3", email: "new@example.com", name: "New", role: "member" },
					created: true,
					passwordSet: true,
				});
			}
			if (u.includes("/auth/users")) {
				return json({ users: [{ ...REGULAR_MEMBER, hasPassword: true }] });
			}
			if (u.includes("/member-groups")) return json([]);
			if (u.includes("/groups")) return json([GROUP]);
			if (u.includes("/api/projects")) return json([]);
			return json({ members: [REGULAR_MEMBER], currentUserRole: "owner" });
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<GroupManager workspaceSlug="my-ws" />);
		await screen.findAllByText("Engineering");
		fireEvent.click(screen.getByRole("tab", { name: "Members" }));

		fireEvent.input(await screen.findByLabelText(/^Email/i), {
			target: { value: "new@example.com" },
		});
		fireEvent.input(screen.getByLabelText(/^Initial password/i), {
			target: { value: "StrongPassword1!" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save user" }));

		await vi.waitFor(() => {
			const postCall = fetchMock.mock.calls.find(
				([u, init]) =>
					String(u).includes("/auth/users") && (init as RequestInit | undefined)?.method === "POST"
			);
			expect(postCall).toBeTruthy();
			expect(JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body))).toMatchObject({
				email: "new@example.com",
				role: "member",
				password: "StrongPassword1!",
				workspaceSlug: "my-ws",
			});
		});

		const copyBtn = await screen.findByRole("button", { name: "Copy login info" });
		expect(screen.getByText(/Password: StrongPassword1!/)).toBeTruthy();

		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		fireEvent.click(copyBtn);
		await vi.waitFor(() => {
			expect(writeText).toHaveBeenCalledTimes(1);
		});
		expect(writeText.mock.calls[0]?.[0]).toContain("Email: new@example.com");
		expect(writeText.mock.calls[0]?.[0]).toContain("Password: StrongPassword1!");
		expect(writeText.mock.calls[0]?.[0]).toContain("/login");
		expect(await screen.findByRole("button", { name: "Copied!" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
	});

	it("generates a strong password and shows copyable login info after password reset", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			const json = (body: unknown) =>
				Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
			if (u.includes("/auth/users") && init?.method === "POST") {
				return json({
					user: { id: "u2", email: "mo@example.com", name: "Mo Member", role: "member" },
					created: false,
					passwordSet: true,
				});
			}
			if (u.includes("/auth/users")) {
				return json({ users: [{ ...REGULAR_MEMBER, hasPassword: true }] });
			}
			if (u.includes("/member-groups")) return json([]);
			if (u.includes("/groups")) return json([GROUP]);
			if (u.includes("/api/projects")) return json([]);
			return json({ members: [REGULAR_MEMBER], currentUserRole: "owner" });
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<GroupManager workspaceSlug="my-ws" />);
		await screen.findAllByText("Engineering");
		fireEvent.click(screen.getByRole("tab", { name: "Members" }));

		const addInput = (await screen.findByLabelText(/^Initial password/i)) as HTMLInputElement;
		fireEvent.click(screen.getByRole("button", { name: "Generate" }));
		expect(addInput.value.length).toBeGreaterThanOrEqual(8);

		const resetButtons = await screen.findAllByRole("button", { name: /^Reset$/ });
		fireEvent.click(resetButtons[0]);
		const resetInput = (await screen.findByLabelText(
			/New password for mo@example\.com/i
		)) as HTMLInputElement;
		const genButtons = screen.getAllByRole("button", { name: "Generate" });
		fireEvent.click(genButtons[genButtons.length - 1]);
		expect(resetInput.value.length).toBeGreaterThanOrEqual(8);
		const generatedPw = resetInput.value;

		fireEvent.click(screen.getByRole("button", { name: "Save password" }));
		expect(await screen.findByRole("button", { name: "Copy login info" })).toBeTruthy();
		expect(
			screen.getByText(
				new RegExp(`Password: ${generatedPw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
			)
		).toBeTruthy();
	});

	it("lets owners change member roles, disables sole-owner demotion, and keeps roles read-only for admins", async () => {
		const OWNER = { id: "u1", email: "owner@example.com", name: "Olivia Owner", role: "owner" };
		let currentMembers = [OWNER, REGULAR_MEMBER];
		const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			const u = String(url);
			const json = (body: unknown) =>
				Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
			if (u.includes("/members/u2") && init?.method === "PATCH") {
				const parsed = JSON.parse(String(init.body)) as { role: string };
				currentMembers = currentMembers.map((m) =>
					m.id === "u2" ? { ...m, role: parsed.role } : m
				);
				return json({ ok: true });
			}
			if (u.includes("/member-groups")) return json([]);
			if (u.includes("/groups")) return json([GROUP]);
			if (u.includes("/api/projects")) return json([]);
			return json({ members: currentMembers, currentUserRole: "owner", currentUserId: "u1" });
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<GroupManager workspaceSlug="my-ws" />);
		await screen.findAllByText("Engineering");
		fireEvent.click(screen.getByRole("tab", { name: "Members" }));

		const ownerSelects = (await screen.findAllByLabelText(
			"Workspace role for Olivia Owner"
		)) as HTMLSelectElement[];
		expect(ownerSelects[0].disabled).toBe(true);

		const memberSelects = screen.getAllByLabelText(
			"Workspace role for Mo Member"
		) as HTMLSelectElement[];
		expect(memberSelects[0].disabled).toBe(false);
		expect(memberSelects[0].value).toBe("member");

		fireEvent.change(memberSelects[0], { target: { value: "admin" } });
		await vi.waitFor(() => {
			const patchCall = fetchMock.mock.calls.find(
				([u, init]) =>
					String(u).includes("/api/workspaces/my-ws/members/u2") &&
					(init as RequestInit | undefined)?.method === "PATCH"
			);
			expect(patchCall).toBeTruthy();
			expect(JSON.parse(String((patchCall?.[1] as RequestInit | undefined)?.body))).toEqual({
				role: "admin",
			});
		});

		expect(await screen.findByText("Updated role for mo@example.com to admin.")).toBeTruthy();
	});

	it("renders read-only roles when caller is an admin instead of an owner", async () => {
		mockFetchForTabs({ role: "admin" });
		render(<GroupManager workspaceSlug="my-ws" />);
		await screen.findAllByText("Engineering");
		fireEvent.click(screen.getByRole("tab", { name: "Members" }));

		await screen.findAllByText("Mo Member");
		expect(screen.queryByLabelText("Workspace role for Mo Member")).toBeNull();
	});
});
