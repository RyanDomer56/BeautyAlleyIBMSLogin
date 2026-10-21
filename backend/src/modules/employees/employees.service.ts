import { requireServiceRole, supabasePublic } from "../../db/supabase";
import { iso } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { paginated } from "../../lib/pagination";
import {
  employeesRepository,
  type EmployeeRow,
  type TimeOffRow,
  type WorkingHourRow,
} from "./employees.repository";
import type {
  CreateEmployeeInput,
  ListEmployeesQuery,
  UpdateEmployeeInput,
} from "./employees.schemas";

export function toEmployeeDto(row: EmployeeRow) {
  return {
    id: row.id,
    profileId: row.profile_id,
    fullName: row.full_name,
    title: row.title,
    bio: row.bio,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toWorkingHourDto(row: WorkingHourRow) {
  return {
    id: row.id,
    weekday: row.weekday,
    // A `time` column, not a timestamp - it has no date and no zone, so it is
    // trimmed to HH:MM rather than put through `iso()`.
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
  };
}

function toTimeOffDto(row: TimeOffRow) {
  return {
    id: row.id,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    reason: row.reason,
  };
}

export const employeesService = {
  async list(query: ListEmployeesQuery) {
    const { rows, total } = await employeesRepository.list({
      pagination: { page: query.page, limit: query.limit, sort: query.sort, order: query.order },
      includeInactive: query.includeInactive,
      serviceId: query.serviceId,
    });
    return paginated(rows.map(toEmployeeDto), total, query.page, query.limit);
  },

  async getById(id: string, publicView = false) {
    const row = await employeesRepository.getById(id, publicView);
    if (!row) throw AppError.notFound(CODES.EMPLOYEE_NOT_FOUND, "No such employee");

    const serviceIds = await employeesRepository.serviceIdsFor(id, publicView);

    // Working hours have no RLS policy for anon/authenticated - they are an
    // internal scheduling detail, not part of the public "meet the team"
    // profile. Omitting them from the public shape is deliberate rather than
    // an accident of the query returning nothing.
    if (publicView) return { ...toEmployeeDto(row), serviceIds };

    const hours = await employeesRepository.workingHoursFor(id);
    return {
      ...toEmployeeDto(row),
      serviceIds,
      workingHours: hours.map(toWorkingHourDto),
    };
  },

  async create(input: CreateEmployeeInput, actorId: string | null = null) {
    // The qualifications are created with the employee, in one statement - see
    // migration 35. The old shape created the row, then called setServices,
    // which validated second and failed after the first had committed.
    const row = await employeesRepository.create(input, actorId);
    return this.getById(row.id);
  },

  async update(id: string, patch: UpdateEmployeeInput) {
    await this.getById(id);
    const row = await employeesRepository.update(id, patch);
    if (!row) throw AppError.notFound(CODES.EMPLOYEE_NOT_FOUND, "No such employee");
    return this.getById(id);
  },

  async deactivate(id: string) {
    return this.update(id, { isActive: false });
  },

  async setServices(id: string, serviceIds: string[]) {
    await this.getById(id);
    await employeesRepository.setServices(id, serviceIds);
    return this.getById(id);
  },

  async setWorkingHours(
    id: string,
    hours: { weekday: number; startTime: string; endTime: string }[]
  ) {
    await this.getById(id);
    await employeesRepository.setWorkingHours(id, hours);
    return this.getById(id);
  },

  async addTimeOff(id: string, startsAt: string, endsAt: string, reason?: string) {
    await this.getById(id);
    const row = await employeesRepository.addTimeOff(id, startsAt, endsAt, reason);
    return toTimeOffDto(row);
  },

  async timeOff(id: string) {
    await this.getById(id);
    const rows = await employeesRepository.timeOffFor(id);
    return rows.map(toTimeOffDto);
  },

  async performance(id: string, from: string, to: string) {
    await this.getById(id);
    const db = requireServiceRole();
    const { data, error } = await db.rpc("get_employee_performance", {
      p_employee_id: id,
      p_from: from,
      p_to: to,
    });
    if (error) throw error;
    return data;
  },

  /**
   * One employee's progress against the daily completion quota.
   *
   * The rule - which statuses count, which timezone decides "today", how
   * `remaining` and `met` follow - lives in `public.employee_quota_rows()`
   * (migration 26), not here. This method is a transport hop, so the owner's
   * board and the stylist's own page cannot drift apart.
   *
   * `getById` runs first only to turn an unknown id into the API's own 404;
   * the function raises EMPLOYEE_NOT_FOUND, which the error mapper also
   * understands, so this is belt-and-braces rather than the only guard.
   */
  async quota(id: string, date?: string) {
    await this.getById(id);
    const { data, error } = await requireServiceRole().rpc("get_employee_quota", {
      p_employee_id: id,
      p_day: date ?? null,
    });
    if (error) throw error;
    return data;
  },

  /** The whole active floor at once, for the board. One round trip, not N. */
  async quotas(date?: string) {
    const { data, error } = await requireServiceRole().rpc("get_employee_quotas", {
      p_day: date ?? null,
    });
    if (error) throw error;
    return data ?? [];
  },

  /**
   * Free slots for a service on a date.
   *
   * The grouping is done in Node rather than SQL because the shape a client
   * wants is "these stylists, each with their slots" - and the database
   * function returns a flat, index-friendly list that is trivial to group.
   */
  async availability(opts: {
    serviceId: string;
    date: string;
    employeeId?: string;
    intervalMinutes: number;
  }) {
    // Public. `get_available_slots` is one of the two functions migration 14
    // re-grants to anon - it is read-only and returns no personal data.
    const { data, error } = await supabasePublic.rpc("get_available_slots", {
      p_service_id: opts.serviceId,
      p_date: opts.date,
      p_employee_id: opts.employeeId ?? null,
      p_interval_minutes: opts.intervalMinutes,
    });
    if (error) throw error;

    const rows = data ?? [];

    const byEmployee = new Map<string, { employeeId: string; slots: { start: string; end: string }[] }>();
    for (const r of rows) {
      const entry = byEmployee.get(r.employee_id) ?? { employeeId: r.employee_id, slots: [] };
      entry.slots.push({ start: iso(r.slot_start), end: iso(r.slot_end) });
      byEmployee.set(r.employee_id, entry);
    }

    return {
      serviceId: opts.serviceId,
      date: opts.date,
      intervalMinutes: opts.intervalMinutes,
      totalSlots: rows.length,
      employees: [...byEmployee.values()],
    };
  },
};
