import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/setup-mocks.ts"],
    env: {
      NODE_ENV: "test",
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      // Dummy keys: providers are constructed, but every HTTP call is mocked in tests.
      TAVILY_API_KEY: "test-tavily-key",
      GROQ_API_KEY: "test-groq-key",
      JINA_API_KEY: "",
    },
  },
});
