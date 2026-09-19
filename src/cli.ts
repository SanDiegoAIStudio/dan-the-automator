import { SERVICE_NAME, VERSION } from "./config";
import { listHeartbeats, writeHeartbeat } from "./heartbeats";
import { readKillSwitch, setKillSwitch } from "./kill-switch";
import { decideJob, ingestSignal } from "./pipeline";
import { actionQueue } from "./queue";
import { serializeJob, type SignalKindType } from "./types";

const KINDS = new Set<SignalKindType>(["error", "heartbeat", "revenue", "content", "ops", "manual"]);

function print(data: unknown): void {
  if (typeof data === "string") {
    console.log(data);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function usage(): string {
  return `dan — ${SERVICE_NAME} ${VERSION}
San Diego AI Studio / Luc Face. Proposes. A human gates.

  dan health
  dan os
  dan ks status
  dan ks on <reason>
  dan ks off
  dan heartbeat <name> [--cadence 3600]
  dan heartbeats
  dan ingest --title <text> [--kind error|heartbeat|revenue|content|ops|manual] [--source operator] [--file path] [--ref id]
  dan jobs
  dan show <jobId>
  dan approve <jobId>
  dan reject <jobId> [--reason text]
`;
}

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help") {
    print(usage());
    return 0;
  }

  if (cmd === "health") {
    const ks = readKillSwitch();
    const beats = listHeartbeats();
    print({
      service: SERVICE_NAME,
      version: VERSION,
      killSwitch: { active: ks.blocksWork, mode: ks.mode, reason: ks.state.reason },
      heartbeats: { total: beats.beats.length, stale: beats.staleCount },
      queue: actionQueue.stats(),
    });
    return 0;
  }

  if (cmd === "os") {
    const { PROPERTIES, LAYERS } = await import("./properties");
    print({ properties: PROPERTIES.map((p) => p.id), layers: LAYERS.map((l) => l.name) });
    return 0;
  }

  if (cmd === "ks") {
    const sub = rest[0];
    if (sub === "status" || !sub) {
      const ks = readKillSwitch();
      print({ ...ks.state, blocksWork: ks.blocksWork, mode: ks.mode });
      return 0;
    }
    if (sub === "on") {
      const reason = rest.slice(1).join(" ").trim();
      const ks = setKillSwitch({ active: true, reason, setBy: "human" });
      print({ ...ks.state, blocksWork: ks.blocksWork, mode: ks.mode });
      return 0;
    }
    if (sub === "off") {
      const ks = setKillSwitch({ active: false, reason: "", setBy: "human" });
      print({ ...ks.state, blocksWork: ks.blocksWork, mode: ks.mode });
      return 0;
    }
    print("ks on <reason> | ks off | ks status");
    return 1;
  }

  if (cmd === "heartbeat") {
    const name = rest[0];
    if (!name) {
      print("heartbeat <name> [--cadence 3600]");
      return 1;
    }
    const cadenceRaw = flag(rest, "--cadence");
    const cadence = cadenceRaw ? Number(cadenceRaw) : 3600;
    if (!Number.isFinite(cadence) || cadence <= 0) {
      print("cadence must be a positive number of seconds");
      return 1;
    }
    print(writeHeartbeat(name, cadence));
    return 0;
  }

  if (cmd === "heartbeats") {
    print(listHeartbeats());
    return 0;
  }

  if (cmd === "ingest") {
    const title = flag(rest, "--title");
    if (!title) {
      print("ingest --title <text> [--kind manual] [--source operator]");
      return 1;
    }
    const kindRaw = flag(rest, "--kind") ?? "manual";
    if (!KINDS.has(kindRaw as SignalKindType)) {
      print(`unknown kind: ${kindRaw}`);
      return 1;
    }
    const lineRaw = flag(rest, "--line");
    const job = ingestSignal(
      {
        source: flag(rest, "--source") ?? "operator",
        kind: kindRaw as SignalKindType,
        title,
        body: flag(rest, "--body"),
        ref: flag(rest, "--ref"),
        file: flag(rest, "--file"),
        line: lineRaw ? Number(lineRaw) : undefined,
      },
      { notify: false }
    );
    print(serializeJob(job));
    return 0;
  }

  if (cmd === "jobs") {
    print(actionQueue.getAllJobs().map(serializeJob));
    return 0;
  }

  if (cmd === "show") {
    const id = rest[0];
    if (!id) {
      print("show <jobId>");
      return 1;
    }
    const job = actionQueue.getJob(id);
    if (!job) {
      print(`job not found: ${id}`);
      return 1;
    }
    print(serializeJob(job));
    return 0;
  }

  if (cmd === "approve" || cmd === "reject") {
    const id = rest[0];
    if (!id) {
      print(`${cmd} <jobId>`);
      return 1;
    }
    const reason = flag(rest, "--reason") ?? (cmd === "approve" ? "operator approved" : "operator rejected");
    try {
      const job = decideJob(id, cmd === "approve" ? "approved" : "rejected", reason);
      print(serializeJob(job));
      return 0;
    } catch (err: unknown) {
      print(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  print(usage());
  return 1;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
