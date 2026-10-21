import type { Request, Response } from "express";
import { promosService } from "./promos.service";

export const promosController = {
  async validate(req: Request, res: Response) {
    const result = await promosService.validate(req.body, req.actor);
    res.status(200).json({ data: result });
  },

  async list(req: Request, res: Response) {
    const result = await promosService.list(req.query as never);
    res.status(200).json(result);
  },

  async getById(req: Request, res: Response) {
    const result = await promosService.getById(req.params.id);
    res.status(200).json({ data: result });
  },

  async create(req: Request, res: Response) {
    const result = await promosService.create(req.body);
    res.status(201).json({ data: result });
  },

  async update(req: Request, res: Response) {
    const result = await promosService.update(req.params.id, req.body);
    res.status(200).json({ data: result });
  },

  async remove(req: Request, res: Response) {
    const result = await promosService.deactivate(req.params.id);
    res.status(200).json({ data: result });
  },
};
