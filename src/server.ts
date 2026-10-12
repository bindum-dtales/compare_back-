import { env } from "./config/env.js";
import { configDiagnostics } from "./config/diagnostics.js";
import { app } from "./app.js";
import { startResearchWorker } from "./workers/research.worker.js";
import { jinaConfigStatus } from "./services/jina.service.js";

for (const line of configDiagnostics(env)) console.log(line);
console.log(jinaConfigStatus());

const onListening = () => console.log(`API listening on ${env.HOST ?? "all interfaces"}, port ${env.PORT} (${env.NODE_ENV})`);
// HOST unset keeps Node's default (all interfaces).
const server = env.HOST ? app.listen(env.PORT, env.HOST, onListening) : app.listen(env.PORT, onListening);
const worker = startResearchWorker();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    worker.stop();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
