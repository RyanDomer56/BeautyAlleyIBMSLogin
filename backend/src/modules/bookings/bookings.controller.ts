import type { Request, Response } from "express";
import { bookingsService } from "./bookings.service";
import type { Actor } from "../../types/actor";

export const bookingsController = {
  async create(req: Request, res: Response) {
    const result = await bookingsService.create(req.body, req.actor);
    res.status(201).json({ data: result });
  },

  async getById(req: Request, res: Response) {
    const result = await bookingsService.detailFor(req.params.id, req.actor);
    res.status(200).json({ data: result });
  },

  async mine(req: Request, res: Response) {
    const result = await bookingsService.mine(req.actor as Actor, req.query as never);
    res.status(200).json(result);
  },

  async list(req: Request, res: Response) {
    const result = await bookingsService.list(req.query as never);
    res.status(200).json(result);
  },

  async cancel(req: Request, res: Response) {
    const result = await bookingsService.cancel(req.params.id, req.body, req.actor);
    res.status(200).json({ data: result });
  },

  async reschedule(req: Request, res: Response) {
    const result = await bookingsService.reschedule(req.params.id, req.body.startTime, req.actor);
    res.status(200).json({ data: result });
  },

  async updateStatus(req: Request, res: Response) {
    const result = await bookingsService.updateStatus(req.params.id, req.body.status, req.actor as Actor);
    res.status(200).json({ data: result });
  },

  async qr(req: Request, res: Response) {
    const result = await bookingsService.qr(req.params.id, req.actor);
    res.status(200).json({ data: result });
  },

  async notes(req: Request, res: Response) {
    const result = await bookingsService.notes(req.params.id, req.actor);
    res.status(200).json({ data: result });
  },

  async addNote(req: Request, res: Response) {
    const result = await bookingsService.addNote(req.params.id, req.body, req.actor as Actor);
    res.status(201).json({ data: result });
  },

  async deleteNote(req: Request, res: Response) {
    await bookingsService.deleteNote(req.params.id, req.params.noteId, req.actor as Actor);
    res.status(204).send();
  },

  async setRoom(req: Request, res: Response) {
    const result = await bookingsService.setRoom(req.params.id, req.body.roomId, req.actor as Actor);
    res.status(200).json({ data: result });
  },

  async setEmployee(req: Request, res: Response) {
    const result = await bookingsService.setEmployee(
      req.params.id,
      req.body.employeeId,
      req.actor as Actor
    );
    res.status(200).json({ data: result });
  },
};
