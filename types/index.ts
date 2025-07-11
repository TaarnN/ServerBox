// File: /types/index.ts
export type Request = {
  method: string;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  body?: any;
};

export type Response = {
  status(code: number): Response;
  send(body: any): void;
  json(body: any): void;
  setHeader(name: string, value: string): void;
};

export type NextFunction = (err?: any) => void;
export type Handler = (
  req: Request,
  res: Response,
  next?: NextFunction
) => void;

export type JobData = {
  chunk?: any;
  index?: number;
  total?: number;
  isDistributed?: boolean;
  [key: string]: any;
};

export type Job = {
  id: string;
  code: string;
  data: JobData;
};

export type JobResult = { id: string; result?: any; error?: any; data?: any };
export type PeerId = string;
export type MeshMessage = {
  type: "job-request" | "job-result" | "job-ready" | "capabilities";
  data: any;
};

export abstract class MeshNetwork {
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract publish(topic: string, message: MeshMessage): void;
  abstract subscribe(topic: string, callback: (message: MeshMessage) => void): void;
  abstract getPeers(): PeerId[];
  abstract getPeerId(): PeerId;
}
