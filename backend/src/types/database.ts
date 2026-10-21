/**
 * Database types.
 *
 * HAND-WRITTEN, not generated. `supabase gen types typescript` needs the
 * Supabase CLI, which needs Docker, which is not available in this
 * environment (see DESIGN.md §0). These are transcribed from the migrations in
 * supabase/migrations and are the source of truth for every query in
 * src/modules.
 *
 * If the schema changes, this file must change with it. That is a real
 * maintenance cost, and the alternative - leaving the client untyped - is
 * worse: without these, every `.select()` returns `any` and a column renamed
 * in SQL becomes a runtime 500 instead of a compile error.
 *
 * Money is integer minor units (centavos) everywhere. Timestamps are
 * timestamptz, serialised as ISO strings.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Mirrors the `public.user_role` enum. Migration 24 renamed STAFF to EMPLOYEE. */
export type UserRole = "GUEST" | "CLIENT" | "EMPLOYEE" | "CONCIERGE" | "ADMIN";
export type ServiceCategory = "SPA" | "SALON" | "WELLNESS";
export type BookingStatus =
  | "PENDING"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_SERVICE"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";
export type PromoType = "PERCENT" | "FIXED";
/** Migration 17. `required_room_type` on a service is NULL when no room is needed. */
export type RoomType = "MASSAGE" | "FACIAL" | "NAIL" | "WAXING" | "SAUNA" | "VIP" | "OTHER";
/** Migration 29. PRESENT is the default on clock-in; the rest are set by a human. */
export type AttendanceStatus = "PRESENT" | "HALF_DAY" | "LEAVE" | "ABSENT";
/** Migration 30. Order is meaningful: LOW < MEDIUM < HIGH < URGENT. */
export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
/** Migration 30. Transitions are enforced by `enforce_task_status_transition`. */
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: UserRole;
          full_name: string | null;
          phone: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          role?: UserRole;
          full_name?: string | null;
          phone?: string | null;
          is_active?: boolean;
        };
        Update: {
          role?: UserRole;
          full_name?: string | null;
          phone?: string | null;
          is_active?: boolean;
        };
        Relationships: [];
      };

      clients: {
        Row: {
          id: string;
          profile_id: string | null;
          full_name: string;
          phone: string | null;
          email: string | null;
          notes: string | null;
          is_active: boolean;
          /** Migration 17. NULL until staff promote the client. */
          member_since: string | null;
          /** Migration 17. Member rate on every booking, stacked with promos. */
          discount_percent: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id?: string | null;
          full_name: string;
          phone?: string | null;
          email?: string | null;
          notes?: string | null;
          is_active?: boolean;
          member_since?: string | null;
          discount_percent?: number;
        };
        Update: {
          profile_id?: string | null;
          full_name?: string;
          phone?: string | null;
          email?: string | null;
          notes?: string | null;
          is_active?: boolean;
          member_since?: string | null;
          discount_percent?: number;
        };
        Relationships: [];
      };

      employees: {
        Row: {
          id: string;
          profile_id: string | null;
          full_name: string;
          title: string | null;
          bio: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id?: string | null;
          full_name: string;
          title?: string | null;
          bio?: string | null;
          is_active?: boolean;
        };
        Update: {
          profile_id?: string | null;
          full_name?: string;
          title?: string | null;
          bio?: string | null;
          is_active?: boolean;
        };
        Relationships: [];
      };

      services: {
        Row: {
          id: string;
          name: string;
          category: ServiceCategory;
          description: string | null;
          price_cents: number;
          duration_minutes: number;
          /** Migration 17. NULL = the service needs no room. */
          required_room_type: RoomType | null;
          /** Migration 17. Second catalogue level. */
          subcategory_id: string | null;
          /** Migration 22. Does a completed visit count toward loyalty? */
          loyalty_eligible: boolean;
          /**
           * Migration 22. The formulation, as a display string — "Glutathione,
           * Vitamin C". NULL when the salon has not confirmed it, which is a
           * different thing from "it has no ingredients", and `ingredients_verified`
           * is what distinguishes the two.
           */
          ingredients: string | null;
          /**
           * Migration 23. False means the ingredients are unknown and must NOT
           * be invented — the catalogue shows a "being confirmed" note instead.
           */
          ingredients_verified: boolean;
          /** Migration 23. True when the price is still a placeholder. */
          needs_pricing: boolean;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          category: ServiceCategory;
          description?: string | null;
          price_cents: number;
          duration_minutes: number;
          required_room_type?: RoomType | null;
          subcategory_id?: string | null;
          loyalty_eligible?: boolean;
          ingredients?: string | null;
          ingredients_verified?: boolean;
          needs_pricing?: boolean;
          is_active?: boolean;
        };
        Update: {
          name?: string;
          category?: ServiceCategory;
          description?: string | null;
          price_cents?: number;
          duration_minutes?: number;
          required_room_type?: RoomType | null;
          subcategory_id?: string | null;
          loyalty_eligible?: boolean;
          ingredients?: string | null;
          ingredients_verified?: boolean;
          needs_pricing?: boolean;
          is_active?: boolean;
        };
        /*
         * Declared, not decorative.
         *
         * supabase-js resolves an embedded select (`subcategory:service_subcategories(...)`)
         * through these entries. With `Relationships: []` it cannot find the
         * relation at all and every row types as
         * `SelectQueryError<"could not find the relation …">` — which is what
         * broke `servicesRepository.list` the first time the embed was added.
         * The name must match the constraint in the database exactly.
         */
        Relationships: [
          {
            foreignKeyName: "services_subcategory_id_fkey";
            columns: ["subcategory_id"];
            isOneToOne: false;
            referencedRelation: "service_subcategories";
            referencedColumns: ["id"];
          },
        ];
      };

      employee_services: {
        Row: { employee_id: string; service_id: string; created_at: string };
        Insert: { employee_id: string; service_id: string };
        Update: { employee_id?: string; service_id?: string };
        Relationships: [];
      };

      working_hours: {
        Row: {
          id: string;
          employee_id: string;
          weekday: number;
          start_time: string;
          end_time: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          employee_id: string;
          weekday: number;
          start_time: string;
          end_time: string;
        };
        Update: {
          employee_id?: string;
          weekday?: number;
          start_time?: string;
          end_time?: string;
        };
        Relationships: [];
      };

      time_off: {
        Row: {
          id: string;
          employee_id: string;
          starts_at: string;
          ends_at: string;
          reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          employee_id: string;
          starts_at: string;
          ends_at: string;
          reason?: string | null;
        };
        Update: {
          employee_id?: string;
          starts_at?: string;
          ends_at?: string;
          reason?: string | null;
        };
        Relationships: [];
      };

      booking_counters: {
        Row: { day: string; last_value: number };
        Insert: { day: string; last_value?: number };
        Update: { last_value?: number };
        Relationships: [];
      };

      bookings: {
        Row: {
          id: string;
          reference: string;
          client_id: string | null;
          guest_name: string | null;
          guest_phone: string | null;
          employee_id: string;
          start_time: string;
          end_time: string;
          status: BookingStatus;
          subtotal_cents: number;
          discount_cents: number;
          total_cents: number;
          promo_code_id: string | null;
          notes: string | null;
          /** Migration 17. Set by the auto-assigner, overridable at the desk. */
          room_id: string | null;
          cancelled_at: string | null;
          cancellation_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          reference: string;
          client_id?: string | null;
          guest_name?: string | null;
          guest_phone?: string | null;
          employee_id: string;
          start_time: string;
          end_time: string;
          status?: BookingStatus;
          subtotal_cents: number;
          discount_cents?: number;
          total_cents: number;
          promo_code_id?: string | null;
          notes?: string | null;
          room_id?: string | null;
          cancelled_at?: string | null;
          cancellation_reason?: string | null;
        };
        Update: {
          start_time?: string;
          end_time?: string;
          status?: BookingStatus;
          cancelled_at?: string | null;
          cancellation_reason?: string | null;
          notes?: string | null;
          room_id?: string | null;
        };
        Relationships: [];
      };

      booking_items: {
        Row: {
          id: string;
          booking_id: string;
          service_id: string | null;
          employee_id: string | null;
          name_snapshot: string;
          price_cents_snapshot: number;
          duration_minutes_snapshot: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          booking_id: string;
          service_id?: string | null;
          employee_id?: string | null;
          name_snapshot: string;
          price_cents_snapshot: number;
          duration_minutes_snapshot: number;
        };
        Update: {
          service_id?: string | null;
          employee_id?: string | null;
          name_snapshot?: string;
          price_cents_snapshot?: number;
          duration_minutes_snapshot?: number;
        };
        Relationships: [];
      };

      promo_codes: {
        Row: {
          id: string;
          code: string;
          type: PromoType;
          value: number;
          starts_at: string | null;
          ends_at: string | null;
          max_redemptions: number | null;
          per_client_limit: number | null;
          min_spend_cents: number;
          applicable_service_ids: string[] | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          type: PromoType;
          value: number;
          starts_at?: string | null;
          ends_at?: string | null;
          max_redemptions?: number | null;
          per_client_limit?: number | null;
          min_spend_cents?: number;
          applicable_service_ids?: string[] | null;
          is_active?: boolean;
        };
        Update: {
          type?: PromoType;
          value?: number;
          starts_at?: string | null;
          ends_at?: string | null;
          max_redemptions?: number | null;
          per_client_limit?: number | null;
          min_spend_cents?: number;
          applicable_service_ids?: string[] | null;
          is_active?: boolean;
        };
        Relationships: [];
      };

      promo_redemptions: {
        Row: {
          id: string;
          promo_code_id: string;
          booking_id: string;
          client_id: string | null;
          guest_phone: string | null;
          amount_cents: number;
          created_at: string;
          released_at: string | null;
        };
        Insert: {
          id?: string;
          promo_code_id: string;
          booking_id: string;
          client_id?: string | null;
          guest_phone?: string | null;
          amount_cents: number;
          released_at?: string | null;
        };
        Update: { released_at?: string | null };
        Relationships: [];
      };

      // --- migration 17 ------------------------------------------------------

      rooms: {
        Row: {
          id: string;
          name: string;
          room_type: RoomType;
          capacity: number;
          notes: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          room_type: RoomType;
          capacity?: number;
          notes?: string | null;
          is_active?: boolean;
        };
        Update: {
          name?: string;
          room_type?: RoomType;
          capacity?: number;
          notes?: string | null;
          is_active?: boolean;
        };
        Relationships: [];
      };

      service_subcategories: {
        Row: {
          id: string;
          category: ServiceCategory;
          name: string;
          slug: string;
          sort_order: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          category: ServiceCategory;
          name: string;
          slug: string;
          sort_order?: number;
          is_active?: boolean;
        };
        Update: {
          category?: ServiceCategory;
          name?: string;
          slug?: string;
          sort_order?: number;
          is_active?: boolean;
        };
        Relationships: [];
      };

      booking_notes: {
        Row: {
          id: string;
          booking_id: string;
          author_id: string | null;
          body: string;
          visible_to_client: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          booking_id: string;
          author_id?: string | null;
          body: string;
          visible_to_client?: boolean;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          visible_to_client?: boolean;
        };
        Relationships: [];
      };

      qr_tokens: {
        Row: {
          id: string;
          booking_id: string;
          jti: string;
          expires_at: string;
          used_at: string | null;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          booking_id: string;
          jti?: string;
          expires_at: string;
          used_at?: string | null;
          revoked_at?: string | null;
        };
        Update: { used_at?: string | null; revoked_at?: string | null };
        Relationships: [];
      };

      checkins: {
        Row: {
          id: string;
          booking_id: string;
          staff_id: string | null;
          checked_in_at: string;
        };
        Insert: { id?: string; booking_id: string; staff_id?: string | null };
        Update: { staff_id?: string | null };
        Relationships: [];
      };

      audit_logs: {
        Row: {
          id: string;
          actor_id: string | null;
          actor_role: UserRole | null;
          action: string;
          entity: string;
          entity_id: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          actor_id?: string | null;
          actor_role?: UserRole | null;
          action: string;
          entity: string;
          entity_id?: string | null;
          metadata?: Json;
        };
        Update: { metadata?: Json };
        Relationships: [];
      };

      login_attempts: {
        Row: {
          id: string;
          email: string | null;
          succeeded: boolean;
          ip: string | null;
          created_at: string;
        };
        Insert: { id?: string; email?: string | null; succeeded: boolean; ip?: string | null };
        Update: { succeeded?: boolean };
        Relationships: [];
      };

      /** Migration 29. One row per employee per branch-local work day. */
      attendance: {
        Row: {
          id: string;
          employee_id: string;
          /** A branch-local calendar day, not an instant. */
          work_date: string;
          time_in: string;
          time_out: string | null;
          status: AttendanceStatus;
          remarks: string | null;
          recorded_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          employee_id: string;
          work_date?: string;
          time_in?: string;
          time_out?: string | null;
          status?: AttendanceStatus;
          remarks?: string | null;
          recorded_by?: string | null;
        };
        Update: {
          time_out?: string | null;
          status?: AttendanceStatus;
          remarks?: string | null;
          time_in?: string;
          recorded_by?: string | null;
        };
        Relationships: [];
      };

      /** Migration 30. Tasks a concierge assigns to an employee. */
      tasks: {
        Row: {
          id: string;
          /** The small human-readable id, shown as "Task ID". */
          number: number;
          title: string;
          description: string | null;
          employee_id: string;
          created_by: string | null;
          priority: TaskPriority;
          status: TaskStatus;
          due_at: string | null;
          instructions: string | null;
          completion_notes: string | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          description?: string | null;
          employee_id: string;
          created_by?: string | null;
          priority?: TaskPriority;
          status?: TaskStatus;
          due_at?: string | null;
          instructions?: string | null;
          completion_notes?: string | null;
        };
        Update: {
          title?: string;
          description?: string | null;
          employee_id?: string;
          priority?: TaskPriority;
          status?: TaskStatus;
          due_at?: string | null;
          instructions?: string | null;
          completion_notes?: string | null;
        };
        Relationships: [];
      };
    };

    Views: {
      v_booking_detail: {
        Row: {
          id: string;
          reference: string;
          status: BookingStatus;
          start_time: string;
          end_time: string;
          employee_id: string;
          employee_name: string | null;
          client_id: string | null;
          client_name: string | null;
          guest_name: string | null;
          guest_phone: string | null;
          subtotal_cents: number;
          discount_cents: number;
          total_cents: number;
          promo_code_id: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
          /** Migration 19. */
          room_id: string | null;
          room_name: string | null;
          room_type: RoomType | null;
          member_discount_percent: number | null;
          /** Migration 32. Never null: the view coalesces to an empty array. */
          service_ids: string[];
        };
        Relationships: [];
      };
      v_daily_revenue: {
        Row: {
          day: string;
          bookings: number;
          completed: number;
          cancelled: number;
          no_show: number;
          revenue_cents: number;
          discount_cents: number;
        };
        Relationships: [];
      };
      v_client_history: {
        Row: {
          id: string;
          full_name: string;
          phone: string | null;
          email: string | null;
          is_active: boolean;
          total_bookings: number;
          completed_bookings: number;
          no_show_bookings: number;
          lifetime_value_cents: number;
          first_visit_at: string | null;
          last_visit_at: string | null;
        };
        Relationships: [];
      };
      v_employee_utilisation: {
        Row: {
          employee_id: string;
          full_name: string;
          day: string;
          bookings: number;
          booked_minutes: number;
        };
        Relationships: [];
      };
      /**
       * Migration 17. The visit count is derived here, never stored, so
       * cancelling a booking corrects it. `count(*) filter` in the view is a
       * bigint, which PostgREST renders as a number - typed as `number` to
       * match the other reporting views.
       */
      v_client_loyalty: {
        Row: {
          client_id: string;
          full_name: string;
          phone: string | null;
          email: string | null;
          member_since: string | null;
          discount_percent: number;
          completed_visits: number;
          eligible_for_membership: boolean;
        };
        Relationships: [];
      };
      /**
       * Migration 29. Attendance joined to the employee and that weekday's
       * shift, with the hours worked and minutes late derived in SQL so both
       * the employee's page and the admin report agree.
       */
      v_attendance_detail: {
        Row: {
          id: string;
          employee_id: string;
          employee_name: string;
          work_date: string;
          time_in: string;
          time_out: string | null;
          status: AttendanceStatus;
          remarks: string | null;
          recorded_by: string | null;
          scheduled_start: string | null;
          scheduled_end: string | null;
          /** NULL until the session is closed. */
          minutes_worked: number | null;
          /** NULL when no shift is configured for that weekday. */
          minutes_late: number | null;
          created_at: string;
          updated_at: string;
        };
        Relationships: [];
      };
      /** Migration 30. Tasks joined to the assignee and the assigner. */
      v_task_detail: {
        Row: {
          id: string;
          number: number;
          title: string;
          description: string | null;
          employee_id: string;
          employee_name: string;
          created_by: string | null;
          created_by_name: string | null;
          priority: TaskPriority;
          status: TaskStatus;
          due_at: string | null;
          instructions: string | null;
          completion_notes: string | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
          is_overdue: boolean;
        };
        Relationships: [];
      };
    };

    Functions: {
      branch_timezone: { Args: Record<string, never>; Returns: string };
      /** Migration 17. Completed visits needed before staff may promote. */
      membership_visit_threshold: { Args: Record<string, never>; Returns: number };
      next_booking_reference: { Args: { p_day?: string | null }; Returns: string };
      write_audit: {
        Args: {
          p_actor: string | null;
          p_action: string;
          p_entity: string;
          p_entity_id: string | null;
          p_metadata?: Json;
        };
        Returns: undefined;
      };
      validate_promo: {
        Args: {
          p_code: string;
          p_client_id?: string | null;
          p_guest_phone?: string | null;
          p_service_ids?: string[] | null;
          p_subtotal_cents?: number;
        };
        Returns: {
          valid: boolean;
          reason: string;
          discountCents: number;
          promoCodeId: string | null;
          code?: string;
          type?: PromoType;
          value?: number;
          minSpendCents?: number;
        };
      };
      get_available_slots: {
        Args: {
          p_service_id: string;
          p_date: string;
          p_employee_id?: string | null;
          p_interval_minutes?: number;
          p_timezone?: string | null;
        };
        Returns: { employee_id: string; slot_start: string; slot_end: string }[];
      };
      create_booking: {
        Args: {
          p_service_ids: string[];
          p_employee_id?: string | null;
          p_start_time?: string | null;
          p_client_id?: string | null;
          p_guest?: Json | null;
          p_promo_code?: string | null;
          p_actor?: string | null;
          p_notes?: string | null;
          p_enforce_hours?: boolean;
          /** Migration 18. NULL = auto-assign a room when the service needs one. */
          p_room_id?: string | null;
        };
        Returns: {
          bookingId: string;
          reference: string;
          employeeId: string;
          roomId: string | null;
          roomType: RoomType | null;
          startTime: string;
          endTime: string;
          status: BookingStatus;
          subtotalCents: number;
          discountCents: number;
          memberDiscountCents: number;
          promoDiscountCents: number;
          totalCents: number;
          jti: string;
        };
      };
      // --- migration 18: membership and the desk's room override -------------
      promote_client: {
        Args: { p_client_id: string; p_discount_percent?: number; p_actor?: string | null };
        Returns: {
          clientId: string;
          memberSince: string;
          discountPercent: number;
          completedVisits: number;
          threshold: number;
        };
      };
      /** Migration 33. Audited status change; refuses CANCELLED. */
      set_booking_status: {
        Args: { p_booking_id: string; p_status: string; p_actor?: string | null };
        Returns: { bookingId: string; from: string; to: string };
      };
      // --- migration 34: atomicity for read-then-write sequences ------------
      /** Replace-all. Returns the ids it was given, not the ones it stored. */
      replace_employee_services: {
        Args: { p_employee_id: string; p_service_ids: string[] };
        Returns: string[];
      };
      /** Replace-all. Validates every shift before deleting anything. */
      replace_working_hours: {
        Args: {
          p_employee_id: string;
          p_hours: { weekday: number; start_time: string; end_time: string }[];
        };
        Returns: number;
      };
      /** Refuses with ROOM_STILL_BOOKED while the room has unfinished bookings. */
      deactivate_room: {
        Args: { p_room_id: string; p_actor?: string | null };
        Returns: number;
      };
      /** Get-or-create, so a double-submit cannot raise a unique violation. */
      ensure_client_for_profile: {
        Args: { p_profile_id: string; p_email?: string | null };
        Returns: string;
      };
      /** Migration 35. Employee + qualifications in one statement. */
      create_employee: {
        Args: {
          p_full_name: string;
          p_title?: string | null;
          p_bio?: string | null;
          p_profile_id?: string | null;
          p_is_active?: boolean;
          p_service_ids: string[];
          p_actor?: string | null;
        };
        Returns: string;
      };
      revoke_membership: {
        Args: { p_client_id: string; p_actor?: string | null };
        Returns: { clientId: string; memberSince: null; discountPercent: number };
      };
      set_booking_room: {
        Args: { p_booking_id: string; p_room_id: string | null; p_actor?: string | null };
        Returns: { bookingId: string; roomId: string | null; roomType: RoomType | null };
      };
      /** Migration 39. The desk moving a booking to another stylist. */
      reassign_booking_employee: {
        Args: { p_booking_id: string; p_employee_id: string; p_actor?: string | null };
        Returns: { bookingId: string; employeeId: string };
      };
      cancel_booking: {
        Args: {
          p_booking_id: string;
          p_actor?: string | null;
          p_reason?: string | null;
          p_force?: boolean;
          p_window_hours?: number;
        };
        Returns: { bookingId: string; status: BookingStatus; cancelledAt: string };
      };
      reschedule_booking: {
        Args: { p_booking_id: string; p_new_start: string; p_actor?: string | null };
        Returns: { bookingId: string; startTime: string; endTime: string; jti: string };
      };
      check_in_booking: {
        Args: {
          p_jti: string;
          p_staff_id?: string | null;
          p_actor?: string | null;
          p_window_minutes?: number;
        };
        Returns: {
          bookingId: string;
          reference: string;
          status: BookingStatus;
          checkedInAt: string;
          checkinId: string;
        };
      };
      get_dashboard_summary: {
        Args: { p_from: string; p_to: string; p_timezone?: string | null };
        Returns: Json;
      };
      /** Migration 26. One employee's daily quota progress. Raises EMPLOYEE_NOT_FOUND. */
      get_employee_quota: {
        Args: { p_employee_id: string; p_day?: string | null };
        Returns: Json;
      };
      /** Migration 26. Every active employee's quota progress for one day. */
      get_employee_quotas: {
        Args: { p_day?: string | null };
        Returns: Json;
      };
      get_employee_performance: {
        Args: {
          p_employee_id: string;
          p_from: string;
          p_to: string;
          p_timezone?: string | null;
        };
        Returns: Json;
      };
      /**
       * Migration 36. Attendance totals and per-day breakdown for a filter,
       * aggregated in SQL. Shape is `AttendanceSummary` in the repository.
       */
      attendance_summary: {
        Args: {
          p_employee_id?: string | null;
          p_status?: string | null;
          p_from?: string | null;
          p_to?: string | null;
        };
        Returns: Json;
      };
      /**
       * Migration 37. Closes an open session, stamping time_out on the database
       * clock. Returns the row id, or NULL when nothing was open.
       */
      clock_out_attendance: {
        Args: { p_employee_id: string; p_day: string; p_remarks?: string | null };
        Returns: string | null;
      };
    };

    Enums: {
      user_role: UserRole;
      service_category: ServiceCategory;
      booking_status: BookingStatus;
      promo_type: PromoType;
    };

    CompositeTypes: Record<string, never>;
  };
}

/** Convenience aliases used across the modules. */
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type Views<T extends keyof Database["public"]["Views"]> =
  Database["public"]["Views"][T]["Row"];
