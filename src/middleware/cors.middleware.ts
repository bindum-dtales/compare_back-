import cors from "cors";
import { env } from "../config/env.js";

// Explicit allow-list from FRONTEND_URL (comma-separated). Never a wildcard, no credentials (the
// API uses no cookies or auth headers). A disallowed origin gets no Access-Control-Allow-* headers,
// so the browser blocks the response and fails the preflight that every JSON POST needs. Requests
// without an Origin (curl, health checks) are unaffected, and so are requests through the Next /api
// proxy: it may forward the browser's Origin, but the browser itself saw a same-origin call.
export const createCorsMiddleware = (origins: string[]) =>
  cors({
    origin: origins,
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type"],
  });

export const corsMiddleware = createCorsMiddleware(env.corsOrigins);
