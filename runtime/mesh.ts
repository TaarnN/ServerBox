// File: /runtime/mesh.ts
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { webRTCStar } from "@libp2p/webrtc-star";
import { bootstrap } from "@libp2p/bootstrap";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { MeshMessage, PeerId } from "../types";
import type { SignalingServer } from "./signaling";

export abstract class MeshNetwork {
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract publish(topic: string, message: MeshMessage): void;
  abstract subscribe(
    topic: string,
    callback: (message: MeshMessage) => void
  ): void;
  abstract getPeers(): PeerId[];
  abstract getPeerId(): PeerId;
}

export class Libp2pMesh extends MeshNetwork {
  private node: any;
  private subscriptions: Map<string, (message: MeshMessage) => void> =
    new Map();
  private signalingServer?: SignalingServer;

  constructor(signalingServer?: SignalingServer) {
    super();
    this.signalingServer = signalingServer;
  }

  async start() {
    const transports: any[] = [webSockets()];

    if (this.signalingServer) {
      const star = webRTCStar() as any;
      transports.push(star.transport);
    } else {
      const star = webRTCStar() as any;
      transports.push(star.transport);
    }

    this.node = await createLibp2p({
      transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [
        bootstrap({
          list: [
            "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
            "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
          ],
        }),
      ],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
        }),
      },
      ...(this.signalingServer
        ? {
            config: {
                connectionManager: {
                    autoDial: true,
                },
              peerDiscovery: {
                webRTCStar: {
                  enabled: false,
                },
              },
              relay: {
                enabled: true,
                hop: {
                  enabled: true,
                },
              },
            },
          }
        : {}),
    });

    await this.node.start();

    this.node.services.pubsub.addEventListener("message", (event: any) => {
      const topic = event.detail.topic;
      const handler = this.subscriptions.get(topic);
      if (handler) {
        try {
          const message = JSON.parse(
            new TextDecoder().decode(event.detail.data)
          ) as MeshMessage;
          handler(message);
        } catch (e) {
          console.error("Failed to parse pubsub message", e);
        }
      }
    });

    this.node.addEventListener("peer:connect", (evt: any) => {
      console.log(`Connected to peer: ${evt.detail.toString()}`);
    });

    this.node.addEventListener("peer:discovery", (evt: any) => {
      console.log(`Discovered peer: ${evt.detail.id.toString()}`);
    });
  }

  async stop() {
    if (this.node) {
      await this.node.stop();
    }
  }

  publish(topic: string, message: MeshMessage) {
    if (!this.node) return;
    try {
      const data = new TextEncoder().encode(JSON.stringify(message));
      this.node.services.pubsub.publish(topic, data);
    } catch (e) {
      console.error("Failed to publish message", e);
    }
  }

  subscribe(topic: string, callback: (message: MeshMessage) => void) {
    if (!this.node) return;

    this.subscriptions.set(topic, callback);
    this.node.services.pubsub.subscribe(topic);
  }

  getPeers(): PeerId[] {
    if (!this.node) return [];
    return this.node.getPeers().map((p: any) => p.toString());
  }

  getPeerId(): PeerId {
    if (!this.node) return "";
    return this.node.peerId.toString();
  }
}
