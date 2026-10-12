// Startup log lines about configuration. Names and non-secret settings only: never a key's value.

interface DiagnosticsInput {
  NODE_ENV: string;
  corsOrigins: string[];
  GROQ_API_KEY?: string;
  TAVILY_API_KEY?: string;
}

export function configDiagnostics(env: DiagnosticsInput): string[] {
  const lines = [
    env.corsOrigins.length
      ? `[cors] cross-origin browsers allowed: ${env.corsOrigins.join(", ")}`
      : "[cors] no cross-origin browsers allowed (FRONTEND_URL unset): only same-origin calls through the frontend's /api proxy",
  ];
  // Optional at boot (config/env.ts); without them every research job fails with "not configured".
  for (const [name, value] of [["GROQ_API_KEY", env.GROQ_API_KEY], ["TAVILY_API_KEY", env.TAVILY_API_KEY]] as const) {
    if (!value) lines.push(`[config] ${name} is not set: research jobs will fail with a "not configured" error until it is`);
  }
  return lines;
}
