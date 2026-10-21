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
 * Tasks, asserted route by route.
 *
 * The brief puts task creation on the concierge dashboard and task progress on
 * the employee dashboard, both over **one** set of records. Three rules carry
 * the whole feature, and each is a place where a plausible implementation is
 * silently wrong:
 *
 *   1. **Scope comes from the token, not the query string.** An employee who
 *      drops the `employeeId` filter - or points it at a colleague - must see
 *      only their own work. Reading a colleague's task is a 404, not a 403:
 *      confirming it exists is itself information they should not have.
 *   2. **Only the desk assigns.** An employee moving a task to someone else is
 *      refused by the gate, not by a silent no-op.
 *   3. **The status machine has one authority.** `NEXT_TASK_STATUS` in the
 *      service mirrors the `enforce_task_status_transition` trigger from
 *      migration 30; this suite drives the legal path, the illegal path, and
 *      the reopen path so the mirror cannot drift from the trigger.
 *
 * The fixtures are this suite's own employee rows, so nothing here races the
 * seeded floor or another suite's fixtures.
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeTasks = hasServiceRole ? describe : describe.skip;

describeTasks("tasks", () => {
  const created: TestUser[] = [];
  let employeeRowId = "";
  let otherEmployeeRowId = "";

  const staff = () => createTestStaff(employeeRowId);
  const otherStaff = () => createTestStaff(otherEmployeeRowId);
  const concierge = () => createTestConcierge();
  const client = () => createTestClient("Tasks Client");

  /** Every task this suite made, so each test starts from a clean board. */
  async function clearTasks() {
    await db().query(`delete from public.tasks where employee_id = any($1::uuid[])`, [
      [employeeRowId, otherEmployeeRowId],
    ]);
  }

  beforeAll(async () => {
    await connectDb();
    const { rows } = await db().query(
      `insert into public.employees (full_name, title)
       values ('__tasks_test_employee', 'Therapist'), ('__tasks_test_other', 'Therapist')
       returning id`,
    );
    employeeRowId = rows[0].id;
    otherEmployeeRowId = rows[1].id;
  });

  beforeEach(clearTasks);

  afterAll(async () => {
    await deleteTestUsers(created);
    await db().query(`delete from public.employees where id = any($1::uuid[])`, [
      [employeeRowId, otherEmployeeRowId],
    ]);
    await disconnectDb();
  });

  /** Create a task as the desk and hand back the created DTO. */
  async function assignTask(overrides: Record<string, unknown> = {}) {
    const desk = await concierge();
    created.push(desk);

    const res = await request(api())
      .post("/api/v1/tasks")
      .set(...as(desk.token))
      .send({ title: "Restock the treatment room", employeeId: employeeRowId, ...overrides });

    expect(res.status).toBe(201);
    return res.body.data as Record<string, unknown> & { id: string; reference: string };
  }

  describe("POST /api/v1/tasks — the concierge assigns", () => {
    it("creates a pending task with a human-readable reference", async () => {
      const task = await assignTask({ priority: "HIGH", description: "Towels and oils" });

      expect(task).toEqual(
        expect.objectContaining({
          employeeId: employeeRowId,
          priority: "HIGH",
          status: "PENDING",
          description: "Towels and oils",
          completedAt: null,
          overdue: false,
        }),
      );
      expect(task.reference).toMatch(/^TASK-\d{4,}$/);
      expect(task.nextStatuses).toEqual(["IN_PROGRESS", "COMPLETED", "CANCELLED"]);
      expect(task.assignedBy).toEqual(expect.any(String));
    });

    it("defaults the priority to MEDIUM when none is given", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .post("/api/v1/tasks")
        .set(...as(desk.token))
        .send({ title: "Wipe the mirrors", employeeId: employeeRowId });

      expect(res.status).toBe(201);
      expect(res.body.data.priority).toBe("MEDIUM");
    });

    it("refuses a duplicate open task for the same employee", async () => {
      await assignTask({ title: "Sanitise the tools" });

      const desk = await concierge();
      created.push(desk);
      const res = await request(api())
        .post("/api/v1/tasks")
        .set(...as(desk.token))
        .send({ title: "Sanitise the tools", employeeId: employeeRowId });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DUPLICATE_TASK");
      // The existing task is named, so the UI can jump to it.
      expect(res.body.error.details).toEqual(expect.objectContaining({ reference: expect.any(String) }));
    });

    it("allows the same title for a different employee", async () => {
      await assignTask({ title: "Deep clean" });

      const desk = await concierge();
      created.push(desk);
      const res = await request(api())
        .post("/api/v1/tasks")
        .set(...as(desk.token))
        .send({ title: "Deep clean", employeeId: otherEmployeeRowId });

      expect(res.status).toBe(201);
    });

    it("allows the same title again once the first is no longer open", async () => {
      const first = await assignTask({ title: "Fold the gowns" });

      const desk = await concierge();
      created.push(desk);
      await request(api()).post(`/api/v1/tasks/${first.id}/cancel`).set(...as(desk.token)).send({});

      const res = await request(api())
        .post("/api/v1/tasks")
        .set(...as(desk.token))
        .send({ title: "Fold the gowns", employeeId: employeeRowId });

      expect(res.status).toBe(201);
    });

    it("rejects a task with no title", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .post("/api/v1/tasks")
        .set(...as(desk.token))
        .send({ title: "   ", employeeId: employeeRowId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("404s an unknown assignee rather than creating an orphan", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .post("/api/v1/tasks")
        .set(...as(desk.token))
        .send({ title: "Ghost task", employeeId: randomUUID() });

      expect(res.status).toBe(404);
    });

    it("refuses an employee assigning work — the desk owns the board", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api())
        .post("/api/v1/tasks")
        .set(...as(me.token))
        .send({ title: "Give myself a break", employeeId: employeeRowId });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("refuses a client", async () => {
      const c = await client();
      created.push(c);

      const res = await request(api())
        .post("/api/v1/tasks")
        .set(...as(c.token))
        .send({ title: "Nope", employeeId: employeeRowId });

      expect(res.status).toBe(403);
    });

    it("refuses an anonymous caller", async () => {
      const res = await request(api()).post("/api/v1/tasks").send({ title: "Nope", employeeId: employeeRowId });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/v1/tasks/mine — the employee's own list", () => {
    it("shows only the caller's tasks", async () => {
      await assignTask({ title: "Mine to do" });
      await assignTask({ title: "Someone else's job", employeeId: otherEmployeeRowId });

      const me = await staff();
      created.push(me);
      const res = await request(api()).get("/api/v1/tasks/mine").set(...as(me.token));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].title).toBe("Mine to do");
      for (const row of res.body.data) expect(row.employeeId).toBe(employeeRowId);
    });

    it("filters by status and priority", async () => {
      await assignTask({ title: "Urgent thing", priority: "URGENT" });
      await assignTask({ title: "Low thing", priority: "LOW" });

      const me = await staff();
      created.push(me);

      const urgent = await request(api()).get("/api/v1/tasks/mine?priority=URGENT").set(...as(me.token));
      expect(urgent.status).toBe(200);
      expect(urgent.body.data.every((t: { priority: string }) => t.priority === "URGENT")).toBe(true);

      const pending = await request(api()).get("/api/v1/tasks/mine?status=PENDING").set(...as(me.token));
      expect(pending.body.data.every((t: { status: string }) => t.status === "PENDING")).toBe(true);
    });

    it("refuses an employee pointing the scope at a colleague", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api())
        .get(`/api/v1/tasks/mine?employeeId=${otherEmployeeRowId}`)
        .set(...as(me.token));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("NOT_TASK_OWNER");
    });

    /*
     * `/mine` must precede `/:id`, or Express reads "mine" as an id and the uuid
     * validator 400s it.
     */
    it("is reached as a literal path, not parsed as an :id", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api()).get("/api/v1/tasks/mine").set(...as(me.token));
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });

    it("refuses a client", async () => {
      const c = await client();
      created.push(c);

      const res = await request(api()).get("/api/v1/tasks/mine").set(...as(c.token));
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/v1/tasks — the board, scoped by role", () => {
    it("shows the desk every task", async () => {
      await assignTask({ title: "One" });
      await assignTask({ title: "Two", employeeId: otherEmployeeRowId });

      const desk = await concierge();
      created.push(desk);
      const res = await request(api()).get("/api/v1/tasks?limit=100").set(...as(desk.token));

      expect(res.status).toBe(200);
      const mine = res.body.data.filter(
        (t: { employeeId: string }) => t.employeeId === employeeRowId || t.employeeId === otherEmployeeRowId,
      );
      expect(mine.length).toBe(2);
      expect(res.body.meta).toEqual(expect.objectContaining({ page: expect.any(Number) }));
    });

    it("narrows an employee to their own tasks even without a filter", async () => {
      await assignTask({ title: "Visible to me" });
      await assignTask({ title: "Not mine", employeeId: otherEmployeeRowId });

      const me = await staff();
      created.push(me);
      const res = await request(api()).get("/api/v1/tasks?limit=100").set(...as(me.token));

      expect(res.status).toBe(200);
      for (const row of res.body.data) expect(row.employeeId).toBe(employeeRowId);
    });

    it("refuses an employee asking for a colleague's board", async () => {
      const me = await staff();
      created.push(me);

      const res = await request(api())
        .get(`/api/v1/tasks?employeeId=${otherEmployeeRowId}`)
        .set(...as(me.token));

      expect(res.status).toBe(403);
    });

    it("rejects a malformed filter rather than guessing", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get("/api/v1/tasks?status=DONE").set(...as(desk.token));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("GET /api/v1/tasks/counts — the dashboard tiles", () => {
    it("counts the caller's board", async () => {
      await assignTask({ title: "Counting one" });
      await assignTask({ title: "Counting two", priority: "URGENT" });

      const me = await staff();
      created.push(me);
      const res = await request(api()).get("/api/v1/tasks/counts").set(...as(me.token));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          pending: expect.any(Number),
          inProgress: expect.any(Number),
          overdue: expect.any(Number),
          completed: expect.any(Number),
        }),
      );
      expect(res.body.data.pending).toBe(2);
      expect(res.body.data.completed).toBe(0);
    });

    it("is reached as a literal path, not parsed as an :id", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get("/api/v1/tasks/counts").set(...as(desk.token));
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });

    it("refuses a client", async () => {
      const c = await client();
      created.push(c);

      const res = await request(api()).get("/api/v1/tasks/counts").set(...as(c.token));
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /api/v1/tasks/:id/status — the employee's own progress", () => {
    it("walks PENDING -> IN_PROGRESS -> COMPLETED and records the notes", async () => {
      const task = await assignTask({ title: "Progress me" });

      const me = await staff();
      created.push(me);

      const started = await request(api())
        .patch(`/api/v1/tasks/${task.id}/status`)
        .set(...as(me.token))
        .send({ status: "IN_PROGRESS" });
      expect(started.status).toBe(200);
      expect(started.body.data.status).toBe("IN_PROGRESS");

      const done = await request(api())
        .patch(`/api/v1/tasks/${task.id}/status`)
        .set(...as(me.token))
        .send({ status: "COMPLETED", completionNotes: "Room restocked" });
      expect(done.status).toBe(200);
      expect(done.body.data.status).toBe("COMPLETED");
      expect(done.body.data.completionNotes).toBe("Room restocked");
      // The trigger stamps `completed_at`; the API never sets it by hand.
      expect(done.body.data.completedAt).toMatch(/Z$/);
    });

    it("is idempotent — two taps on Start are not a conflict", async () => {
      const task = await assignTask({ title: "Double tap" });

      const me = await staff();
      created.push(me);

      await request(api()).patch(`/api/v1/tasks/${task.id}/status`).set(...as(me.token)).send({ status: "IN_PROGRESS" });
      const again = await request(api())
        .patch(`/api/v1/tasks/${task.id}/status`)
        .set(...as(me.token))
        .send({ status: "IN_PROGRESS" });

      expect(again.status).toBe(200);
      expect(again.body.data.status).toBe("IN_PROGRESS");
    });

    it("refuses reopening a completed task straight to IN_PROGRESS", async () => {
      const task = await assignTask({ title: "Reopen me" });

      const me = await staff();
      created.push(me);

      await request(api()).patch(`/api/v1/tasks/${task.id}/status`).set(...as(me.token)).send({ status: "COMPLETED" });
      const res = await request(api())
        .patch(`/api/v1/tasks/${task.id}/status`)
        .set(...as(me.token))
        .send({ status: "IN_PROGRESS" });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("TASK_STATUS_TRANSITION");
      // The mirror and the trigger must agree on what IS allowed.
      expect(res.body.error.details).toEqual(expect.objectContaining({ allowed: ["PENDING"] }));
    });

    it("404s a colleague's task — not 403, so existence is not confirmed", async () => {
      const task = await assignTask({ title: "Not yours", employeeId: otherEmployeeRowId });

      const me = await staff();
      created.push(me);
      const res = await request(api())
        .patch(`/api/v1/tasks/${task.id}/status`)
        .set(...as(me.token))
        .send({ status: "IN_PROGRESS" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("TASK_NOT_FOUND");
    });

    it("refuses a client", async () => {
      const task = await assignTask({ title: "Client cannot touch this" });

      const c = await client();
      created.push(c);
      const res = await request(api())
        .patch(`/api/v1/tasks/${task.id}/status`)
        .set(...as(c.token))
        .send({ status: "IN_PROGRESS" });

      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /api/v1/tasks/:id — the desk edits", () => {
    it("reassigns a task to another employee", async () => {
      const task = await assignTask({ title: "Move me" });

      const desk = await concierge();
      created.push(desk);
      const res = await request(api())
        .patch(`/api/v1/tasks/${task.id}`)
        .set(...as(desk.token))
        .send({ employeeId: otherEmployeeRowId });

      expect(res.status).toBe(200);
      expect(res.body.data.employeeId).toBe(otherEmployeeRowId);
    });

    it("clears the completion notes when a task is no longer completed", async () => {
      const task = await assignTask({ title: "Notes lifecycle" });

      const desk = await concierge();
      created.push(desk);

      await request(api())
        .patch(`/api/v1/tasks/${task.id}`)
        .set(...as(desk.token))
        .send({ status: "COMPLETED", completionNotes: "Done and dusted" });

      const reopened = await request(api())
        .patch(`/api/v1/tasks/${task.id}`)
        .set(...as(desk.token))
        .send({ status: "PENDING" });

      expect(reopened.status).toBe(200);
      expect(reopened.body.data.status).toBe("PENDING");
      expect(reopened.body.data.completionNotes).toBeNull();
      expect(reopened.body.data.completedAt).toBeNull();
    });

    it("refuses an employee editing their own task's title", async () => {
      const task = await assignTask({ title: "I want to rename this" });

      const me = await staff();
      created.push(me);
      const res = await request(api())
        .patch(`/api/v1/tasks/${task.id}`)
        .set(...as(me.token))
        .send({ title: "Something else" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("404s an unknown task", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .patch(`/api/v1/tasks/${randomUUID()}`)
        .set(...as(desk.token))
        .send({ priority: "HIGH" });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/tasks/:id/cancel", () => {
    it("cancels a pending task", async () => {
      const task = await assignTask({ title: "Cancel me" });

      const desk = await concierge();
      created.push(desk);
      const res = await request(api()).post(`/api/v1/tasks/${task.id}/cancel`).set(...as(desk.token)).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("CANCELLED");
    });

    it("refuses cancelling a completed task", async () => {
      const task = await assignTask({ title: "Already done" });

      const desk = await concierge();
      created.push(desk);
      await request(api())
        .patch(`/api/v1/tasks/${task.id}`)
        .set(...as(desk.token))
        .send({ status: "COMPLETED" });

      const res = await request(api()).post(`/api/v1/tasks/${task.id}/cancel`).set(...as(desk.token)).send({});

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("TASK_STATUS_TRANSITION");
    });

    it("refuses an employee cancelling their own work", async () => {
      const task = await assignTask({ title: "Not mine to cancel" });

      const me = await staff();
      created.push(me);
      const res = await request(api()).post(`/api/v1/tasks/${task.id}/cancel`).set(...as(me.token)).send({});

      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/v1/tasks/:id", () => {
    it("lets the owner read it", async () => {
      const task = await assignTask({ title: "Readable" });

      const me = await staff();
      created.push(me);
      const res = await request(api()).get(`/api/v1/tasks/${task.id}`).set(...as(me.token));

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(task.id);
      expect(res.body.data.reference).toBe(task.reference);
    });

    it("404s a colleague's task", async () => {
      const task = await assignTask({ title: "Private", employeeId: otherEmployeeRowId });

      const me = await staff();
      created.push(me);
      const res = await request(api()).get(`/api/v1/tasks/${task.id}`).set(...as(me.token));

      expect(res.status).toBe(404);
    });
  });
});
