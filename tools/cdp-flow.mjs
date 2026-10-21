/**
 * Drive headless Chrome over CDP: sign in for real, then dump the console DOM.
 *
 * Usage: node cdp-flow.mjs <email> <password> <path> [outFile]
 *
 * Why CDP and not `--dump-dom`: `--dump-dom` renders one URL and exits. It
 * cannot type a password, and it cannot seed localStorage before React boots.
 * This connects to a live page instead, so the login goes through the app's own
 * API and the token lands in the app's own storage key.
 */

const PORT = Number(process.env.CDP_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const APP = "http://127.0.0.1:5173";
const API = "http://127.0.0.1:4000";

const [, , email, password, route = "/app", out = "/tmp/dom-out.html"] = process.argv;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`${BASE}/json`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* chrome not up yet */
    }
    await sleep(250);
  }
  throw new Error("no debuggable page appeared");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;

    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            setTimeout(() => {
              if (pending.has(msgId)) {
                pending.delete(msgId);
                rej(new Error(`timeout: ${method}`));
              }
            }, 30000);
          });
        },
        close: () => ws.close(),
      }),
    );

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message}`));
        else res(msg.result);
      }
    });

    ws.addEventListener("error", reject);
  });
}

async function main() {
  const page = await pickPage();
  const cdp = await connect(page.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // Headless Chrome defaults to 800x600, which puts the sidebar in its
  // mobile drawer state and hides most of the nav. Set a desktop viewport so
  // the DOM we dump is the one a real user sees.
  const width = Number(process.env.VIEWPORT_W || 1600);
  const height = Number(process.env.VIEWPORT_H || 1000);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Land on the app origin first — localStorage is per-origin, so the session
  // has to be written from a page that is already on :5173.
  await cdp.send("Page.navigate", { url: `${APP}/login` });
  await sleep(3000);

  // SKIP_LOGIN reuses the session already in this Chrome profile. Worth having:
  // hosted GoTrue rate-limits sign-ins (~40–48 per window), so a sweep across
  // many pages will otherwise start returning 429 halfway through.
  if (!process.env.SKIP_LOGIN) {
    const login = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const res = await fetch(${JSON.stringify(`${API}/api/v1/auth/login`)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
        });
        const body = await res.json();
        if (!res.ok) return { ok: false, status: res.status, body };
        const session = body.data.session;
        localStorage.setItem("alley.session.v1", JSON.stringify(session));
        return { ok: true, role: body.data.user.role, name: body.data.user.fullName };
      })()`,
    });

    const result = login.result?.value;
    if (!result?.ok) {
      console.error("LOGIN FAILED", JSON.stringify(result));
      cdp.close();
      process.exit(1);
    }
    console.log(`signed in as ${result.role} (${result.name})`);
  }

  await cdp.send("Page.navigate", { url: `${APP}${route}` });
  await sleep(5000);

  if (process.env.SHOT) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.SHOT, Buffer.from(shot.data, "base64"));
    console.log(`wrote ${process.env.SHOT}`);
  }

  const dom = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: "document.documentElement.outerHTML",
  });

  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, dom.result.value, "utf8");
  console.log(`wrote ${out} (${dom.result.value.length} bytes)`);

  cdp.close();
}

main().catch((err) => {
  console.error("ERROR", err.message);
  process.exit(1);
});
