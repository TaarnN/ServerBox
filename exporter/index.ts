// File: /exporter/index.ts
import { ServerBox } from "../core/serverbox";
import * as fs from "fs";
import * as path from "path";

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
      `import { ROUTER_CONFIG, handleServerBoxRequest } from './serverbox.runtime.js';

  self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    const handler = ROUTER_CONFIG.find(r => 
      r.method === event.request.method && 
      new RegExp(r.regex).test(url.pathname)
    );

    event.respondWith(
      handler 
        ? handleServerBoxRequest(event.request, handler)
        : fetch(event.request)
    );
  });`
    );
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
          navigator.serviceWorker.register('/sw.js', {
            type: 'module',
            scope: '/',
            updateViaCache: 'none'
          })
          .then(reg => {
            console.log("SW registered:", reg.scope);
            reg.update();
          })
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
    "use strict";

    // ป้องกันการโหลด reflect-metadata ใน SES environment
    if (typeof window === 'undefined') {
      delete globalThis.Reflect;
    }

    import 'ses';
    import { createLibp2p } from "libp2p";
    import { webSockets } from "@libp2p/websockets";
    import { bootstrap } from "@libp2p/bootstrap";
    import { gossipsub } from "@chainsafe/libp2p-gossipsub";
    import { identify } from "@libp2p/identify";
    import { noise } from "@chainsafe/libp2p-noise";
    import { yamux } from "@chainsafe/libp2p-yamux";
    import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
    import { webRTC } from "@libp2p/webrtc";
    import { webRTCStar } from "@libp2p/webrtc-star";
  
    // ปรับค่า SES lockdown
    if (typeof window === 'undefined') {
      lockdown({
        errorTaming: 'unsafe',
        overrideTaming: 'severe',
        consoleTaming: 'unsafe',
        unhandledRejectionTrapping: 'report'
      });
    }

    export const ROUTER_CONFIG = ${this.serializeRouter(sbx)};
    export let handleServerBoxRequest;

    if (typeof window === 'undefined') {
      // Service Worker context
      if (typeof self !== 'undefined') {
        handleServerBoxRequest = async function(request, handler) {
          const c = new Compartment({
            console: { log: console.log, warn: console.warn, error: console.error },
            request,
            handler
          });
          return await c.evaluate(\`
            "use strict";
            (async () => {
              try {
                const response = await handler.handler(request);
                return new Response(response.body, {
                  status: response.status,
                  headers: response.headers
                });
              } catch (err) {
                console.error('Handler error:', err);
                return new Response(null, { status: 500 });
              }
            })()
          \`);
        };
      }
    }

    async function splitRuntime(data, strategy, options) {
      switch (strategy) {
        case "file": {
          const buffer = data instanceof ArrayBuffer
            ? data
            : await data.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          const chunkSize = options?.chunkSize || 1024 * 1024;
          const chunks = [];
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const slice = bytes.slice(i, i + chunkSize);
            if (options?.process) {
              chunks.push(await runProcess(options.process, slice));
            } else {
              chunks.push({ chunk: slice });
            }
          }
          return chunks;
        }
        case "custom": {
          if (!options?.splitFn) throw new Error("Missing splitFn for custom strategy");
          const c = new Compartment({ data });
          return await c.evaluate(\`
            "use strict";
            (async () => {
              \${options.splitFn}
            })()
          \`);
        }
        case "graph": {
          if (!Array.isArray(data.nodes)) throw new Error("Invalid graph format");
          const chunks = data.nodes.map(node => ({ chunk: node }));
          if (options?.process) {
            return Promise.all(chunks.map(c => runProcess(options.process, c.chunk)));
          }
          return chunks;
        }
        default:
          throw new Error("Unknown split strategy: " + strategy);
      }
    }

    function concatUint8Arrays(arrays) {
      const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
      }
      return result;
    }

    async function mergeRuntime(results, strategy, options) {
      switch (strategy) {
        case "array":
          return results.flat();
        case "matrix":
          return results.reduce((acc, r) => acc.concat(r), []);
        case "object":
          return results.reduce((acc, r) => {
            const obj = r && r.chunk ? r.chunk : r;
            return Object.assign(acc, obj);
          }, {});
        case "map": {
          const merged = new Map();
          for (const r of results) {
            const m = r instanceof Map
              ? r
              : r.chunk instanceof Map
                ? r.chunk
                : null;
            if (!m) throw new Error("Cannot merge non-Map chunk");
            for (const [k, v] of m.entries()) {
              merged.set(k, v);
            }
          }
          return merged;
        }
        case "range":
          return results.flat();
        case "file":
          return concatUint8Arrays(
            results.map(r => (r.chunk instanceof Uint8Array ? r.chunk : r))
          );
        case "custom":
          if (options?.mergeFn) {
            const c = new Compartment({ results });
            return await c.evaluate(\`
              "use strict";
              (async () => {
                \${options.mergeFn}
              })()
            \`);
          }
          return results;
        case "graph":
          return results.map(r => (r && r.chunk !== undefined ? r.chunk : r));
        default:
          throw new Error("Unknown merge strategy: " + strategy);
      }
    }

    // Service Worker context
    if (typeof window === 'undefined' && typeof self !== 'undefined') {
      self.ROUTER_CONFIG = ${this.serializeRouter(sbx)};
      
      const lockdownCode = \`
        lockdown({
          errorTaming: 'unsafe',
          overrideTaming: 'severe',
          consoleTaming: 'unsafe',
          unhandledRejectionTrapping: 'report'
        });
      \`;

      let runInSandbox = async function(code6, context) {
        const c = new Compartment({
          ...context,
          console: harden({ log: console.log, warn: console.warn, error: console.error })
        });
        return c.evaluate(\`
          "use strict";
          (async () => {
            try {
              \${code6}
            } catch (e) {
              console.error('Sandbox error:', e);
              throw e;
            }
          })();
        \`);
      };
      
      handleServerBoxRequest = async function (request, handler) {
        try {
          const sbx = {
            mesh: {
              getPeerId: () => "local"
            },
            split: async (data, strategy, options) => 
              await splitRuntime(data, strategy, options),
            merge: (results, strategy, options) => 
              mergeRuntime(results, strategy, options)
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
            body,
            params: {} // Initialize empty params object
          };

          // Extract path parameters
          const match = url.pathname.match(new RegExp(handler.regex));
          if (match && handler.paramNames) {
            handler.paramNames.forEach((name, index) => {
              req.params[name] = match[index + 1];
            });
          }
          
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

            const c = new Compartment({ [keys]: values });
            return await c.evaluate(\\\`
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
            const transports = [
              webSockets(),
              circuitRelayTransport(),
            ];

            let star;
            if (this.signalingPort) {
              transports.push(webRTC());
            } else {
              star = webRTCStar();
              transports.push(star.transport);
            }

            const peerDiscoveryList = [
              bootstrap({ list: [
                "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
                "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa"
              ]})
            ];

            if (star) {
              peerDiscoveryList.push(star.discovery);
            }

            this.node = await createLibp2p({
              transports,
              connectionEncrypters: [noise()],
              streamMuxers: [yamux()],
              peerDiscovery: peerDiscoveryList,
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
            const url = new URL(request.url);
            const req = {
              method: request.method,
              path: url.pathname,
              headers: Object.fromEntries(request.headers.entries()),
              body: await request.json(),
              params: {}
            };

            const match = url.pathname.match(new RegExp(handler.regex));
            if (match && handler.paramNames) {
              handler.paramNames.forEach((name, index) => {
                req.params[name] = match[index + 1];
              });
            }

            const sbx = {
              mesh: {
                getPeerId: () => "local"
              },
              split: async (data, strategy, options) => 
                await splitRuntime(data, strategy, options),
              merge: (results, strategy, options) => 
                mergeRuntime(results, strategy, options)
            };

            const res = {
              statusCode: 200, headers: {},
              status(c) { this.statusCode = c; return this; },
              setHeader(n, v) { this.headers[n] = v; return this; },
              send(body) { return new Response(body, { status: this.statusCode, headers: this.headers }); }
            };
            const result = await workers.execute(handler.fn, req, sbx);
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
          paramNames: this.extractParamNames(route.pattern),
          fn: `(req, sbx) => {
            const res = {
              statusCode: 200,
              status: function(code) {
                this.statusCode = code;
                return this;
              },
              send: function(body) {
                return { status: this.statusCode, body };
              }
            };
            
            return (${route.handler.toString()})(req, res);
          }`,
        };
      })
      .filter(Boolean);
    return JSON.stringify(routes, null, 2);
  }

  private static extractParamNames(pattern: string): string[] {
    const names: string[] = [];
    const segments = pattern.split("/").filter(Boolean);

    segments.forEach((seg) => {
      if (seg.startsWith(":")) {
        names.push(seg.slice(1).replace(/\?$/, ""));
      }
    });

    return names;
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
