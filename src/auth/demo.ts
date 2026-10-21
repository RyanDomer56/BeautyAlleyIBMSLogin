/**
 * The demo logins, read from the repository-root `demo-accounts.json`.
 *
 * That file is shared with `backend/scripts/demo-accounts.js`, which creates
 * these accounts. Keeping one copy matters: a README that quotes a password
 * the seed does not set is the single most common way a demo breaks, and it is
 * a bug that only shows up in front of an audience.
 *
 * ## Why the values are gated on `import.meta.env.DEV`
 *
 * This module used to export the password unconditionally, and `Login.tsx`
 * rendered it in a quick-fill panel. The effect was that `vite build` wrote the
 * ADMIN password into `dist/assets/index-*.js` - a file served to every visitor
 * of a deployed build. A demo convenience is not worth publishing the owner's
 * credentials in a public artefact.
 *
 * `import.meta.env.DEV` is replaced with the literal `false` at build time, so
 * these ternaries fold to the empty branch and Rollup drops the JSON import
 * entirely (a JSON module has no side effects, so it is safe to elide). A
 * production bundle therefore contains neither the password nor the emails.
 *
 * The dev experience is unchanged: `npm run dev` still fills the form.
 */

import raw from "../../demo-accounts.json";
import type { Role } from "@/lib/api-types";

export interface DemoAccount {
  role: Role;
  email: string;
  fullName: string;
  blurb: string;
  employeeId?: string;
  clientId?: string;
}

const DEV = import.meta.env.DEV;

export const DEMO_PASSWORD: string = DEV ? raw.password : "";
export const DEMO_ACCOUNTS: DemoAccount[] = DEV ? (raw.accounts as DemoAccount[]) : [];
