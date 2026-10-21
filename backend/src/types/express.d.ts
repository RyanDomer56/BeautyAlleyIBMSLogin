import type { Actor } from "./actor";

declare global {
  namespace Express {
    interface Request {
      /** Populated by the `authenticate` middleware. */
      actor?: Actor;
    }
  }
}

export {};
