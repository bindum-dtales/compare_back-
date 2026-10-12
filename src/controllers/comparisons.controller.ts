import type { Request, Response } from "express";
import * as service from "../services/comparison.service.js";
import { createComparisonSchema, parse, updateComparisonSchema, uuidSchema } from "../utils/validation.js";

export async function get(req: Request, res: Response) {
  res.json({ success: true, data: await service.getComparison(parse(uuidSchema, req.params.id)) });
}

export async function create(req: Request, res: Response) {
  res.status(201).json({ success: true, data: await service.createComparison(parse(createComparisonSchema, req.body)) });
}

export async function update(req: Request, res: Response) {
  const id = parse(uuidSchema, req.params.id);
  res.json({ success: true, data: await service.updateComparison(id, parse(updateComparisonSchema, req.body)) });
}

export async function remove(req: Request, res: Response) {
  await service.deleteComparison(parse(uuidSchema, req.params.id));
  res.status(204).end();
}
