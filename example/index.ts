import { createServerbox } from "../core/serverbox";

const sbx = createServerbox({
  resourceLimits: {
    timeout: 5000,
    memory: 256,
  },
});

sbx.get("/hello", function (req, res) {
  return res.send(
    `Hello from ServerBox! Peer ID: ${sbx.mesh?.getPeerId() || "local"}`
  );
});

sbx.get("/compute/:number", async function (req, res) {
  const num = parseInt(req.params.number ?? "1000");

  const data = Array.from({ length: num }, function (_, i) {
    return i + 1;
  });

  const results = await sbx.split(data, "array", {
    process: `
        
        return data.chunk.map(function(n) {
          return n * n;
        });
      `,
    chunkSize: 100,
  });

  return res.json({
    input: data,
    squares: results,
    computedBy: `Peer ${sbx.mesh?.getPeerId() || "local"}`,
  });
});

sbx.exportStatic({
  outDir: "./dist",
});
