import { config } from "./config/env";
import { buildApp } from "./app";

const server = buildApp();

server.listen(config.port, () => {
  console.log(`KATKEE backend listening on http://localhost:${config.port} (${config.nodeEnv})`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
