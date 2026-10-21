import type { Request, Response } from "express";
import { authService } from "./auth.service";
import type { Actor } from "../../types/actor";

function clientIp(req: Request): string | null {
  // `req.ip` already honours the trust-proxy setting configured in app.ts.
  return req.ip ?? null;
}

export const authController = {
  async register(req: Request, res: Response) {
    const result = await authService.register(req.body, clientIp(req));
    res.status(201).json({ data: result });
  },

  async login(req: Request, res: Response) {
    const result = await authService.login(req.body, clientIp(req));
    res.status(200).json({ data: result });
  },

  async refresh(req: Request, res: Response) {
    const result = await authService.refresh(req.body.refreshToken);
    res.status(200).json({ data: result });
  },

  async logout(req: Request, res: Response) {
    await authService.logout(req.actor!.accessToken);
    res.status(204).send();
  },

  async me(req: Request, res: Response) {
    const result = await authService.me(req.actor!);
    res.status(200).json({ data: result });
  },

  async createStaff(req: Request, res: Response) {
    const result = await authService.createStaff(req.body, req.actor as Actor);
    res.status(201).json({ data: result });
  },
};
