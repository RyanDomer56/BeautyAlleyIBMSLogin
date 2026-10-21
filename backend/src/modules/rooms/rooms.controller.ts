import type { Request, Response } from "express";
import { roomsService } from "./rooms.service";

export const roomsController = {
  async list(req: Request, res: Response) {
    const result = await roomsService.list(req.query as never);
    res.status(200).json(result);
  },

  async listPublic(_req: Request, res: Response) {
    const result = await roomsService.listPublic();
    res.status(200).json({ data: result });
  },

  async available(req: Request, res: Response) {
    const result = await roomsService.available(req.query as never);
    res.status(200).json({ data: result });
  },

  async getById(req: Request, res: Response) {
    const result = await roomsService.getById(req.params.id);
    res.status(200).json({ data: result });
  },

  async create(req: Request, res: Response) {
    const result = await roomsService.create(req.body);
    res.status(201).json({ data: result });
  },

  async update(req: Request, res: Response) {
    const result = await roomsService.update(req.params.id, req.body);
    res.status(200).json({ data: result });
  },

  async remove(req: Request, res: Response) {
    const result = await roomsService.deactivate(req.params.id, req.actor?.id ?? null);
    res.status(200).json({ data: result });
  },
};
