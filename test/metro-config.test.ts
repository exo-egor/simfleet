import { describe, expect, test } from "bun:test";
import { resolveMetroCommand } from "../src/config";

describe("Metro lane command", () => {
  test("starts React Native CLI in the app directory with a distinct leased port", () => {
    const metro = {
      driver: "react-native" as const,
      cwd: "apps/mobile/src",
      command: ["pnpm", "metro", "--port", "{port}"],
    };
    expect(resolveMetroCommand(metro, "/tmp/agent-a", {
      environment: "development", mode: "debug", port: 8100,
    })).toEqual({
      driver: "react-native",
      cwd: "/tmp/agent-a/apps/mobile/src",
      command: "pnpm",
      args: ["metro", "--port", "8100"],
    });
    expect(resolveMetroCommand(metro, "/tmp/agent-b", {
      environment: "development", mode: "debug", port: 8101,
    }).args).toContain("8101");
  });

  test("rejects a Metro directory outside its worktree", () => {
    expect(() => resolveMetroCommand({ cwd: "../other" }, "/tmp/agent-a", {
      environment: "development", mode: "debug", port: 8100,
    })).toThrow("Metro cwd must stay within the worktree");
  });

  test("rejects a custom command that cannot use its leased port", () => {
    expect(() => resolveMetroCommand({ driver: "react-native", command: ["pnpm", "metro"] },
      "/tmp/agent-a", { environment: "development", mode: "debug", port: 8100 },
    )).toThrow("Metro command must include {port}");
  });
});
