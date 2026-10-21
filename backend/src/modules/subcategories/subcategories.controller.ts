import type { Request, Response } from "express";
import { subcategoriesService } from "./subcategories.service";
import type { Database } from "../../types/database";

type ServiceCategory = Database["public"]["Tables"]["services"]["Row"]["category"];

export const subcategoriesController = {
  async list(req: Request, res: Response) {
    const result = await subcategoriesService.list(req.query as never);
    res.status(200).json({ data: result });
  },

  /** Grouped menu for the booking page. */
  async menu(req: Request, res: Response) {
    const category = (req.query as { category?: ServiceCategory }).category;
    const result = await subcategoriesService.menu(category);
    res.status(200).json({ data: result });
  },

  async getById(req: Request, res: Response) {
    const result = await subcategoriesService.getById(req.params.id);
    res.status(200).json({ data: result });
  },

  async create(req: Request, res: Response) {
    const result = await subcategoriesService.create(req.body);
    res.status(201).json({ data: result });
  },

  async update(req: Request, res: Response) {
    const result = await subcategoriesService.update(req.params.id, req.body);
    res.status(200).json({ data: result });
  },

  async remove(req: Request, res: Response) {
    const result = await subcategoriesService.deactivate(req.params.id);
    res.status(200).json({ data: result });
  },
};
