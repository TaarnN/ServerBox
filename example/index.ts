import { createServerbox } from "../core/serverbox";

const sbx = createServerbox({
  resourceLimits: {
    timeout: 7000,
    memory: 512,
  },
});

sbx.get("/greet", function (req, res) {
  return res.send("Hello");
});
sbx.exportStatic({
  outDir: "./dist",
});
