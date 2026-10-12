import { Router } from "express";
import * as c from "../controllers/research.controller.js";

export const researchRoutes = Router();
researchRoutes.post("/", c.start);
researchRoutes.get("/:jobId", c.status);
