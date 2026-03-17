import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function parseFrontendPort(rawValue: string | undefined): number | undefined {
  if (!rawValue) {
    return undefined;
  }
  const port = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(port) || port <= 0) {
    return undefined;
  }
  return port;
}

const frontendPort = parseFrontendPort(process.env.NBP_FRONTEND_PORT);

export default defineConfig({
  plugins: [react()],
  server: frontendPort
    ? {
        port: frontendPort,
        strictPort: true,
      }
    : undefined,
});
