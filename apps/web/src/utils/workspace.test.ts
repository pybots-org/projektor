import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resetKnownWorkspaceSlugs,
	resolveWorkspaceSlug,
	setKnownWorkspaceSlugs,
	workspaceQueryParam,
} from "./workspace";

function stubHost(hostname: string) {
	vi.stubGlobal("location", { hostname } as Location);
}

afterEach(() => {
	resetKnownWorkspaceSlugs();
	vi.unstubAllGlobals();
});

describe("resolveWorkspaceSlug", () => {
	it("prefers an explicit build-time slug over the hostname", () => {
		stubHost("projektor.example.workers.dev");
		setKnownWorkspaceSlugs(["other-ws"]);
		expect(resolveWorkspaceSlug("acme")).toBe("acme");
	});

	it("falls back to the hostname's first label when no slug is baked in", () => {
		stubHost("projektor.tajdickson.workers.dev");
		expect(resolveWorkspaceSlug(undefined)).toBe("projektor");
	});

	it("returns '' for hosts with no tenant subdomain", () => {
		for (const h of ["localhost", "127.0.0.1", "example"]) {
			stubHost(h);
			expect(resolveWorkspaceSlug(undefined)).toBe("");
		}
	});

	it("uses discovered workspace slug on custom domains or localhost, while honoring matching subdomains", () => {
		setKnownWorkspaceSlugs(["alpha", "beta"]);

		// Matching subdomain wins in multi-tenant hosts
		stubHost("beta.example.com");
		expect(resolveWorkspaceSlug(undefined)).toBe("beta");

		// Custom domain whose first label doesn't match falls back to discovered workspace
		stubHost("pm.company.com");
		expect(resolveWorkspaceSlug(undefined)).toBe("alpha");

		// Localhost falls back once discovered
		stubHost("localhost");
		expect(resolveWorkspaceSlug(undefined)).toBe("alpha");
	});

	it("formats encoded workspace query params with configurable prefix", () => {
		stubHost("my ws.example.com");
		expect(workspaceQueryParam(undefined)).toBe("?workspace=my%20ws");
		expect(workspaceQueryParam("acme", "&")).toBe("&workspace=acme");
		stubHost("localhost");
		expect(workspaceQueryParam(undefined)).toBe("");
	});
});
