// File: /runtime/worker.ts
import type { Job, JobResult, MeshMessage, PeerId } from "../types";
import { Sandbox } from "./sandbox";
import { MeshNetwork } from "./mesh";
import { ServerBox } from "../core/serverbox";

export class WorkerManager {
  private jobQueue: Job[] = [];
  private activeJobs = new Map<string, { resolve: (result: any) => void; timeout: NodeJS.Timeout }>();
  private pendingPeers = new Set<PeerId>();
  private peerCapabilities = new Map<
    PeerId,
    {
      cpu: number;
      memory: number;
    }
  >();
  private jobMetrics = {
    totalJobs: 0,
    succeeded: 0,
    failed: 0,
    averageTime: 0,
  };

  constructor(private mesh: MeshNetwork, private sbx: ServerBox) {
    mesh.subscribe("serverbox-jobs", (message: MeshMessage) => {
      if (message.type === "job-result") {
        this.handleJobResult(message.data.from, message.data);
      }
      if (message.type === "job-request") {
        this.handleJobRequest(message.data);
      }
      if (message.type === "job-ready") {
        this.pendingPeers.add(message.data.peerId);
        this.processQueue();
      }
      if (message.type === "capabilities") {
        this.peerCapabilities.set(message.data.peerId, message.data);
      }
    });

    mesh.publish("serverbox-jobs", {
      type: "job-ready",
      data: { peerId: this.mesh.getPeerId() },
    });
  }

  async executeJob(job: Job): Promise<any> {
    if (job.data?.isDistributed) {
      return this.processDistributedJob(job);
    }

    const { code, data } = job;

    if (typeof code !== "string") {
      throw new Error("Job code must be a string");
    }

    this.jobMetrics.totalJobs++;
    const startTime = Date.now();

    try {
      const result = await Sandbox.run(code, { data });

      this.jobMetrics.succeeded++;
      this.jobMetrics.averageTime =
        (this.jobMetrics.averageTime * (this.jobMetrics.succeeded - 1) +
          (Date.now() - startTime)) /
        this.jobMetrics.succeeded;

      return result;
    } catch (error) {
      this.jobMetrics.failed++;
      throw error;
    }
  }

  private async processDistributedJob(job: Job): Promise<any> {
    try {
      return await Sandbox.run(job.code, {
        data: job.data,
        split: this.sbx.distributed.split.bind(this.sbx.distributed),
        merge: this.sbx.distributed.merge.bind(this.sbx.distributed),
      });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        data: job.data,
      };
    }
  }

  getMetrics() {
    return { ...this.jobMetrics };
  }

  private processQueue() {
    while (this.jobQueue.length > 0 && this.pendingPeers.size > 0) {
      const job = this.jobQueue.shift()!;
      const peer = this.getBestPeerForJob(job);
      if (peer) {
        this.distributeJob(job);
      } else {
        this.runLocally(job);
      }
    }
  }

  private getBestPeerForJob(job: Job): PeerId | null {
    if (this.pendingPeers.size === 0) return null;

    const peers = Array.from(this.pendingPeers);
    const jobType = this.classifyJob(job);

    return peers.reduce((bestPeer, peer) => {
      const capabilities = this.peerCapabilities.get(peer) || {
        cpu: 0,
        memory: 0,
      };
      const bestCapabilities = bestPeer
        ? this.peerCapabilities.get(bestPeer)
        : null;

      if (
        jobType === "cpu-intensive" &&
        capabilities.cpu > (bestCapabilities?.cpu || 0)
      ) {
        return peer;
      }

      if (
        jobType === "memory-intensive" &&
        capabilities.memory > (bestCapabilities?.memory || 0)
      ) {
        return peer;
      }

      return bestPeer || peer;
    }, null as PeerId | null);
  }

  private classifyJob(
    job: Job
  ): "cpu-intensive" | "memory-intensive" | "general" {
    if (job.code.includes("tensorflow") || job.code.includes("inference")) {
      return "cpu-intensive";
    }
    if (job.code.includes("largeArray") || job.code.includes("bigData")) {
      return "memory-intensive";
    }
    return "general";
  }

  private distributeJob(job: Job) {
    const timeout = setTimeout(() => {
      const jobEntry = this.activeJobs.get(job.id);
      if (jobEntry) {
        jobEntry.resolve({ error: "Job timeout" });
        this.activeJobs.delete(job.id);
      }
    }, 30_000);

    this.activeJobs.set(job.id, {
      resolve: () => {},
      timeout
    });

    this.mesh.publish("serverbox-jobs", {
      type: "job-request",
      data: job,
    });
  }

  private handleJobRequest(job: Job) {
    this.runLocally(job)
      .then((result) => {
        this.mesh.publish("serverbox-jobs", {
          type: "job-result",
          data: {
            from: this.mesh.getPeerId(),
            id: job.id,
            result,
          },
        });
      })
      .catch((error) => {
        this.mesh.publish("serverbox-jobs", {
          type: "job-result",
          data: {
            from: this.mesh.getPeerId(),
            id: job.id,
            error,
          },
        });
      });
  }

  private async runLocally(job: Job) {
    try {
      console.log(`[Worker] Running job ${job.id} locally`);
      const result = await Sandbox.run(job.code, { data: job.data });
      console.log(`[Worker] Job ${job.id} completed`);
      return result;
    } catch (error) {
      console.error(`[Worker] Job ${job.id} failed:`, error);
      throw error;
    }
  }

  private handleJobResult(from: PeerId, result: JobResult) {
    const jobEntry = this.activeJobs.get(result.id);
    if (jobEntry) {
      clearTimeout(jobEntry.timeout);
      jobEntry.resolve(result.error ? { error: result.error } : result.result);
      this.activeJobs.delete(result.id);
    }

    if (from !== "local") {
      this.pendingPeers.add(from);
      this.processQueue();
    }
  }
}
