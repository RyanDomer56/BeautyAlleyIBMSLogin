import request from "supertest";
import { createApp } from "../../src/createApp";
import { API_GROUPS } from "../../src/lib/apiIndex";

/**
 * The service index is a hand-written list of the API surface, so it can drift
 * away from the routers. That is the one real risk of not deriving it, and this
 * file is the mitigation.
 *
 * The discriminator is the router-level 404. `notFoundHandler` answers an
 * unmatched request with `No route matches <METHOD> <path>`, which is a
 * different thing from a route that matched and then reported a missing
 * *resource* (`SERVICE_NOT_FOUND`, `BOOKING_NOT_FOUND`). So "is this path
 * mounted?" can be answered without credentials and without caring whether the
 * call succeeds: a 400, a 401, a 403 or a resource-level 404 all prove the
 * route exists. Only `No route matches` proves it does not.
 */

const UUID = "00000000-0000-4000-8000-000000000000";

/**
 * Substitute every `:param` placeholder so param validation lets the route
 * match.
 *
 * Replacing only `:id` missed `:noteId` in
 * `/bookings/:id/notes/:noteId` - the literal string ":noteId" then failed the
 * uuid check and produced a 400. That still proves the route is mounted, so the
 * test would have kept passing, but for the wrong reason: it was measuring
 * validation rather than mounting.
 */
const concrete = (path: string) => path.replace(/:[A-Za-z][A-Za-z0-9]*/g, UUID);

const METHOD = {
  GET: "get",
  POST: "post",
  PATCH: "patch",
  PUT: "put",
  DELETE: "delete",
} as const;

const ENDPOINTS = API_GROUPS.flatMap((group) =>
  group.endpoints.map((endpoint) => ({ ...endpoint, group: group.name }))
);

describe("API index", () => {
  const app = createApp();

  it("is served at the root, with no token", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.data.service).toBe("Beauty Alley Booking API");
    expect(res.body.data.baseUrl).toBe("/api/v1");
  });

  it("is served at the version root too, so /api/v1 is not a dead end", async () => {
    const res = await request(app).get("/api/v1");
    expect(res.status).toBe(200);
    expect(res.body.data.groups.length).toBeGreaterThan(0);
  });

  it("says plainly that there is no HTML page, so a browser visitor is not misled", async () => {
    const res = await request(app).get("/");
    expect(res.body.data.note).toMatch(/no HTML page/i);
  });

  it("reports an endpoint count that matches the list it ships", async () => {
    const res = await request(app).get("/");
    const counted = API_GROUPS.reduce((n, g) => n + g.endpoints.length, 0);
    expect(res.body.data.endpointCount).toBe(counted);
    expect(counted).toBe(ENDPOINTS.length);
  });

  it("lists no duplicate method+path pair", () => {
    const keys = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lists every path under the versioned base, or /health", () => {
    const stray = ENDPOINTS.filter((e) => !e.path.startsWith("/api/v1") && e.path !== "/health");
    expect(stray.map((e) => e.path)).toEqual([]);
  });

  describe("every listed endpoint is actually mounted", () => {
    it.each(ENDPOINTS)("$group: $method $path", async ({ method, path }) => {
      const res = await request(app)[METHOD[method]](concrete(path));
      const message = String(res.body?.error?.message ?? "");
      expect(message).not.toMatch(/^No route matches/);
    });
  });
});
