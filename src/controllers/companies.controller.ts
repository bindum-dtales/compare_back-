import type { Request, Response } from "express";
import * as service from "../services/company.service.js";
import { companyIdSchema, parse, searchSchema } from "../utils/validation.js";

export async function list(_req: Request, res: Response) {
  res.json({ success: true, data: await service.listCompanies() });
}

export async function get(req: Request, res: Response) {
  res.json({ success: true, data: await service.getCompany(parse(companyIdSchema, req.params.id)) });
}

/** The company with its competitors; competitor scores never come from overwriting their own records. */
export async function comparison(req: Request, res: Response) {
  res.json({ success: true, data: await service.getComparison(parse(companyIdSchema, req.params.id)) });
}

export async function search(req: Request, res: Response) {
  const { query } = parse(searchSchema, req.body);
  res.json({ success: true, data: await service.searchCompanies(query) });
}
