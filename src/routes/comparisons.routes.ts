import { Router } from "express";
import * as c from "../controllers/comparisons.controller.js";

export const comparisonsRoutes = Router();
comparisonsRoutes.post("/", c.create);
comparisonsRoutes.get("/:id", c.get);
comparisonsRoutes.put("/:id", c.update);
comparisonsRoutes.delete("/:id", c.remove);
