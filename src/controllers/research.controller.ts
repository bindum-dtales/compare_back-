import type { Request, Response } from "express";
import * as service from "../services/research.service.js";
import { parse, startResearchSchema, uuidSchema } from "../utils/validation.js";
import { wakeResearchWorker } from "../workers/research.worker.js";

export async function start(req: Request, res: Response) {
  const result = await service.startResearch(parse(startResearchSchema, req.body));
  if (result.status === "queued") wakeResearchWorker(); // runs in the background; we don't wait
  // 202: job accepted, poll GET /api/research/:jobId. 200: already researched.
  res.status(result.status === "existing" ? 200 : 202).json({ success: true, data: result });
}

export async function status(req: Request, res: Response) {
  res.json({ success: true, data: await service.getJob(parse(uuidSchema, req.params.jobId)) });
}
