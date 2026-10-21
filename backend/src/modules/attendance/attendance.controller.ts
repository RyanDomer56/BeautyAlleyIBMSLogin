import type { Request, Response } from "express";
import { AppError } from "../../lib/errors";
import { attendanceService } from "./attendance.service";

/** Every handler needs the actor; this keeps the null check in one place. */
function actorOf(req: Request) {
  if (!req.actor) throw AppError.unauthorized();
  return req.actor;
}

export const attendanceController = {
  async list(req: Request, res: Response) {
    const result = await attendanceService.list(actorOf(req), req.query as never);
    res.status(200).json(result);
  },

  async summary(req: Request, res: Response) {
    const result = await attendanceService.summary(actorOf(req), req.query as never);
    res.status(200).json({ data: result });
  },

  async me(req: Request, res: Response) {
    const result = await attendanceService.me(actorOf(req));
    res.status(200).json({ data: result });
  },

  async getById(req: Request, res: Response) {
    const result = await attendanceService.getById(actorOf(req), req.params.id);
    res.status(200).json({ data: result });
  },

  async clockIn(req: Request, res: Response) {
    const result = await attendanceService.clockIn(actorOf(req), req.body);
    res.status(201).json({ data: result });
  },

  async clockOut(req: Request, res: Response) {
    const result = await attendanceService.clockOut(actorOf(req), req.body);
    res.status(200).json({ data: result });
  },

  async amend(req: Request, res: Response) {
    const result = await attendanceService.amend(actorOf(req), req.params.id, req.body);
    res.status(200).json({ data: result });
  },
};
