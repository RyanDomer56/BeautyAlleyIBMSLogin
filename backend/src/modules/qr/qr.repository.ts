import { requireServiceRole } from "../../db/supabase";
import type { Database } from "../../types/database";

type ServiceCategory = Database["public"]["Tables"]["services"]["Row"]["category"];

export interface CatalogueItem {
  id: string;
  name: string;
  category: ServiceCategory;
  price_cents: number;
  duration_minutes: number;
  required_room_type: string | null;
  subcategory_id: string | null;
}

export const qrRepository = {
  /**
   * The widest opening window today, across everyone working.
   *
   * This is what a walk-in needs: "the door opens at 09:00 and the last
   * treatment starts at 20:00". It is not a per-stylist availability answer -
   * that is `get_available_slots`, and it needs a service and a date.
   */
  async todayHours(weekday: number, timezone: string) {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("working_hours")
      .select("start_time, end_time, employees!inner(is_active)")
      .eq("weekday", weekday)
      .eq("employees.is_active", true);
    if (error) throw error;

    const rows = (data ?? []) as unknown as { start_time: string; end_time: string }[];
    if (rows.length === 0) return { opensAt: null, closesAt: null, timezone };

    // `time` columns arrive as "HH:MM:SS". Min/max as strings is safe because
    // the format is fixed-width and zero-padded.
    const starts = rows.map((r) => r.start_time).sort();
    const ends = rows.map((r) => r.end_time).sort();
    return {
      opensAt: starts[0].slice(0, 5),
      closesAt: ends[ends.length - 1].slice(0, 5),
      timezone,
    };
  },

  /** The bookable catalogue, for the walk-in menu. */
  async catalogue(): Promise<CatalogueItem[]> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("services")
      .select("id, name, category, price_cents, duration_minutes, required_room_type, subcategory_id")
      .eq("is_active", true)
      .order("category")
      .order("name");
    if (error) throw error;
    return (data ?? []) as CatalogueItem[];
  },
};
