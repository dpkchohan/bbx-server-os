import { defineConfig } from "@trigger.dev/sdk";

// Points the CLI/SDK at our self-hosted Trigger.dev instance.
// Project ref comes from the dashboard after creating a project at
// http://100.31.146.20:8030 — see docs/deployment.md.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_bbx-server-os",
  dirs: ["./src/tasks"],
  maxDuration: 3600, // 1 hour ceiling; individual tasks can override lower
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      factor: 2,
      randomize: true,
    },
  },
});
