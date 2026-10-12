import express from "express";
import { corsMiddleware } from "./middleware/cors.middleware.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { healthRoutes } from "./routes/health.routes.js";
import { companiesRoutes } from "./routes/companies.routes.js";
import { researchRoutes } from "./routes/research.routes.js";
import { comparisonsRoutes } from "./routes/comparisons.routes.js";

export const app = express();

app.disable("x-powered-by");
app.use(corsMiddleware);
app.use(express.json({ limit: "100kb" }));

app.use("/health", healthRoutes);
app.use("/api/companies", companiesRoutes);
app.use("/api/research", researchRoutes);
app.use("/api/comparisons", comparisonsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
