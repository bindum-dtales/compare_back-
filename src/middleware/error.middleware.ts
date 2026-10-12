import type { ErrorRequestHandler, RequestHandler } from "express";
import { ApiError } from "../utils/errors.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ success: false, error: { code: "ROUTE_NOT_FOUND", message: `No route for ${req.method} ${req.path}.` } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }
  // express.json() parse failures
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ success: false, error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON." } });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
    return;
  }
  console.error("[unhandled]", err);
  res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
};
