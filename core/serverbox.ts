// File: /core/serverbox.ts
import { Router, type MatchResult } from "./router";
import type { Handler, Job, Request, Response, JobResult } from "../types";
import { MeshNetwork, Libp2pMesh } from "../runtime/mesh";
import { WorkerManager } from "../runtime/worker";
import { Exporter } from "../exporter";
import * as path from "path";
import { DistributedJobManager } from "./distributed";
import { SignalingServer } from "../runtime/signaling";

export class ServerBox {
  private router = new Router();
  public mesh?: MeshNetwork;
  public workers?: WorkerManager;
  public distributed: DistributedJobManager;
  private signalingServer?: SignalingServer;
  private initialized = false;
  private server?: any;

  constructor(
    private options: {
      disableMesh?: boolean;
      resourceLimits?: { timeout?: number; memory?: number };
    } = {}
  ) {
    this.distributed = new DistributedJobManager({
      runJob: this.runJob.bind(this),
    });
    this.initializeRuntime();
  }

  /**
   * Define CRUD routes in one call. Controller should provide create, read, update, delete handlers.
   */
  crud(
    basePath: string,
    controller: {
      create: Handler;
      read: Handler;
      update: Handler;
      delete: Handler;
    }
  ) {
    this.post(`${basePath}`, controller.create);
    this.get(`${basePath}/:id`, controller.read);
    this.put(`${basePath}/:id`, controller.update);
    this.delete(`${basePath}/:id`, controller.delete);
  }

  use(pathPattern: string, handler: Handler) {
    this.router.add("USE", pathPattern, handler);
  }

  get(path: string, handler: Handler) {
    this.router.add("GET", path, handler);
  }

  post(path: string, handler: Handler) {
    this.router.add("POST", path, handler);
  }

  put(path: string, handler: Handler) {
    this.router.add("PUT", path, handler);
  }

  delete(path: string, handler: Handler) {
    this.router.add("DELETE", path, handler);
  }

  useSignalingServer(server: SignalingServer) {
    this.signalingServer = server;
  }

  async initializeRuntime() {
    if (this.initialized || this.options.disableMesh) return;
    this.initialized = true;

    this.mesh = new Libp2pMesh(this.signalingServer);
    await this.mesh.start();

    if (this.signalingServer) {
      this.signalingServer.start();
    }

    this.workers = new WorkerManager(this.mesh, this);
  }

  async handleRequest(req: Request, res: Response) {
    try {
      const match: MatchResult | null = this.router.match(req.method, req.path);
      if (match) {
        req.params = match.params || {};
        await match.handler(req, res);
      } else {
        res.status(404).send("Not found");
      }
    } catch (error) {
      console.error(`Request error [${req.method} ${req.path}]:`, error);
      res.status(500).send("Internal Server Error");
    }
  }

  async exportStatic(options: { outDir: string }) {
    return Exporter.export(this, options);
  }

  async runJob(job: Job): Promise<any> {
    await this.initializeRuntime();

    if (!this.workers) {
      throw new Error("Worker manager not initialized");
    }

    return this.workers.executeJob(job);
  }

  async split(data: any, strategy: string, options?: any): Promise<any[]> {
    return this.distributed.process(data, strategy, "", options);
  }

  dispatchToMesh(jobs: Job[]): Promise<JobResult[]> {
    return this.distributed.dispatchToMesh(jobs);
  }

  merge(results: any[], strategy: string, options?: any): any {
    const s = this.distributed.strategies.get(strategy);
    if (!s) throw new Error(`Unknown merge strategy: ${strategy}`);
    return s.merge(results, options);
  }

  private async shutdown() {
    console.log("Shutting down ServerBox...");
    if (this.mesh) await this.mesh.stop();
    if (this.server) this.server.close();
    process.exit(0);
  }

  async serve(port: number = 3000) {
    const express = require("express");
    const app = express();

    app.use(express.json());
    app.use("/lib", express.static(path.join(__dirname, "../node_modules")));

    app.use(async (req: any, res: any) => {
      const request: Request = {
        method: req.method,
        path: req.path,
        query: req.query,
        params: req.params,
        headers: req.headers,
        body: req.body,
      };

      const response: Response = {
        status(code: number) {
          res.status(code);
          return this;
        },
        send(body: any) {
          res.send(body);
          return this;
        },
        json(body: any) {
          res.json(body);
          return this;
        },
        setHeader(name: string, value: string) {
          res.setHeader(name, value);
          return this;
        },
      };

      try {
        await this.handleRequest(request, response);
      } catch (e) {
        console.error("Request handling error:", e);
        res.status(500).send("Internal Server Error");
      }
    });

    this.server = app.listen(port, () => {
      console.log(`ServerBox running at http://localhost:${port}`);
    });

    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
  }
}

export function createServerbox(options?: {
  disableMesh?: boolean;
  resourceLimits?: { timeout?: number; memory?: number };
}) {
  return new ServerBox(options);
}
