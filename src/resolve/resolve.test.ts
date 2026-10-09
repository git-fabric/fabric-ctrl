import { describe, expect, it } from "vitest";
import { createInventory, type InventorySnapshot } from "./inventory.js";
import { lexicalMatcher, terms } from "./matcher.js";
import { buildPlan } from "./plan.js";
import { ResolveInput, ResolveOutput, gapSignature, type CapabilityRecord, type Health } from "./schema.js";

const R = { readOnlyHint: true };
const W = { readOnlyHint: false, destructiveHint: false };

function rec(app: string, tool: string, description: string, annotations?: CapabilityRecord["annotations"], health: Health = "up"): CapabilityRecord {
  return {
    app, tool, description, annotations, health,
    inputSchemaHash: "0", requiredScopes: [], origin: "registry", lastSeen: "2026-10-08T00:00:00.000Z",
  };
}

const RECORDS: CapabilityRecord[] = [
  rec("proxmox", "pve_list_vms", "List VMs — all nodes or a specific node.", R),
  rec("proxmox", "pve_get_vm_status", "Get current status of a VM.", R),
  rec("proxmox", "pve_reboot_vm", "Reboot a VM.", W),
  rec("proxmox", "pve_create_vm_snapshot", "Create a snapshot of a VM.", W),
  rec("proxmox", "pve_list_containers", "List LXC containers on a node.", R),
  rec("proxmox", "pve_list_vm_snapshots", "List snapshots for a VM.", R),
  rec("k8s", "k8s_list_pods", "List pods, optionally filtered by namespace.", R),
  rec("k8s", "k8s_pod_problems", "List pods that are failing, crashing, or not ready.", R),
  rec("unifi", "unifi_list_devices", "List all UniFi network devices (APs, switches, gateways, PDUs) as a flat list.", R),
  rec("cloudflare", "cf_purge_cache", "Purge cache for a zone. Purge everything or specific files/tags/hosts."),
];

function snap(overrides: Partial<InventorySnapshot> = {}): InventorySnapshot {
  return {
    generatedAt: "2026-10-08T00:00:00.000Z", ttlSeconds: 300, apps: 4,
    records: RECORDS, loadedModels: new Set(), stale: false, ...overrides,
  };
}

const resolve = (intent: string, constraints: Record<string, unknown> = {}, s = snap()) =>
  ResolveOutput.parse(buildPlan(ResolveInput.parse({ intent, constraints }), s, lexicalMatcher));

describe("matcher", () => {
  it("stems, aliases and drops stopwords", () => {
    expect(terms("Restart the VMs on my cluster")).toEqual(["reboot", "vm", "cluster"]);
  });

  it("ranks the most specific tool first", () => {
    const [top] = lexicalMatcher.match("list the proxmox vms", RECORDS);
    expect(top.record.tool).toBe("pve_list_vms");
    expect(top.score).toBe(1);
  });

  it("reports intent terms no tool mentions", () => {
    expect(lexicalMatcher.unknownTerms("add a firewall rule on opnsense", RECORDS)).toEqual(["add", "firewall", "opnsense", "rule"]);
  });
});

describe("buildPlan", () => {
  it("answers have with a single read step", () => {
    const out = resolve("list the proxmox vms");
    expect(out.verdict).toBe("have");
    expect(out.plan).toHaveLength(1);
    expect(out.plan[0]).toMatchObject({ tool: "pve_list_vms", effect: "read", effectSource: "annotation", scope: "unknown", route: { local: false, model: "proxmox-ops" } });
    expect(out.missing).toEqual([]);
    expect(out.confidence).toBe(1);
    expect(out.escalation.recommended).toBe("claude");
  });

  it("recommends local when the app's model is loaded", () => {
    const out = resolve("list the proxmox vms", {}, snap({ loadedModels: new Set(["proxmox-ops"]) }));
    expect(out.plan[0].route.local).toBe(true);
    expect(out.escalation.recommended).toBe("local");
  });

  it("lowers confidence for a write with unknown scope", () => {
    const out = resolve("restart a vm");
    expect(out.plan.map((s) => s.tool)).toEqual(["pve_reboot_vm"]);
    expect(out.verdict).toBe("have");
    expect(out.confidence).toBe(0.9);
  });

  it("denies writes under readOnly, and every step blocked means missing", () => {
    const out = resolve("reboot the vm", { readOnly: true });
    expect(out.missing).toMatchObject([{ kind: "policy_denied", step: 1 }]);
    expect(out.verdict).toBe("missing");
  });

  it("treats unannotated tools as writes", () => {
    const out = resolve("purge the cloudflare cache", { readOnly: true });
    expect(out.plan[0]).toMatchObject({ tool: "cf_purge_cache", effect: "write", effectSource: "default" });
    expect(out.missing[0].detail).toContain("unannotated");
  });

  it("reports app_down with a restore suggestion", () => {
    const records = RECORDS.map((r) => (r.app === "proxmox" ? { ...r, health: "down" as const } : r));
    const out = resolve("list the proxmox vms", {}, snap({ records }));
    expect(out.missing[0]).toMatchObject({ kind: "app_down", step: 1, suggestion: { type: "restore_app", target: "git-fabric/proxmox" } });
    expect(out.verdict).toBe("missing");
  });

  it("reports stale inventory as stale_inventory", () => {
    const records = RECORDS.map((r) => ({ ...r, health: "unknown" as const }));
    const out = resolve("list pods", {}, snap({ records, stale: true }));
    expect(out.missing.every((g) => g.kind === "stale_inventory")).toBe(true);
    expect(out.verdict).toBe("missing");
  });

  it("orders reads before writes within an app", () => {
    const out = resolve("vm status and snapshot");
    const tools = out.plan.map((s) => s.tool);
    expect(tools.indexOf("pve_get_vm_status")).toBeLessThan(tools.indexOf("pve_create_vm_snapshot"));
    const write = out.plan.find((s) => s.tool === "pve_create_vm_snapshot")!;
    expect(write.dependsOn).toContain(out.plan.find((s) => s.tool === "pve_get_vm_status")!.order);
  });

  it("marks cross-app plans advisory and escalates to Claude", () => {
    const out = resolve("list pods and vms");
    expect(new Set(out.plan.map((s) => s.app))).toEqual(new Set(["k8s", "proxmox"]));
    expect(out.verdict).toBe("partial");
    expect(out.confidence).toBeLessThan(0.6);
    expect(out.missing.some((g) => g.kind === "low_confidence")).toBe(true);
    expect(out.escalation.recommended).toBe("claude");
  });

  it("answers missing with a build_app gap for unknown capabilities", () => {
    const out = resolve("add a firewall rule on opnsense");
    expect(out.verdict).toBe("missing");
    expect(out.plan).toEqual([]);
    expect(out.missing[0]).toMatchObject({ kind: "no_tool", suggestion: { type: "build_app", target: "add-firewall-opnsense-rule" } });
    expect(out.escalation.recommended).toBe("none");
  });

  it("dedupes reworded intents to one gap signature", () => {
    const a = resolve("add a firewall rule on opnsense").missing[0].signature;
    const b = resolve("on opnsense, add a rule to the firewall").missing[0].signature;
    expect(a).toBe(b);
    expect(a).toBe(gapSignature("no_tool", "add-firewall-opnsense-rule"));
  });

  it("refuses escalation under localOnly", () => {
    const out = resolve("list the proxmox vms", { localOnly: true });
    expect(out.escalation.recommended).toBe("none");
    expect(out.missing).toMatchObject([{ kind: "policy_denied", detail: expect.stringContaining("localOnly") }]);
    expect(out.verdict).toBe("partial");
  });

  it("truncates to maxSteps and says so", () => {
    const out = resolve("list pods and vms", { maxSteps: 1 });
    expect(out.plan).toHaveLength(1);
    expect(out.missing.some((g) => g.detail.includes("maxSteps=1"))).toBe(true);
  });

  it("picks one tool when one covers the intent, preferring the specific name", () => {
    expect(resolve("list the proxmox vms").plan.map((s) => s.tool)).toEqual(["pve_list_vms"]);
  });

  it("covers every part of a compound intent", () => {
    const out = resolve("purge cloudflare cache and list pods");
    expect(out.plan.map((s) => s.tool)).toEqual(["cf_purge_cache", "k8s_list_pods"]);
    expect(out.verdict).toBe("partial");
  });

  it("is deterministic", () => {
    expect(resolve("vm status and snapshot")).toEqual(resolve("vm status and snapshot"));
  });
});

describe("inventory", () => {
  const app = (name: string, status: string | Error) => ({
    name, version: "0", description: "",
    tools: [{ name: `${name.split("/")[1]}_list`, description: "List things.", inputSchema: {}, annotations: R, execute: async () => 0 }],
    health: async () => { if (status instanceof Error) throw status; return { app: name, status }; },
  });

  it("maps health, short names and loaded models, and goes stale after the TTL", async () => {
    let t = 1_000_000;
    const inv = createInventory(() => [app("@git-fabric/proxmox", "healthy"), app("@git-fabric/k8s", new Error("boom"))], {
      ttlSeconds: 60, refreshMs: 0, now: () => t, listModels: async () => ["proxmox-ops"],
    });
    const s = await inv.snapshot();
    expect(s.records.map((r) => [r.app, r.health])).toEqual([["proxmox", "up"], ["k8s", "down"]]);
    expect(s.loadedModels.has("proxmox-ops")).toBe(true);
    expect(s.stale).toBe(false);

    t += 61_000;
    const later = await inv.snapshot();
    expect(later.stale).toBe(true);
    expect(later.records.every((r) => r.health === "unknown")).toBe(true);
    inv.stop();
  });
});
