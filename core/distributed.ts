// File: /core/distributed.ts
import type { Job, JobResult } from "../types";

export interface SplitStrategy<T = any> {
  split(data: T, options?: any): T[] | Promise<T[]>;
  merge(results: any[], options?: any): any | Promise<any>;
}
export interface DistributedStrategy {
  split(data: any, options?: any): Promise<any[]>;
  merge(results: any[], options?: any): any;
}

export class DistributedJobManager {
  public strategies: Map<string, SplitStrategy> = new Map();
  private runJob: (job: Job) => Promise<any>;

  constructor(options: { runJob: (job: Job) => Promise<any> }) {
    this.runJob = options.runJob;
    this.registerDefaultStrategies();
  }

  public registerStrategy(name: string, strategy: SplitStrategy<any>) {
    this.strategies.set(name, strategy);
  }

  async split(data: any, strategyName: string, options?: any): Promise<any[]> {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      console.error(`[Distributed] Unknown strategy: ${strategyName}`);
      console.error(
        `[Distributed] Available:`,
        Array.from(this.strategies.keys())
      );
      throw new Error(`Unknown strategy: ${strategyName}`);
    }

    const chunks = await strategy.split(data, options);
    if (!Array.isArray(chunks)) {
      throw new Error(`Strategy '${strategyName}' did not return an array`);
    }
    return chunks;
  }

  async merge(
    results: any[],
    strategyName: string,
    options?: any
  ): Promise<any> {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) throw new Error(`Unknown strategy: ${strategyName}`);
    return strategy.merge(results, options);
  }

  async process<T>(
    data: T,
    strategyName: string,
    jobCode: string,
    options?: any
  ): Promise<any> {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) throw new Error(`Unknown strategy: ${strategyName}`);

    // แบ่งข้อมูลเป็นส่วนย่อย
    const chunks = await this.split(data, strategyName, options);

    const jobCodeFinal = jobCode || options?.process;
    if (!jobCodeFinal) throw new Error("No code provided for distributed job!");

    const jobs: Job[] = chunks.map((chunk, index) => ({
      id: `chunk-${Date.now()}-${index}`,
      code: jobCodeFinal,
      data: { ...options, chunk, index, total: chunks.length },
    }));

    // กระจายงานไปยัง mesh network
    const results = await this.dispatchToMesh(jobs);

    // เรียงลำดับผลลัพธ์ตาม index
    const sortedResults = results
      .filter((r) => !r.error)
      .sort((a, b) => a.data.index - b.data.index)
      .map((r) => r.result);

    // รวมผลลัพธ์
    return this.merge(sortedResults, strategyName, options);
  }

  async dispatchToMesh(jobs: Job[]): Promise<JobResult[]> {
    console.log(`[Distributed] Dispatching ${jobs.length} jobs`);

    try {
      const jobPromises = jobs.map((job) =>
        this.runJob(job)
          .then((result) => {
            console.log(`[Distributed] Job ${job.id} succeeded`);
            return { id: job.id, result, data: job.data };
          })
          .catch((error) => {
            console.error(`[Distributed] Job ${job.id} failed:`, error);
            return { id: job.id, error: error.message, data: job.data };
          })
      );
      return await Promise.all(jobPromises);
    } catch (error) {
      console.error("[Distributed] Dispatch failed:", error);
      return jobs.map((job) => ({
        id: job.id,
        error: "Dispatch failed",
        data: job.data,
      }));
    }
  }

  private registerDefaultStrategies() {
    // กลยุทธ์การแบ่งข้อมูลแบบ array
    this.registerStrategy("array", {
      split: async (data: any[], options: { chunkSize?: number } = {}) => {
        const chunkSize = options.chunkSize || 10;
        const chunks = [];
        for (let i = 0; i < data.length; i += chunkSize) {
          chunks.push(data.slice(i, i + chunkSize));
        }
        return chunks;
      },
      merge: async (results: any[][]) =>
        results.reduce((acc, val) => acc.concat(val), []),
    });

    // กลยุทธ์การแบ่งข้อมูลแบบข้อความ
    this.registerStrategy("text", {
      split: (text: string, options: { chunkSize?: number } = {}) => {
        const chunkSize = options.chunkSize || 500;
        const chunks = [];
        for (let i = 0; i < text.length; i += chunkSize) {
          chunks.push(text.substring(i, i + chunkSize));
        }
        return chunks;
      },
      merge: (results: string[]) => results.join(""),
    });

    // Add to registerDefaultStrategies() method
    this.registerStrategy("matrix", {
      split: (data: { matrixA: number[][]; matrixB: number[][] }, options) => {
        const chunks = [];
        const rows = data.matrixA.length;
        for (let i = 0; i < rows; i++) {
          chunks.push({
            matrixA: [data.matrixA[i]],
            matrixB: data.matrixB,
          });
        }
        return chunks;
      },

      merge: (results: number[][][]) => {
        return results.reduce((acc, chunk) => [...acc, ...chunk], []);
      },
    });
  }
}
