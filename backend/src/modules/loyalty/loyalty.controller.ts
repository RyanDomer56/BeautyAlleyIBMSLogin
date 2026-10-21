import type { Request, Response } from "express";
import { loyaltyService } from "./loyalty.service";
import type { Actor } from "../../types/actor";

export const loyaltyController = {
  async list(req: Request, res: Response) {
    const result = await loyaltyService.list(req.query as never);
    res.status(200).json(result);
  },

  async getById(req: Request, res: Response) {
    const result = await loyaltyService.forClient(req.params.id);
    res.status(200).json({ data: result });
  },

  async promote(req: Request, res: Response) {
    const result = await loyaltyService.promote(
      req.params.id,
      req.body,
      (req.actor as Actor | undefined)?.id ?? null
    );
    res.status(200).json({ data: result });
  },

  async revoke(req: Request, res: Response) {
    const result = await loyaltyService.revoke(
      req.params.id,
      (req.actor as Actor | undefined)?.id ?? null
    );
    res.status(200).json({ data: result });
  },
};
