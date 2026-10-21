import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

export const ROOM_TYPES = [
  "MASSAGE",
  "FACIAL",
  "NAIL",
  "WAXING",
  "SAUNA",
  "VIP",
  "OTHER",
] as const;

export const ROOM_SORT_COLUMNS = ["name", "room_type", "capacity", "created_at"] as const;

const roomType = z.enum(ROOM_TYPES);

export const createRoomSchema = z.object({
  name: z.string().trim().min(2, "A room needs a name").max(80),
  roomType,
  capacity: z.coerce.number().int().positive().max(20).default(1),
  notes: z.string().trim().max(500).optional(),
  isActive: z.boolean().default(true),
});

/**
 * Every field optional, but an empty body is rejected. A PATCH that changes
 * nothing is far more likely to be a client bug than an intent, and silently
 * answering 200 to it hides the bug.
 */
export const updateRoomSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    roomType: roomType.optional(),
    capacity: z.coerce.number().int().positive().max(20).optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

export const listRoomsQuerySchema = paginationSchema.extend({
  sort: z.enum(ROOM_SORT_COLUMNS).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  roomType: roomType.optional(),
  /**
   * Defaults to active-only. A decommissioned room must not appear in the
   * auto-assigner, and "show me everything" is the rare case that should be
   * asked for explicitly.
   */
  includeInactive: z.coerce.boolean().default(false),
});

/**
 * The auto-assigner preview. `start`/`end` are the booking's own window, so the
 * desk sees exactly the rooms that could host *this* booking - not merely the
 * rooms that are free right now.
 */
export const availableRoomsQuerySchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    roomType: roomType.optional(),
    /** Ignore this booking when testing an override, so it does not clash with itself. */
    ignoreBookingId: z.string().uuid().optional(),
  })
  .refine((v) => new Date(v.end) > new Date(v.start), {
    message: "end must be after start",
    path: ["end"],
  });

export const idParamSchema = z.object({ id: z.string().uuid("Not a valid room id") });

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;
export type ListRoomsQuery = z.infer<typeof listRoomsQuerySchema>;
export type AvailableRoomsQuery = z.infer<typeof availableRoomsQuerySchema>;
export type RoomTypeName = (typeof ROOM_TYPES)[number];
