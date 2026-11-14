import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentConfigDashboardView } from "../src/app/settings/agent-config-dashboard";

const types = [
  { type: "claude", label: "Claude", defaultResumeOnModelChange: true, allowedCustomPrefixes: ["ANTHROPIC_"], envFields: [] },
  { type: "codex", label: "Codex", defaultResumeOnModelChange: true, allowedCustomPrefixes: ["OPENAI_", "CODEX_"], envFields: [] },
] as const;

describe("AgentConfigDashboardView", () => {
  test("renders setup-required guidance and all supported types", () => {
    const html = renderToStaticMarkup(createElement(AgentConfigDashboardView, {
      status: { status: "setup_required", active: null },
      types,
      profiles: [],
      onCreate: async () => undefined,
      onTest: async () => undefined,
      onActivate: async () => undefined,
      onDelete: async () => undefined,
    }));
    expect(html).toContain("Agent setup required");
    expect(html).toContain("Claude");
    expect(html).toContain("Codex");
    expect(html).not.toContain("Codex (fixed args)");
    expect(html).toContain("New Profile");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Search profiles");
  });

  test("shows the active profile and gates activation on validation", () => {
    const profile = {
      id: "profile-1",
      name: "Primary Codex",
      agentType: "codex" as const,
      deletedAt: null,
      createdAt: 1,
      updatedAt: 1,
      latestRevision: {
        id: "revision-1",
        revisionNumber: 1,
        model: "gpt-5",
        resumeOnModelChange: true,
        env: { OPENAI_BASE_URL: "https://api.example.test/v1" },
        secrets: { OPENAI_API_KEY: { configured: true, updatedAt: 1 } },
        configFingerprint: "fingerprint",
        validationState: "invalid",
        validationResult: { message: "Provider rejected credentials (401)" },
        validatedAt: 1,
        createdAt: 1,
      },
    };
    const html = renderToStaticMarkup(createElement(AgentConfigDashboardView, {
      status: { status: "ready", active: { profileId: "profile-1", revisionId: "revision-0", name: "Primary Codex", agentType: "codex", model: "gpt-5", resumeOnModelChange: true } },
      types,
      profiles: [profile],
      onCreate: async () => undefined,
      onTest: async () => undefined,
      onActivate: async () => undefined,
      onDelete: async () => undefined,
    }));
    expect(html).toContain("Current Agent");
    expect(html).toContain("Primary Codex");
    expect(html).toContain("gpt-5");
    expect(html).toContain("Configured (write-only)");
    expect(html).toContain("Test connection");
    expect(html).toContain("Test the connection before activation");
    expect(html).toContain("disabled");
    expect(html).toContain("Earlier revision active");
    expect(html).toContain("Connection failed");
    expect(html).toContain("Provider rejected credentials (401)");
    expect(html).toContain("Edit");
  });
});
