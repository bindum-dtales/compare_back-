import { Router } from "express";
import * as c from "../controllers/companies.controller.js";

export const companiesRoutes = Router();
companiesRoutes.get("/", c.list);
companiesRoutes.post("/search", c.search);
companiesRoutes.get("/:id", c.get);
companiesRoutes.get("/:id/comparison", c.comparison);
