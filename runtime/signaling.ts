// File: /runtime/signaling.ts
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import type { ServerBox } from "../core/serverbox";
import WebSocket from "ws";

export class SignalingServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private peers: Map<string, WebSocket> = new Map();

  constructor(private port: number = 9090) {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.setupWebSocket();
  }

  private setupWebSocket() {
    this.wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === "register") {
            this.peers.set(message.peerId, ws);
            console.log(`[Signaling] Peer registered: ${message.peerId}`);
            return;
          }

          if (message.target) {
            const targetWs = this.peers.get(message.target);
            if (targetWs) {
              targetWs.send(JSON.stringify(message));
            } else {
              console.log(
                `[Signaling] Target peer not found: ${message.target}`
              );
            }
          }
        } catch (e) {
          console.error("[Signaling] Error handling message:", e);
        }
      });

      ws.on("close", () => {
        for (const [peerId, connection] of this.peers.entries()) {
          if (connection === ws) {
            this.peers.delete(peerId);
            console.log(`[Signaling] Peer disconnected: ${peerId}`);
            break;
          }
        }
      });
    });
  }

  start() {
    this.server.listen(this.port, () => {
      console.log(`Signaling server running at ws://localhost:${this.port}`);
    });
  }

  stop() {
    this.wss.close();
    this.server.close();
  }

  static createForServerBox(sbx: ServerBox, port?: number): SignalingServer {
    const server = new SignalingServer(port);
    sbx.useSignalingServer(server);
    return server;
  }
}

export class SignalingClient {
  private ws!: WebSocket;
  constructor(private signalingUrl: string = SignalingClient.defaultUrl()) {}

  private static defaultUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname;
    const port = 9090;
    return `${proto}://${host}:${port}`;
  }

  connect(): void {
    this.ws = new WebSocket(this.signalingUrl);
    this.ws.onopen = () => {
      console.log(`[SignalingClient] Connected to ${this.signalingUrl}`);
    };
    this.ws.onmessage = (evt) => {
      const data =
        typeof evt.data === "string"
          ? evt.data
          : // @ts-ignore
            new TextDecoder().decode(evt.data);
      const msg = JSON.parse(data);
      console.log("[SignalingClient] Message:", msg);
    };
    this.ws.onclose = () => {
      console.log("[SignalingClient] Disconnected");
    };
    this.ws.onerror = (err) => {
      console.error("[SignalingClient] Error:", err);
    };
  }

  send(message: any): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn("[SignalingClient] WS ยังไม่พร้อมส่งข้อความ");
    }
  }
}
