import { Router } from "express";
import { supabase } from "../supabase/client.js";

export const healthRoutes = Router();

healthRoutes.get("/", (_req, res) => {
  res.json({ success: true, data: { status: "ok", uptime: process.uptime() } });
});

/** Confirms Supabase is reachable and the schema is migrated. */
healthRoutes.get("/db", async (_req, res) => {
  const { error } = await supabase.from("companies").select("id", { head: true, count: "exact" });
  if (error) {
    console.error("[health/db]", error.code, error.message);
    res.status(503).json({ success: false, error: { code: "DATABASE_UNAVAILABLE", message: "Database is unreachable or not migrated." } });
    return;
  }
  res.json({ success: true, data: { database: "ok" } });
});
