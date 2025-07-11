// File: /exporter/index.ts
import { ServerBox } from "../core/serverbox";
import * as fs from "fs";
import * as path from "path";

async function splitRuntime(
  data: any,
  strategy: string,
  options?: any
): Promise<any[]> {
  if (strategy === "array") {
    const chunkSize = options?.chunkSize || 100;
    const chunks = [];
    for (let i = 0; i < data.length; i += chunkSize) {
      chunks.push({ chunk: data.slice(i, i + chunkSize) });
    }
    return chunks;
  }
  if (strategy === "matrix") {
    // ทำ logic chunking สำหรับ matrix
    return [{ chunk: data }];
  }
  throw new Error("Unknown split strategy: " + strategy);
}

function mergeRuntime(results: any[], strategy: string, options?: any): any {
  if (strategy === "array") {
    return results.flat();
  }
  if (strategy === "matrix") {
    return results.reduce((acc, r) => acc.concat(r), []);
  }
  throw new Error("Unknown merge strategy: " + strategy);
}

const splitFuncStr = splitRuntime.toString();
const mergeFuncStr = mergeRuntime.toString();

export class Exporter {
  private static patternToRegex(pattern: string): string {
    if (!pattern.startsWith("/")) pattern = "/" + pattern;
    if (pattern === "/") return "^\\/$";

    const segments = pattern.split("/");
    let regex = "^";

    segments.forEach((seg, idx) => {
      if (idx > 0) regex += "\\/"; // เพิ่ม slash ระหว่าง segment ยกเว้นตัวแรก

      if (seg === "*") {
        regex += "(.*)";
      } else if (seg.startsWith(":")) {
        regex += "([^/]+)";
      } else if (seg.length === 0 && idx === 0) {
        // nothing, leading slash already added
      } else {
        regex += this.escapeRegExp(seg);
      }
    });

    return regex + "$";
  }

  private static escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  static async export(sbx: ServerBox, options: { outDir: string }) {
    const outDir = path.resolve(options.outDir);
    this.ensureDir(outDir);

    // Generate core files
    this.writeFile(outDir, "index.html", this.generateIndexHtml());
    this.writeFile(outDir, "serverbox.runtime.js", this.generateRuntimeJs(sbx));
    this.writeFile(outDir, "sbx.worker.js", this.generateWorkerJs());
    this.writeFile(outDir, "manifest.sbx.json", this.generateManifest(sbx));
    this.writeFile(
      outDir,
      "sw.js",
      `importScripts('serverbox.runtime.js');

      self.addEventListener('fetch', (event) => {
        const url = new URL(event.request.url);
        const handler = self.ROUTER_CONFIG.find(r => 
          r.method === event.request.method && 
          new RegExp(r.regex).test(url.pathname)
        );

        // ใช้ handler ถ้ามี ไม่มีก็ fetch ตามปกติ
        event.respondWith(
          handler 
            ? handleServerBoxRequest(event.request, handler)
            : fetch(event.request)
        );
      });`
    );
    // Copy additional assets
    // this.copyAssets(outDir);
    return Promise.resolve(outDir);
  }

  private static generateIndexHtml() {
    return `<!DOCTYPE html>
    <html>
    <head><title>ServerBox App</title></head>
    <body>
      <script type="module" src="serverbox.runtime.js"></script>
      <script>
        if ("serviceWorker" in navigator) {
          // ระบุ scope: '/' อย่างชัดเจน
          navigator.serviceWorker.register("/sw.js", { scope: "/" })
          .then(reg => console.log("SW registered:", reg.scope))
          .catch(err => console.error("SW failed:", err));
        }
      </script>
    </body>
    </html>`;
  }

  private static generateRuntimeJs(sbx: ServerBox) {
    const workerCode = this.generateWorkerJs();
    const signalingPort = (sbx as any).signalingServer?.port || 9090;

    return `
    // ServerBox Client Runtime (ES Module)

    import { createLibp2p } from "libp2p";
    import { webSockets } from "@libp2p/websockets";
    import { webRTCStar } from "@libp2p/webrtc-star";
    import { bootstrap } from "@libp2p/bootstrap";
    import { gossipsub } from "@chainsafe/libp2p-gossipsub";
    import { identify } from "@libp2p/identify";
    import { noise } from "@chainsafe/libp2p-noise";
    import { yamux } from "@chainsafe/libp2p-yamux";
    import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'

    // Service Worker context
    if (typeof window === 'undefined' && typeof self !== 'undefined') {
      self.ROUTER_CONFIG = ${this.serializeRouter(sbx)};
      
      let runInSandbox = async function(code, context) {
  try {
    const keys = Object.keys(context);
    const values = keys.map(k => context[k]);

    const fn = new Function(...keys, \`
      "use strict";
      return (async () => {
        \${code}
      })();
    \`);

    return await fn(...values);
  } catch (error) {
    throw error;
  }
};

      
      async function handleServerBoxRequest(request, handler) {
        try {
          const sbx = {
            mesh: {
              getPeerId: () => "local",
              split: ${splitFuncStr},
              merge: ${mergeFuncStr}
            }
          };
          const url = new URL(request.url);
          let body = {};
          if (request.method !== "GET") {
            try {
              body = await request.clone().json();
            } catch (e) {
              console.warn("⚠️ Failed to parse JSON body", e);
              body = {};
            }
          }
          const req = {
            method: request.method,
            path: url.pathname,
            headers: Object.fromEntries(request.headers.entries()),
            body
          };
          
          const result = await runInSandbox(
            \`return (\${handler.fn})(req, sbx);\`,
            { 
              req,
              sbx
            }
          );
          
          return new Response(
            typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
            {
              status: result.status || 200,
              headers: { 
                'Content-Type': 'text/plain',
                'Access-Control-Allow-Origin': '*'
              }
            }
          );
        } catch (error) {
          console.error('Handler error:', error);
          return new Response('Internal Server Error', { status: 500 });
        }
      }
      
      self.addEventListener('fetch', (event) => {
        const url = new URL(event.request.url);
        const handler = self.ROUTER_CONFIG.find(r => 
          r.method === event.request.method && 
          new RegExp(r.regex).test(url.pathname)
        );
        
        if (handler) {
          event.respondWith(handleServerBoxRequest(event.request, handler));
        }
      });
    } else {
      // Browser context
      self.ROUTER_CONFIG = ${this.serializeRouter(sbx)};
      self.SIGNALING_PORT = ${signalingPort};
      let handleServerBoxRequest;

      if (typeof window !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
        const workerBlob = new Blob([\`${workerCode.replaceAll("`", "\\`")}
        let runInSandbox = async function(code, context) {
          try {
            const keys = Object.keys(context);
            const values = keys.map(k => context[k]);

            const fn = new Function(...keys, \\\`
              "use strict";
              return (async () => {
                \\\${code}
              })();
            \\\`);

            return await fn(...values);
          } catch (error) {
            throw error;
          }
        };\`], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(workerBlob);

        class WorkerManager {
          constructor(mesh) {
            this.mesh = mesh;
            this.worker = new Worker(workerUrl);
            this.callbacks = new Map();
            this.worker.addEventListener('message', (e) => {
              const { id, result, error } = e.data;
              const cb = this.callbacks.get(id);
              if (cb) {
                error ? cb.reject(error) : cb.resolve(result);
                this.callbacks.delete(id);
              }
            });
          }
          execute(code, data) {
            return new Promise((resolve, reject) => {
              const id = Date.now() + Math.random();
              this.callbacks.set(id, { resolve, reject });
              this.worker.postMessage({ id, code, data });
            });
          }
        }

        class MeshNetwork {}
        class Libp2pMesh extends MeshNetwork {
          constructor(signalingPort) {
            super();
            this.subscriptions = new Map();
            this.signalingPort = signalingPort;
            this.peerCapabilities = new Map();
          }
          async start() {
            const transports = [webSockets(), circuitRelayTransport()];

            if (this.signalingPort) {
              const { webRTC } = await import('@libp2p/webrtc');
              transports.push(new webRTC());
            } else {
              const star = webRTCStar();
              transports.push(star.transport);
            }

            this.node = await createLibp2p({
              transports,
              connectionEncrypters: [noise()],
              streamMuxers: [yamux()],
              peerDiscovery: [
                bootstrap({ list: [
                  "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
                  "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa"
                ]}),
                ...(this.signalingPort ? [] : [star.discovery]),
              ],
              services: {
                identify: identify(),
                pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
              },
            });

            await this.node.start();

            this.node.services.pubsub.addEventListener("message", (evt) => {
              const topic = evt.detail.topic;
              const handler = this.subscriptions.get(topic);
              if (handler) {
                try {
                  const msg = JSON.parse(new TextDecoder().decode(evt.detail.data));
                  handler(msg);
                } catch (e) {
                  console.error("Parse pubsub msg failed", e);
                }
              }
            });

            this.node.addEventListener("peer:connect", (e) => {
              console.log("Connected to peer:", e.detail.toString());
              this.publish("serverbox-jobs", {
                type: "capabilities",
                data: {
                  peerId: this.getPeerId(),
                  cpu: navigator.hardwareConcurrency || 4,
                  memory: performance.memory?.jsHeapSizeLimit || 1073741824
                }
              });
            });

            this.node.addEventListener("peer:discovery", (e) => {
              console.log("Discovered peer:", e.detail.id.toString());
            });
          }

          async stop() {
            if (this.node) await this.node.stop();
          }
          publish(topic, msg) {
            if (!this.node) return;
            try {
              const data = new TextEncoder().encode(JSON.stringify(msg));
              this.node.services.pubsub.publish(topic, data);
            } catch (e) {
              console.error("Publish failed", e);
            }
          }
          subscribe(topic, cb) {
            if (!this.node) return;
            this.subscriptions.set(topic, cb);
            this.node.services.pubsub.subscribe(topic);
          }
          getPeers() {
            return this.node ? this.node.getPeers().map(p => p.toString()) : [];
          }
          getPeerId() {
            return this.node ? this.node.peerId.toString() : "";
          }
        }

        (async () => {
          const mesh = new Libp2pMesh(self.SIGNALING_PORT);
          const workers = new WorkerManager(mesh);

          try {
            await mesh.start();
            console.log('ServerBox runtime initialized');
          } catch (err) {
            console.error('ServerBox init failed:', err);
          }

          handleServerBoxRequest = async function(request, handler) {
          
            const req = {
              method: request.method,
              path: request.url,
              headers: Object.fromEntries(request.headers.entries()),
              body: await request.json(),
            };
            const res = {
              statusCode: 200, headers: {},
              status(c) { this.statusCode = c; return this; },
              setHeader(n, v) { this.headers[n] = v; return this; },
              send(body) { return new Response(body, { status: this.statusCode, headers: this.headers }); }
            };
            const result = await workers.execute(handler.fn, req);
            return res.send(result);
          };

          window.addEventListener('fetch', async (event) => {
            const url = new URL(event.request.url);
            const handler = self.ROUTER_CONFIG.find(r =>
              r.method === event.request.method &&
              new RegExp(r.regex).test(url.pathname)
            );
            if (handler) {
              event.respondWith(handleServerBoxRequest(event.request, handler));
            }
          });
        })();
      }
    }
    `;
  }

  private static serializeRouter(sbx: ServerBox) {
    const routes = (sbx as any).router.routes
      .map((route: any) => {
        if (!route.pattern || !route.handler) {
          console.warn("Route missing pattern or handler:", route);
          return null;
        }

        return {
          method: route.method,
          path: route.pattern,
          regex: this.patternToRegex(route.pattern),
          fn: `(req, sbx) => {
            const res = {
              statusCode: 200,
              status: function(code) {
                this.statusCode = code;
                return this;
              },
              send: function(body) {
                return { status: this.statusCode, body };
              },
              json: function(body) {
                return this.send(JSON.stringify(body));
              },
              setHeader: function() { return this; }
            };
            
            ${route.handler
              .toString()
              .replace("function (req, res)", "function handlerFn(req, res)")
              .replace("function(req, res)", "function handlerFn(req, res)")}
            
            return handlerFn(req, res);
          }`,
        };
      })
      .filter(Boolean);
    return JSON.stringify(routes, null, 2);
  }

  private static generateWorkerJs() {
    return `
  self.addEventListener('message', async (event) => {
    const job = event.data;
    try {
      const context = { 
        data: job.data,
        ...(job.split ? { split: job.split } : {}),
        ...(job.merge ? { merge: job.merge } : {})
      };
      const result = await runInSandbox(job.code, context);
      self.postMessage({ id: job.id, result });
    } catch (error) {
      self.postMessage({ id: job.id, error: error.message });
    }
  });
  `;
  }

  private static generateManifest(sbx: ServerBox) {
    const opts = (sbx as any).options;
    const routes = (sbx as any).router.routes.map((r: any) => ({
      method: r.method,
      path: r.path,
    }));

    return JSON.stringify(
      {
        version: "1.0",
        createdAt: new Date().toISOString(),
        options: opts,
        routes,
      },
      null,
      2
    );
  }

  private static ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private static writeFile(dir: string, filename: string, content: string) {
    fs.writeFileSync(path.join(dir, filename), content);
  }
}
