import { JobStatus, type ActionJob, type Diagnosis, type JobStatusType, type ProposedAction, type Signal } from "./types";

export class ActionQueue {
  private jobs: Map<string, ActionJob> = new Map();

  enqueue(signal: Signal): ActionJob {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
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
    console.log(`[Queue] ${id} ingested from ${signal.source}: "${signal.title}"`);
    return job;
  }

  updateStatus(jobId: string, status: JobStatusType): ActionJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    job.status = status;
    job.updatedAt = new Date();
    console.log(`[Queue] ${jobId} → ${status}`);
    return job;
  }

  setProposal(jobId: string, diagnosis: Diagnosis, proposal: ProposedAction): ActionJob | undefined {
    const job = this.updateStatus(jobId, JobStatus.PROPOSED);
    if (!job) return undefined;
    job.diagnosis = diagnosis;
    job.proposal = proposal;
    return job;
  }

  hold(jobId: string, reason: string): ActionJob | undefined {
    const job = this.updateStatus(jobId, JobStatus.HELD);
    if (!job) return undefined;
    job.error = reason;
    return job;
  }

  fail(jobId: string, error: string): ActionJob | undefined {
    const job = this.updateStatus(jobId, JobStatus.FAILED);
    if (!job) return undefined;
    job.error = error;
    return job;
  }

  gate(jobId: string, decision: "approved" | "rejected", reason: string): ActionJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (job.status !== JobStatus.PROPOSED) {
      throw new Error(`job ${jobId} is ${job.status}, not proposed`);
    }
    job.gate = { decidedBy: "human", decision, reason };
    job.status = decision === "approved" ? JobStatus.APPROVED : JobStatus.REJECTED;
    job.updatedAt = new Date();
    return job;
  }

  markReported(jobId: string): ActionJob | undefined {
    return this.updateStatus(jobId, JobStatus.REPORTED);
  }

  getJob(jobId: string): ActionJob | undefined {
    return this.jobs.get(jobId);
  }

  getJobByRef(ref: string): ActionJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.signal.ref === ref) return job;
    }
    return undefined;
  }

  getAllJobs(status?: JobStatusType): ActionJob[] {
    const jobs = Array.from(this.jobs.values());
    if (status) return jobs.filter((j) => j.status === status);
    return jobs;
  }

  stats(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const job of this.jobs.values()) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
    }
    return counts;
  }

  clear(): void {
    this.jobs.clear();
  }
}

export const actionQueue = new ActionQueue();
