import { requireServiceRole, supabasePublic } from "../../db/supabase";
import { toRange, type Pagination } from "../../lib/pagination";
import { AppError, CODES } from "../../lib/errors";
import type { Database } from "../../types/database";
import type { CreateEmployeeInput, UpdateEmployeeInput } from "./employees.schemas";

export interface EmployeeRow {
  id: string;
  profile_id: string | null;
  full_name: string;
  title: string | null;
  bio: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkingHourRow {
  id: string;
  employee_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface TimeOffRow {
  id: string;
  employee_id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

const SELECT =
  "id, profile_id, full_name, title, bio, is_active, created_at, updated_at" as const;

type EmployeeUpdate = Database["public"]["Tables"]["employees"]["Update"];

export const employeesRepository = {
  async list(opts: {
    pagination: Pagination & { sort: string; order: "asc" | "desc" };
    includeInactive: boolean;
    serviceId?: string;
  }): Promise<{ rows: EmployeeRow[]; total: number }> {
    // As with services: a public read goes through the publishable key and
    // relies on the `employees_public_read` policy to hide inactive staff.
    const db = opts.includeInactive ? requireServiceRole() : supabasePublic;
    const { from, to } = toRange(opts.pagination);

    // Filtering by service needs an inner join, so the qualified ids are
    // resolved first and used as an `in` filter. Doing it in one PostgREST
    // query would require an embedded resource and would break the count.
    let ids: string[] | null = null;
    if (opts.serviceId) {
      const { data, error } = await db
        .from("employee_services")
        .select("employee_id")
        .eq("service_id", opts.serviceId);
      if (error) throw error;
      ids = (data ?? []).map((r) => r.employee_id);
      if (ids.length === 0) return { rows: [], total: 0 };
    }

    let query = db.from("employees").select(SELECT, { count: "exact" });
    if (!opts.includeInactive) query = query.eq("is_active", true);
    if (ids) query = query.in("id", ids);

    const { data, error, count } = await query
      .order(opts.pagination.sort, { ascending: opts.pagination.order === "asc" })
      .range(from, to);
    if (error) throw error;
    return { rows: (data ?? []) as EmployeeRow[], total: count ?? 0 };
  },

  async getById(id: string, publicView = false): Promise<EmployeeRow | null> {
    const db = publicView ? supabasePublic : requireServiceRole();
    const { data, error } = await db.from("employees").select(SELECT).eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as EmployeeRow) ?? null;
  },

  async getByProfileId(profileId: string): Promise<EmployeeRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db.from("employees").select(SELECT).eq("profile_id", profileId).maybeSingle();
    if (error) throw error;
    return (data as EmployeeRow) ?? null;
  },

  /**
   * `employee_services` has an anon SELECT grant, so the public "which stylist
   * does what" mapping needs no privileged access - the RLS policy on the
   * table filters to active employees.
   */
  async serviceIdsFor(employeeId: string, publicView = false): Promise<string[]> {
    const db = publicView ? supabasePublic : requireServiceRole();
    const { data, error } = await db
      .from("employee_services")
      .select("service_id")
      .eq("employee_id", employeeId);
    if (error) throw error;
    return data.map((r) => r.service_id);
  },

  async workingHoursFor(employeeId: string): Promise<WorkingHourRow[]> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("working_hours")
      .select("id, employee_id, weekday, start_time, end_time")
      .eq("employee_id", employeeId)
      .order("weekday")
      .order("start_time");
    if (error) throw error;
    return (data ?? []) as WorkingHourRow[];
  },

  async timeOffFor(employeeId: string, from?: string): Promise<TimeOffRow[]> {
    const db = requireServiceRole();
    let query = db
      .from("time_off")
      .select("id, employee_id, starts_at, ends_at, reason")
      .eq("employee_id", employeeId)
      .order("starts_at");
    if (from) query = query.gte("ends_at", from);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as TimeOffRow[];
  },

  /**
   * Migration 35: the employee and their qualifications are one statement.
   *
   * This used to be `create` followed by `setServices`, and a service id that
   * did not exist made the second call fail after the first had committed -
   * so POST /employees returned 400 and left a qualified-for-nothing employee
   * behind. The existence check is inside the function now, so it either all
   * applies or none of it does.
   */
  async create(input: CreateEmployeeInput, actorId: string | null = null): Promise<EmployeeRow> {
    const db = requireServiceRole();
    const { data, error } = await db.rpc("create_employee", {
      p_full_name: input.fullName,
      p_title: input.title ?? null,
      p_bio: input.bio ?? null,
      p_profile_id: input.profileId ?? null,
      p_is_active: input.isActive,
      p_service_ids: input.serviceIds,
      p_actor: actorId,
    });
    if (error) throw error;

    const id = data as string;
    const row = await this.getById(id);
    if (!row) throw AppError.internal("employee disappeared mid-create");
    return row;
  },

  async update(id: string, patch: UpdateEmployeeInput): Promise<EmployeeRow | null> {
    const db = requireServiceRole();
    const row: EmployeeUpdate = {};
    if (patch.fullName !== undefined) row.full_name = patch.fullName;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.bio !== undefined) row.bio = patch.bio;
    if (patch.profileId !== undefined) row.profile_id = patch.profileId;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;

    const { data, error } = await db.from("employees").update(row).eq("id", id).select(SELECT).maybeSingle();
    if (error) throw error;
    return (data as EmployeeRow) ?? null;
  },

  async setServices(employeeId: string, serviceIds: string[]) {
    const db = requireServiceRole();
    // Validate first, so an unknown service id is a 400 rather than a foreign
    // key error the client cannot act on. The write itself is one function:
    // a delete-then-insert through PostgREST could commit the delete and then
    // fail the insert, leaving the stylist qualified for nothing.
    if (serviceIds.length > 0) {
      const { data, error } = await db.from("services").select("id").in("id", serviceIds);
      if (error) throw error;
      const found = new Set((data ?? []).map((r: { id: string }) => r.id));
      const missing = serviceIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw AppError.badRequest(CODES.SERVICES_INVALID, "One or more services do not exist", { missing });
      }
    }

    const { data, error } = await db.rpc("replace_employee_services", {
      p_employee_id: employeeId,
      p_service_ids: serviceIds,
    });
    if (error) throw error;
    return (data as string[] | null) ?? serviceIds;
  },

  async setWorkingHours(
    employeeId: string,
    hours: { weekday: number; startTime: string; endTime: string }[]
  ): Promise<WorkingHourRow[]> {
    const db = requireServiceRole();

    // Overlapping shifts on the same day would make availability ambiguous.
    // The unique constraint only catches an identical start time, so the
    // overlap check has to happen here - and it is a pure function of the
    // payload, so it costs nothing to do before the write.
    for (let i = 0; i < hours.length; i++) {
      for (let j = i + 1; j < hours.length; j++) {
        const a = hours[i];
        const b = hours[j];
        if (a.weekday === b.weekday && a.startTime < b.endTime && b.startTime < a.endTime) {
          throw AppError.badRequest(CODES.VALIDATION_FAILED, "Working hours must not overlap", {
            weekday: a.weekday,
            conflict: [a, b],
          });
        }
      }
    }

    // Migration 34. The function re-validates `end_time > start_time` before it
    // deletes anything, because the table's CHECK constraint fires *after* the
    // delete would have committed - which used to wipe a stylist's entire
    // schedule and report it as a 500.
    const { error } = await db.rpc("replace_working_hours", {
      p_employee_id: employeeId,
      p_hours: hours.map((h) => ({
        weekday: h.weekday,
        start_time: h.startTime,
        end_time: h.endTime,
      })),
    });
    if (error) throw error;

    return this.workingHoursFor(employeeId);
  },

  async addTimeOff(employeeId: string, startsAt: string, endsAt: string, reason?: string): Promise<TimeOffRow> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("time_off")
      .insert({ employee_id: employeeId, starts_at: startsAt, ends_at: endsAt, reason: reason ?? null })
      .select("id, employee_id, starts_at, ends_at, reason")
      .single();
    if (error) throw error;
    return data as TimeOffRow;
  },
};
