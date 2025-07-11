// example
import { createServerbox } from "../core/serverbox";

// Create ServerBox instance (no signaling server needed)
const sbx = createServerbox({
  // Optional resource limits
  resourceLimits: {
    timeout: 5000, // 5 seconds
    memory: 256, // 256 MB
  },
});

// Simple route handler
sbx.get("/hello", function (req, res) {
  return res.send(
    `Hello from ServerBox! Peer ID: ${sbx.mesh?.getPeerId() || "local"}`
  );
});

// Distributed computing example
sbx.get("/compute/:number", async function (req, res) {
  const num = parseInt(req.params.number ?? "1000");

  // Create input data (array of numbers)
  const data = Array.from({ length: num }, function (_, i) {
    return i + 1;
  });

  // Distributed processing job
  const results = await sbx.split(data, "array", {
    process: `
        // This code runs on multiple peers
        return data.chunk.map(function(n) {
          return n * n;
        });
      `,
    chunkSize: 100,
  });

  res.json({
    input: data,
    squares: results,
    computedBy: `Peer ${sbx.mesh?.getPeerId() || "local"}`,
  });
});

sbx.post("/matrix", async function (req: any, res: any) {
  try {
    const { matrixA, matrixB } = req.body;

    // Validate input
    if (!matrixA || !matrixB || matrixA[0].length !== matrixB.length) {
      return res.status(400).json({ error: "Invalid matrix dimensions" });
    }

    const result = await sbx.split({ matrixA, matrixB }, "matrix", {
      process: `
  const { chunk } = data;
  const { matrixA, matrixB } = chunk;
  const rows = matrixA.length;
  const cols = matrixB[0].length;
  const result = Array(rows).fill(0).map(() => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      for (let k = 0; k < matrixB.length; k++) {
        result[i][j] += matrixA[i][k] * matrixB[k][j];
      }
    }
  }

  return result;
      `,

      chunkSize: 1,
    });

    console.log("Matrix result:", result);
    res.json({ result });
  } catch (error) {
    console.error("Matrix error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

sbx.exportStatic({
  outDir: "./dist",
});
