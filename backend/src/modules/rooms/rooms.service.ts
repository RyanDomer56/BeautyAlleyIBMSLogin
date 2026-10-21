import { iso, isoOrNull } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { paginated } from "../../lib/pagination";
import { roomsRepository, type RoomRow } from "./rooms.repository";
import type {
  AvailableRoomsQuery,
  CreateRoomInput,
  ListRoomsQuery,
  RoomTypeName,
  UpdateRoomInput,
} from "./rooms.schemas";

/** Row -> wire shape. Snake case stays in the database. */
export function toRoomDto(row: RoomRow) {
  return {
    id: row.id,
    name: row.name,
    roomType: row.room_type,
    capacity: row.capacity,
    notes: row.notes,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export const roomsService = {
  async list(query: ListRoomsQuery) {
    const { rows, total } = await roomsRepository.list(query);
    return paginated(rows.map(toRoomDto), total, query.page, query.limit);
  },

  async listPublic() {
    return (await roomsRepository.listPublic()).map(toRoomDto);
  },

  async getById(id: string) {
    const row = await roomsRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.NOT_FOUND, "No such room");
    return toRoomDto(row);
  },

  /**
   * What the desk sees when it wants to override the auto-assigner.
   *
   * Returns the free rooms *and* the busy ones, each with the booking that is
   * holding it. Showing only the free ones answers "what can I pick" but not
   * "why can't I pick room 3", which is the question the desk actually asks
   * when a client is standing in front of them.
   */
  async available(query: AvailableRoomsQuery) {
    const free = await roomsRepository.findAvailable({
      start: query.start,
      end: query.end,
      roomType: query.roomType,
      ignoreBookingId: query.ignoreBookingId,
    });
    const freeIds = new Set(free.map((r) => r.id));

    // limit 100 is the shared ceiling and comfortably above any real floor
    // plan; a room list is not a collection that grows without bound.
    const allQuery: ListRoomsQuery = {
      page: 1,
      limit: 100,
      sort: "name",
      order: "asc",
      includeInactive: false,
      roomType: query.roomType,
    };
    const all = await roomsRepository.list(allQuery);

    const busy = all.rows.filter((r) => !freeIds.has(r.id));
    const blocked = await roomsRepository.overlappingRoomIds({
      start: query.start,
      end: query.end,
      roomIds: busy.map((r) => r.id),
      ignoreBookingId: query.ignoreBookingId,
    });

    return {
      start: iso(query.start),
      end: iso(query.end),
      roomType: query.roomType ?? null,
      available: free.map(toRoomDto),
      // `blocked` is recomputed rather than reused from the filter above: the
      // two lists are built by different code paths, and this is the one that
      // actually names the reason.
      unavailable: busy
        .filter((r) => blocked.has(r.id))
        .map((r) => ({ ...toRoomDto(r), reason: "OCCUPIED" as const })),
    };
  },

  /**
   * The auto-assigner. Called by the booking flow when the caller did not name
   * a room and the service needs one.
   *
   * Returns null when nothing is free. That is deliberately NOT an error here:
   * the caller decides whether a missing room is fatal (a massage with no
   * massage room) or merely a warning. `create_booking` is the authority - it
   * runs inside the transaction and re-checks under the exclusion constraint.
   */
  async autoAssign(opts: { roomType: RoomTypeName; start: string; end: string }) {
    const room = await roomsRepository.firstAvailable({
      start: opts.start,
      end: opts.end,
      roomType: opts.roomType,
    });
    return room ? toRoomDto(room) : null;
  },

  async create(input: CreateRoomInput) {
    try {
      const row = await roomsRepository.create(input);
      return toRoomDto(row);
    } catch (err) {
      // rooms_name_key is a unique index on lower(name), so "Suite A" and
      // "suite a" collide. Saying so beats a bare 409.
      if ((err as { code?: string })?.code === "23505") {
        throw AppError.conflict(CODES.CONFLICT, `A room named "${input.name}" already exists`);
      }
      throw err;
    }
  },

  async update(id: string, patch: UpdateRoomInput) {
    await this.getById(id);
    try {
      const row = await roomsRepository.update(id, patch);
      if (!row) throw AppError.notFound(CODES.NOT_FOUND, "No such room");
      return toRoomDto(row);
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw AppError.conflict(CODES.CONFLICT, "Another room already uses that name");
      }
      throw err;
    }
  },

  /**
   * Soft delete, matching the promos module: a room is deactivated, never
   * dropped. Hard-deleting would `set null` on every historical booking and
   * erase which room a past treatment happened in - the same reason promo
   * redemptions are kept.
   *
   * Refused while the room is still booked: deactivating it would leave the
   * desk with a schedule that names a room they can no longer open, and no
   * warning at the time it happens.
   *
   * The count below is for the message only. The authoritative check is inside
   * `deactivate_room()` (migration 34), because a count-then-update here let a
   * booking created in between land in a room that had just been closed.
   */
  async deactivate(id: string, actorId: string | null = null) {
    const room = await this.getById(id);
    if (!room.isActive) return room;

    const upcoming = await roomsRepository.futureBookingsFor(id);
    if (upcoming > 0) {
      throw AppError.conflict(
        CODES.CONFLICT,
        `${room.name} still has ${upcoming} upcoming booking${upcoming === 1 ? "" : "s"}. ` +
          `Move them to another room before decommissioning it.`
      );
    }

    await roomsRepository.deactivate(id, actorId);
    return this.getById(id);
  },
};
