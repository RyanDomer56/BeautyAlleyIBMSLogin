import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  api,
  as,
  createTestClient,
  createTestConcierge,
  createTestStaff,
  deleteTestUsers,
  type TestUser,
} from "../helpers/api";
import { connectDb, db, disconnectDb } from "../helpers/db";

/**
 * Attendance, asserted route by route.
 *
 * Why this file exists: the brief replaces the (non-existent) "CR" screen with
 * a real attendance feature, and the two rules that actually matter are easy to
 * get wrong and impossible to see from the UI:
 *
 *   1. **A day is unique per employee.** Two taps on "Time in" must not open a
 *      second session - the `attendance_one_session_per_day` constraint is the
 *      authority, and the API must turn it into a friendly 409 rather than a
 *      500. The race (two requests in flight) is covered too, because the
 *      service pre-checks *and* catches the constraint.
 *   2. **An employee only ever touches their own record.** The scope is applied
 *      from the token, never from the query string, so an employee who names a
 *      colleague is refused rather than silently redirected.
 *
 * The fixtures are this suite's own employee rows. Linking a test account to a
 * seeded employee would race the roles and QR suites, which link different
 * accounts to the same rows.
 *
 * No slot band is needed: attendance keys on the branch-local day and the
 * fixtures are private, so there is nothing to collide with.
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeAttendance = hasServiceRole ? describe : describe.skip;

describeAttendance("attendance", () => {
  const created: TestUser[] = [];
  let employeeRowId = "";
  let otherEmployeeRowId = "";

  const staff = () => createTestStaff(employeeRowId);
  const concierge = () => createTestConcierge();
  const client = () => createTestClient("Attendance Client");

  /** Clear today's row for the fixture employee so each test starts clean. */
  async function clearAttendance() {
    await db().query(`delete from public.attendance where employee_id = any($1::uuid[])`, [
      [employeeRowId, otherEmployeeRowId],
    ]);
  }

  beforeAll(async () => {
    await connectDb();
    const { rows } = await db().query(
      `insert into public.employees (full_name, title)
       values ('__attendance_test_employee', 'Therapist'), ('__attendance_test_other', 'Therapist')
       returning id`,
    );
    employeeRowId = rows[0].id;
    otherEmployeeRowId = rows[1].id;
  });

  beforeEach(clearAttendance);

  afterAll(async () => {
    // The auth user cascades to its profile, which clears `employees.profile_id`;
    // only then can the rows go, and deleting them cascades the attendance away.
    await deleteTestUsers(created);
    await db().query(`delete from public.employees where id = any($1::uuid[])`, [
      [employeeRowId, otherEmployeeRowId],
    ]);
    await disconnectDb();
  });

  describe("POST /api/v1/attendance/clock-in", () => {
    it("opens a session for the caller and returns it", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          employeeId: employeeRowId,
          status: "PRESENT",
          open: true,
          timeOut: null,
          minutesWorked: null,
          hoursWorked: null,
        }),
      );
      // The day is a plain calendar date in the branch timezone, not an instant.
      expect(res.body.data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The server stamps the time; the client cannot backdate it.
      expect(res.body.data.timeIn).toMatch(/Z$/);
    });

    it("refuses a second time-in on the same day with a 409, not a 500", async () => {
      const me = await staff();
      created.push(me);

      await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});
      const again = await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});

      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("ALREADY_TIMED_IN");
    });

    it("refuses an employee naming someone else rather than clocking them in", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api())
        .post("/api/v1/attendance/clock-in")
        .set(...as(me.token))
        .send({ employeeId: otherEmployeeRowId });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("lets the desk clock in a stylist whose hands are busy", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .post("/api/v1/attendance/clock-in")
        .set(...as(desk.token))
        .send({ employeeId: employeeRowId });

      expect(res.status).toBe(201);
      expect(res.body.data.employeeId).toBe(employeeRowId);
    });

    it("404s an unknown employee instead of inventing a row", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .post("/api/v1/attendance/clock-in")
        .set(...as(desk.token))
        .send({ employeeId: randomUUID() });

      expect(res.status).toBe(404);
    });

    it("refuses a client", async () => {
      const c = await client();
      created.push(c);

      const res = await request(api()).post("/api/v1/attendance/clock-in").set(...as(c.token)).send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("refuses an anonymous caller", async () => {
      const res = await request(api()).post("/api/v1/attendance/clock-in").send({});
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/v1/attendance/clock-out", () => {
    it("closes the session and derives the hours from the stored timestamps", async () => {
      const me = await staff();
      created.push(me);

      await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});
      const res = await request(api()).post("/api/v1/attendance/clock-out").set(...as(me.token)).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.open).toBe(false);
      expect(res.body.data.timeOut).toMatch(/Z$/);
      // Hours are computed from the row, so a fresh session is ~0 rather than null.
      expect(typeof res.body.data.minutesWorked).toBe("number");
      expect(typeof res.body.data.hoursWorked).toBe("number");
    });

    it("refuses a second time-out", async () => {
      const me = await staff();
      created.push(me);

      await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});
      await request(api()).post("/api/v1/attendance/clock-out").set(...as(me.token)).send({});
      const again = await request(api()).post("/api/v1/attendance/clock-out").set(...as(me.token)).send({});

      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("ALREADY_TIMED_OUT");
    });

    it("stamps time_out on the same clock as time_in", async () => {
      const me = await staff();
      created.push(me);

      // time_in is written by the database (`now()` column default) while the
      // API used to write time_out from `new Date()`. The two clocks disagree -
      // by about half a second on this host - so a time-out shortly after a
      // time-in produced time_out < time_in and tripped attendance_time_order,
      // surfacing as an intermittent 400 on a double tap.
      //
      // Pinning time_in to the database's `now()` makes that window certain
      // rather than luck-dependent: with the old code the very next clock-out
      // was behind it.
      await db().query(
        `insert into public.attendance (employee_id, work_date, time_in)
         values ($1, (now() at time zone public.branch_timezone())::date, now())`,
        [employeeRowId],
      );

      const res = await request(api()).post("/api/v1/attendance/clock-out").set(...as(me.token)).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.open).toBe(false);
      expect(new Date(res.body.data.timeOut).getTime()).toBeGreaterThan(
        new Date(res.body.data.timeIn).getTime(),
      );
    });

    it("404s when there is no open session to close", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api()).post("/api/v1/attendance/clock-out").set(...as(me.token)).send({});

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NO_ACTIVE_SESSION");
    });
  });

  describe("GET /api/v1/attendance/me — today's standing", () => {
    it("reports an empty day before the first time-in", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api()).get("/api/v1/attendance/me").set(...as(me.token));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          employeeId: employeeRowId,
          record: null,
          clockedIn: false,
          canClockIn: true,
          canClockOut: false,
        }),
      );
      expect(res.body.data.reason).toEqual(expect.any(String));
    });

    it("flips the flags once the session is open, then closed", async () => {
      const me = await staff();
      created.push(me);

      await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});
      const open = await request(api()).get("/api/v1/attendance/me").set(...as(me.token));
      expect(open.body.data.clockedIn).toBe(true);
      expect(open.body.data.canClockIn).toBe(false);
      expect(open.body.data.canClockOut).toBe(true);
      expect(open.body.data.record.open).toBe(true);

      await request(api()).post("/api/v1/attendance/clock-out").set(...as(me.token)).send({});
      const closed = await request(api()).get("/api/v1/attendance/me").set(...as(me.token));
      expect(closed.body.data.clockedIn).toBe(false);
      expect(closed.body.data.canClockIn).toBe(false);
      expect(closed.body.data.canClockOut).toBe(false);
    });

    /*
     * `/me` must be declared before `/:id`, or Express reads "me" as an id and
     * the uuid validator rejects it with a 400. A 200 here is the only proof the
     * ordering held.
     */
    it("is reached as a literal path, not parsed as an :id", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api()).get("/api/v1/attendance/me").set(...as(me.token));
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });
  });

  describe("GET /api/v1/attendance — history", () => {
    it("pages the caller's own records with a meta envelope", async () => {
      const me = await staff();
      created.push(me);
      await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});

      const res = await request(api()).get("/api/v1/attendance").set(...as(me.token));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toEqual(expect.objectContaining({ page: expect.any(Number) }));
      // Scoped to the caller, even though no filter was asked for.
      for (const row of res.body.data) expect(row.employeeId).toBe(employeeRowId);
    });

    it("answers a page past the end with 400, not 500", async () => {
      const me = await staff();
      created.push(me);

      // PostgREST replies to an unsatisfiable range with HTTP 416 / PGRST103.
      // Unmapped that became a 500 on every paginated endpoint in the app - a
      // stale `?page=9` bookmark, or one click past the end. This asserts the
      // shared mapping, using the endpoint nearest to hand.
      const res = await request(api()).get("/api/v1/attendance?page=99").set(...as(me.token));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PAGE_OUT_OF_RANGE");
    });

    it("ignores an employee's attempt to read a colleague's history", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api())
        .get(`/api/v1/attendance?employeeId=${otherEmployeeRowId}`)
        .set(...as(me.token));

      expect(res.status).toBe(403);
    });

    it("lets the desk filter by employee", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .get(`/api/v1/attendance?employeeId=${employeeRowId}`)
        .set(...as(desk.token));

      expect(res.status).toBe(200);
      for (const row of res.body.data) expect(row.employeeId).toBe(employeeRowId);
    });

    it("rejects a malformed date rather than guessing", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get("/api/v1/attendance?from=13-10-2026").set(...as(desk.token));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("GET /api/v1/attendance/summary", () => {
    it("totals a closed session and buckets it by day", async () => {
      const me = await staff();
      created.push(me);

      await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});
      await request(api()).post("/api/v1/attendance/clock-out").set(...as(me.token)).send({});

      const res = await request(api()).get("/api/v1/attendance/summary").set(...as(me.token));

      expect(res.status).toBe(200);
      expect(res.body.data.totals).toEqual(
        expect.objectContaining({
          present: expect.any(Number),
          completedDays: expect.any(Number),
          totalMinutes: expect.any(Number),
          totalHours: expect.any(Number),
        }),
      );
      expect(res.body.data.totals.present).toBeGreaterThan(0);
      expect(Array.isArray(res.body.data.byDay)).toBe(true);
      expect(res.body.data.byDay[0]).toEqual(
        expect.objectContaining({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), hours: expect.any(Number) }),
      );
    });

    it("arithmetics a fixture row exactly", async () => {
      const me = await staff();
      created.push(me);

      // 09:00 to 12:30 UTC is 210 minutes. The aggregate is in SQL now, so the
      // numbers must match the arithmetic rather than merely be numbers.
      await db().query(
        `insert into public.attendance (employee_id, work_date, time_in, time_out, status)
         values ($1, '2026-05-04', '2026-05-04T09:00:00Z', '2026-05-04T12:30:00Z', 'PRESENT')`,
        [employeeRowId],
      );

      const res = await request(api()).get("/api/v1/attendance/summary").set(...as(me.token));

      expect(res.status).toBe(200);
      expect(res.body.data.totals).toEqual(
        expect.objectContaining({
          records: 1,
          present: 1,
          open: 0,
          completedDays: 1,
          totalMinutes: 210,
          totalHours: 3.5,
          averageHours: 3.5,
        }),
      );
      // No bounds were given, so the response labels itself with what the data
      // actually covers rather than inventing a range.
      expect(res.body.data.from).toBe("2026-05-04");
      expect(res.body.data.to).toBe("2026-05-04");
      expect(res.body.data.byDay).toEqual([
        { day: "2026-05-04", records: 1, minutes: 210, hours: 3.5 },
      ]);
    });

    it("counts past a thousand records instead of silently truncating", async () => {
      const me = await staff();
      created.push(me);

      // 1001 closed one-hour sessions, one per day, in a single statement.
      // The previous implementation read a maximum of 1000 rows and summed them
      // in Node, so this reported 1000 records and 60000 minutes while calling
      // itself a summary. Aggregating in the database has no such ceiling.
      await db().query(
        `insert into public.attendance (employee_id, work_date, time_in, time_out, status)
         select $1,
                '2026-01-01'::date + n,
                (('2026-01-01'::date + n)::text || 'T09:00:00Z')::timestamptz,
                (('2026-01-01'::date + n)::text || 'T10:00:00Z')::timestamptz,
                'PRESENT'
           from generate_series(0, 1000) as n`,
        [employeeRowId],
      );

      const res = await request(api()).get("/api/v1/attendance/summary").set(...as(me.token));

      expect(res.status).toBe(200);
      expect(res.body.data.totals.records).toBe(1001);
      expect(res.body.data.totals.completedDays).toBe(1001);
      expect(res.body.data.totals.totalMinutes).toBe(1001 * 60);
      expect(res.body.data.totals.totalHours).toBe(1001);
      expect(res.body.data.totals.averageHours).toBe(1);
      expect(res.body.data.byDay).toHaveLength(1001);
      expect(res.body.data.from).toBe("2026-01-01");
    });

    it("is reached as a literal path, not parsed as an :id", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api()).get("/api/v1/attendance/summary").set(...as(me.token));
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });

    it("refuses a client", async () => {
      const c = await client();
      created.push(c);

      const res = await request(api()).get("/api/v1/attendance/summary").set(...as(c.token));
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/v1/attendance/:id — one record", () => {
    it("lets the owner read it", async () => {
      const me = await staff();
      created.push(me);
      const clockIn = await request(api()).post("/api/v1/attendance/clock-in").set(...as(me.token)).send({});
      const id = clockIn.body.data.id;

      const res = await request(api()).get(`/api/v1/attendance/${id}`).set(...as(me.token));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
    });

    it("404s a colleague's record — existence itself is not disclosed", async () => {
      const me = await staff();
      created.push(me);

      const { rows } = await db().query(
        `insert into public.attendance (employee_id, work_date, status)
         values ($1, (now() at time zone public.branch_timezone())::date - 1, 'PRESENT')
         returning id`,
        [otherEmployeeRowId],
      );

      const res = await request(api()).get(`/api/v1/attendance/${rows[0].id}`).set(...as(me.token));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ATTENDANCE_NOT_FOUND");
    });

    it("404s an unknown id", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get(`/api/v1/attendance/${randomUUID()}`).set(...as(desk.token));
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/v1/attendance/:id — a correction the desk makes", () => {
    async function openSessionFor(employeeId: string): Promise<string> {
      const { rows } = await db().query(
        `insert into public.attendance (employee_id, work_date, status)
         values ($1, (now() at time zone public.branch_timezone())::date - 2, 'PRESENT')
         returning id`,
        [employeeId],
      );
      return rows[0].id;
    }

    it("refuses an employee — amending hours is not self-service", async () => {
      const me = await staff();
      created.push(me);
      const id = await openSessionFor(employeeRowId);

      const res = await request(api())
        .patch(`/api/v1/attendance/${id}`)
        .set(...as(me.token))
        .send({ status: "LEAVE", remarks: "Approved leave" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("lets the desk file a day of leave", async () => {
      const desk = await concierge();
      created.push(desk);
      const id = await openSessionFor(employeeRowId);

      const res = await request(api())
        .patch(`/api/v1/attendance/${id}`)
        .set(...as(desk.token))
        .send({ status: "LEAVE", remarks: "Approved leave" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("LEAVE");
      expect(res.body.data.remarks).toBe("Approved leave");
    });

    it("rejects a time-out that precedes the time-in", async () => {
      const desk = await concierge();
      created.push(desk);
      const id = await openSessionFor(employeeRowId);

      const res = await request(api())
        .patch(`/api/v1/attendance/${id}`)
        .set(...as(desk.token))
        .send({ timeIn: "2026-01-02T09:00:00Z", timeOut: "2026-01-02T08:00:00Z" });

      expect(res.status).toBe(400);
    });

    it("refuses a client", async () => {
      const c = await client();
      created.push(c);
      const id = await openSessionFor(employeeRowId);

      const res = await request(api())
        .patch(`/api/v1/attendance/${id}`)
        .set(...as(c.token))
        .send({ status: "LEAVE" });

      expect(res.status).toBe(403);
    });
  });
});
