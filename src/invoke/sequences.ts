/**
 * invoke/sequences.ts — Embedded sequence registry (SEQ-01 through SEQ-06)
 *
 * Mirrors fabric-router's routing table. Each sequence defines an ordered
 * list of agents to execute. Conditional steps (marked conditional: true)
 * are skipped if the routing context makes them irrelevant.
 */

export interface SequenceStep {
  agent: string;
  type: "recall" | "specialist" | "record";
  conditional?: boolean;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
}

export const SEQUENCES: Record<string, Sequence> = {
  "SEQ-01": {
    id: "SEQ-01",
    name: "CVE Alert → Remediation PR",
    steps: [
      { agent: "cve-ops",      type: "specialist" },
      { agent: "sandfly-ops",  type: "specialist" },
      { agent: "k3s-ops",      type: "specialist" },
      { agent: "github-ops",   type: "specialist" },
      { agent: "aiana-ops",    type: "record" },
    ],
  },

  "SEQ-02": {
    id: "SEQ-02",
    name: "Security Alert → Incident Response",
    steps: [
      { agent: "aiana-ops",    type: "recall" },
      { agent: "sandfly-ops",  type: "specialist" },
      { agent: "cve-ops",      type: "specialist" },
      { agent: "k3s-ops",      type: "specialist" },
      { agent: "github-ops",   type: "specialist" },
      { agent: "aiana-ops",    type: "record" },
    ],
  },

  "SEQ-03": {
    id: "SEQ-03",
    name: "New Repo → Governed Setup",
    steps: [
      { agent: "git-steer-ops",   type: "specialist" },
      { agent: "github-ops",      type: "specialist" },
      { agent: "cloudflare-ops",  type: "specialist", conditional: true },
      { agent: "aiana-ops",       type: "record" },
    ],
  },

  "SEQ-04": {
    id: "SEQ-04",
    name: "Infrastructure Health Check",
    steps: [
      { agent: "unifi-ops",      type: "specialist" },
      { agent: "tailscale-ops",  type: "specialist" },
      { agent: "proxmox-ops",    type: "specialist" },
      { agent: "k3s-ops",        type: "specialist" },
      { agent: "sandfly-ops",    type: "specialist" },
      { agent: "git-steer-ops",  type: "specialist" },
      { agent: "aiana-ops",      type: "record" },
    ],
  },

  "SEQ-05": {
    id: "SEQ-05",
    name: "Content Pipeline",
    steps: [
      { agent: "aiana-ops",       type: "recall" },
      { agent: "n8n-ops",         type: "specialist" },
      { agent: "cloudflare-ops",  type: "specialist", conditional: true },
      { agent: "aiana-ops",       type: "record" },
    ],
  },

  "SEQ-06": {
    id: "SEQ-06",
    name: "Homelab Node Bootstrap",
    steps: [
      { agent: "tailscale-ops",  type: "specialist" },
      { agent: "unifi-ops",      type: "specialist" },
      { agent: "proxmox-ops",    type: "specialist" },
      { agent: "k3s-ops",        type: "specialist" },
      { agent: "sandfly-ops",    type: "specialist" },
      { agent: "aiana-ops",      type: "record" },
    ],
  },
};
