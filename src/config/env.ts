import { z } from "zod";
import { parseCorsOrigins } from "./origins.js";

/** Unset and empty ("KEY=") both mean "not configured". */
const optionalSecret = z.string().trim().optional().transform((v) => v || undefined);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  // Interface to bind. Unset: all interfaces (Node's default). Behind Nginx on the same host, 127.0.0.1.
  HOST: z.string().trim().optional().transform((v) => v || undefined),
  // CORS allow-list, comma-separated origins (see config/origins.ts). Unset: localhost:3000 in
  // development, none in production (the frontend's /api proxy is same-origin and needs none).
  FRONTEND_URL: z.string().optional(),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Optional: Jina Reader works keyless at a low rate limit; a key raises it.
  JINA_API_KEY: optionalSecret,
  // Optional at boot so the API runs without them; research jobs fail with a clear
  // "not configured" error until they're set.
  TAVILY_API_KEY: optionalSecret,
  GROQ_API_KEY: optionalSecret,
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Names only — never echo values, they may be secrets.
  const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  throw new Error(`Invalid environment configuration: ${missing}. See .env.example.`);
}

export const env = {
  ...parsed.data,
  corsOrigins: parseCorsOrigins(parsed.data.FRONTEND_URL, parsed.data.NODE_ENV),
};
