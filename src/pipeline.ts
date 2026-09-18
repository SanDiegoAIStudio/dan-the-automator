import { diagnose, propose } from "./diagnose";
import { readKillSwitch } from "./kill-switch";
import { notifyJobUpdate, notifySignalIngested } from "./notify/slack";
import { actionQueue } from "./queue";
import { JobStatus, type ActionJob, type Signal } from "./types";

export function ingestSignal(signal: Signal, options?: { notify?: boolean }): ActionJob {
  const job = actionQueue.enqueue(signal);
  runPipeline(job);

  if (options?.notify !== false) {
    void notifySignalIngested(job);
    if (job.status === JobStatus.PROPOSED) {
      void notifyJobUpdate(job, "proposal ready — waiting on a human gate");
    }
  }

  return job;
}

export function runPipeline(job: ActionJob): ActionJob {
  const ks = readKillSwitch();
  if (ks.blocksWork) {
    const reason = ks.state.reason || "kill-switch active";
    actionQueue.hold(job.id, reason);
    return actionQueue.getJob(job.id) ?? job;
  }

  try {
    actionQueue.updateStatus(job.id, JobStatus.DIAGNOSING);
    const diagnosis = diagnose(job.signal);
    const proposal = propose(diagnosis, job.signal);
    actionQueue.setProposal(job.id, diagnosis, proposal);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    actionQueue.fail(job.id, message);
  }

  return actionQueue.getJob(job.id) ?? job;
}

export function decideJob(jobId: string, decision: "approved" | "rejected", reason: string): ActionJob {
  const updated = actionQueue.gate(jobId, decision, reason);
  if (!updated) {
    throw new Error(`job not found: ${jobId}`);
  }
  if (decision === "approved") {
    actionQueue.markReported(jobId);
  }
  const finalJob = actionQueue.getJob(jobId);
  if (!finalJob) {
    throw new Error(`job vanished: ${jobId}`);
  }
  void notifyJobUpdate(finalJob, decision === "approved" ? "human approved — recorded" : "human rejected");
  return finalJob;
}
