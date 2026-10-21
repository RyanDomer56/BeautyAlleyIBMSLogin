import type { Request, Response } from "express";
import { servicesService } from "./services.service";

export const servicesController = {
  async list(req: Request, res: Response) {
    const result = await servicesService.list(req.query as never);
    res.status(200).json(result);
  },

  async search(req: Request, res: Response) {
    const { q, limit } = req.query as unknown as { q: string; limit: number };
    const result = await servicesService.search(q, limit);
    res.status(200).json({ data: result });
  },

  async getById(req: Request, res: Response) {
    // Public route: an inactive service is a 404, not a hidden row.
    const result = await servicesService.getById(req.params.id, true);
    res.status(200).json({ data: result });
  },

  async create(req: Request, res: Response) {
    const result = await servicesService.create(req.body);
    res.status(201).json({ data: result });
  },

  async update(req: Request, res: Response) {
    const result = await servicesService.update(req.params.id, req.body);
    res.status(200).json({ data: result });
  },

  async remove(req: Request, res: Response) {
    const result = await servicesService.deactivate(req.params.id);
    res.status(200).json({ data: result });
  },
};
