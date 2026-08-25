import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createAgentApplication } from "./app.js";

for (const file of [".env.local", ".env"]) {
  const envPath = path.resolve(process.cwd(), file);
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

const application = await createAgentApplication();
await application.app.listen({ host: "127.0.0.1", port: application.config.port });
console.log(`Agent API ready at http://127.0.0.1:${application.config.port}`);

async function shutdown(): Promise<void> {
  await application.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
