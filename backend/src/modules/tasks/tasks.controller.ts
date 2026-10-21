import type { Request, Response } from "express";
import { AppError } from "../../lib/errors";
import { tasksService } from "./tasks.service";

function actorOf(req: Request) {
  if (!req.actor) throw AppError.unauthorized();
  return req.actor;
}

export const tasksController = {
  async list(req: Request, res: Response) {
    const result = await tasksService.list(actorOf(req), req.query as never);
    res.status(200).json(result);
  },

  async mine(req: Request, res: Response) {
    const result = await tasksService.mine(actorOf(req), req.query as never);
    res.status(200).json(result);
  },

  async counts(req: Request, res: Response) {
    const employeeId = (req.query as { employeeId?: string }).employeeId;
    const result = await tasksService.counts(actorOf(req), employeeId);
    res.status(200).json({ data: result });
  },

  async getById(req: Request, res: Response) {
    const result = await tasksService.getById(actorOf(req), req.params.id);
    res.status(200).json({ data: result });
  },

  async create(req: Request, res: Response) {
    const result = await tasksService.create(actorOf(req), req.body);
    res.status(201).json({ data: result });
  },

  async update(req: Request, res: Response) {
    const result = await tasksService.update(actorOf(req), req.params.id, req.body);
    res.status(200).json({ data: result });
  },

  async setStatus(req: Request, res: Response) {
    const result = await tasksService.setStatus(actorOf(req), req.params.id, req.body);
    res.status(200).json({ data: result });
  },

  async cancel(req: Request, res: Response) {
    const result = await tasksService.cancel(actorOf(req), req.params.id);
    res.status(200).json({ data: result });
  },
};
