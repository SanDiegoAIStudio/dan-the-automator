import { diagnose, propose } from "./diagnose";
import { readKillSwitch } from "./kill-switch";
import {
  JobStatus,
  serializeJob,
  type ActionJob,
  type Diagnosis,
  type JobStatusType,
  type ProposedAction,
  type Signal,
} from "./types";

const OPEN_STATUSES: ReadonlySet<JobStatusType> = new Set([
  JobStatus.PENDING,
  JobStatus.HELD,
  JobStatus.DIAGNOSING,
  JobStatus.PROPOSED,
]);

let lastStamp = 0;

function nowStamp(): Date {
  const now = Date.now();
  const next = now > lastStamp ? now : lastStamp + 1;
  lastStamp = next;
  return new Date(next);
}

function sanitizeForLog(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ");
}

function openMatch(jobs: Map<string, ActionJob>, signal: Signal): ActionJob | undefined {
  if (signal.ref === undefined || signal.ref.length === 0) return undefined;
  for (const job of jobs.values()) {
    if (!OPEN_STATUSES.has(job.status)) continue;
    if (job.signal.source === signal.source && job.signal.ref === signal.ref) return job;
  }
  return undefined;
}

function assertMutable(job: ActionJob, next: JobStatusType): void {
  if (job.status === JobStatus.REPORTED || job.status === JobStatus.REJECTED) {
    throw new Error(`job ${job.id} is ${job.status} and cannot change state again`);
  }
  if (job.status === JobStatus.APPROVED && next !== JobStatus.REPORTED) {
    throw new Error(`job ${job.id} is approved and cannot change state again`);
  }
}

export class ActionQueue {
  private jobs: Map<string, ActionJob> = new Map();

  /**
   * Move held jobs to the proposal step when this process sees the switch clear.
   * Order is ingest time, then id. Call this on ks off in this process, and on
   * ingest or a job listing after an expiry.
   */
  releaseHeldIfClear(): ActionJob[] {
    const ks = readKillSwitch();
    if (ks.blocksWork) return [];
    const held = [...this.jobs.values()]
      .filter((job) => job.status === JobStatus.HELD)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const released: ActionJob[] = [];
    for (const job of held) {
      try {
        const diagnosis = diagnose(job.signal);
        const proposal = propose(diagnosis, job.signal);
        job.status = JobStatus.PROPOSED;
        job.diagnosis = diagnosis;
        job.proposal = proposal;
        job.error = undefined;
        job.updatedAt = nowStamp();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = JobStatus.FAILED;
        job.error = message;
        job.updatedAt = nowStamp();
      }
      released.push(job);
      console.log(`[Queue] ${job.id} → ${job.status}`);
    }
    return released;
  }

  existingForSignal(signal: Signal): ActionJob | undefined {
    return openMatch(this.jobs, signal);
  }

  enqueue(signal: Signal): ActionJob {
    const existing = openMatch(this.jobs, signal);
    if (existing) return existing;
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = nowStamp();
    const job: ActionJob = {
      id,
      signal,
      status: JobStatus.PENDING,
      createdAt: now,
      updatedAt: now,
      diagnosis: undefined,
      proposal: undefined,
      gate: undefined,
      error: undefined,
    };
    this.jobs.set(id, job);
    console.log(
      `[Queue] ${job.id} ingested from ${sanitizeForLog(signal.source)}: "${sanitizeForLog(signal.title)}"`,
    );
    return job;
  }

  updateStatus(jobId: string, status: JobStatusType): ActionJob | undefined {
    const current = this.jobs.get(jobId);
    if (!current) return undefined;
    assertMutable(current, status);
    current.status = status;
    current.updatedAt = nowStamp();
    console.log(`[Queue] ${current.id} → ${current.status}`);
    return current;
  }

  setProposal(jobId: string, diagnosis: Diagnosis, proposal: ProposedAction): ActionJob | undefined {
    const current = this.jobs.get(jobId);
    if (!current) return undefined;
    assertMutable(current, JobStatus.PROPOSED);
    current.status = JobStatus.PROPOSED;
    current.diagnosis = diagnosis;
    current.proposal = proposal;
    current.error = undefined;
    current.updatedAt = nowStamp();
    console.log(`[Queue] ${current.id} → ${current.status}`);
    return current;
  }

  hold(jobId: string, reason: string): ActionJob | undefined {
    const current = this.jobs.get(jobId);
    if (!current) return undefined;
    assertMutable(current, JobStatus.HELD);
    current.status = JobStatus.HELD;
    current.error = reason;
    current.updatedAt = nowStamp();
    console.log(`[Queue] ${current.id} → ${current.status}`);
    return current;
  }

  fail(jobId: string, error: string): ActionJob | undefined {
    const current = this.jobs.get(jobId);
    if (!current) return undefined;
    assertMutable(current, JobStatus.FAILED);
    current.status = JobStatus.FAILED;
    current.error = error;
    current.updatedAt = nowStamp();
    console.log(`[Queue] ${current.id} → ${current.status}`);
    return current;
  }

  gate(jobId: string, decision: "approved" | "rejected", reason: string): ActionJob | undefined {
    const current = this.jobs.get(jobId);
    if (!current) return undefined;
    if (
      current.status === JobStatus.APPROVED ||
      current.status === JobStatus.REJECTED ||
      current.status === JobStatus.REPORTED
    ) {
      throw new Error(`job ${current.id} is ${current.status} and cannot change state again`);
    }
    if (current.status !== JobStatus.PROPOSED) {
      throw new Error(`job ${jobId} is ${current.status}. A decision applies to a proposed job.`);
    }
    const next = decision === "approved" ? JobStatus.APPROVED : JobStatus.REJECTED;
    assertMutable(current, next);
    current.status = next;
    current.gate = { decidedBy: "human", decision, reason };
    current.updatedAt = nowStamp();
    console.log(`[Queue] ${current.id} → ${current.status}`);
    return current;
  }

  markReported(jobId: string): ActionJob | undefined {
    return this.updateStatus(jobId, JobStatus.REPORTED);
  }

  getJob(jobId: string): ActionJob | undefined {
    this.releaseHeldIfClear();
    return this.jobs.get(jobId);
  }

  getJobByRef(ref: string): ActionJob | undefined {
    this.releaseHeldIfClear();
    for (const job of this.jobs.values()) {
      if (job.signal.ref === ref) return job;
    }
    return undefined;
  }

  getAllJobs(status?: JobStatusType): ActionJob[] {
    this.releaseHeldIfClear();
    const jobs = Array.from(this.jobs.values());
    if (status) return jobs.filter((job) => job.status === status);
    return jobs;
  }

  listJobs(status?: JobStatusType): ReturnType<typeof serializeJob>[] {
    this.releaseHeldIfClear();
    const listed: ReturnType<typeof serializeJob>[] = [];
    for (const job of this.jobs.values()) {
      if (status && job.status !== status) continue;
      listed.push(serializeJob(job));
    }
    return listed;
  }

  stats(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const job of this.jobs.values()) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
    }
    return counts;
  }

  clear(): void {
    this.jobs = new Map();
  }
}

export const actionQueue = new ActionQueue();
