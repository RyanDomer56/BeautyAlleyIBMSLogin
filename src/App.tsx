/**
 * The route table.
 *
 * Two halves, and the split is the point of the whole exercise:
 *
 *   **Public** — `/`, `/services`, `/book`, `/pass/:id`, `/scan`, `/login`,
 *   `/register`. These render their own shell (`PublicShell` or `AuthLayout`)
 *   because a visitor has no sidebar and no session. Booking is reachable
 *   signed out, which is the guest flow the salon actually runs on.
 *
 *   **Console** — everything under `/app`. One `AuthProvider` decides who you
 *   are, `RequireAuth` bounces an anonymous visitor to `/login` (remembering
 *   where they were headed), and `RequireArea` gates each room against the
 *   permission map. A client who guesses `/app/promos` gets a polite refusal,
 *   not a blank page — and the API would refuse them anyway.
 *
 * The guards are ergonomics; the API and RLS are the boundary. See
 * `src/auth/AuthProvider.tsx`.
 */

import { Navigate, Route, Routes } from "react-router-dom";

import { AuthProvider, homeFor, useAuth } from "@/auth/AuthProvider";
import { RequireArea, RequireAuth } from "@/auth/guards";
import { AppShell } from "@/components/app/AppShell";

import Services from "@/pages/Services";
import Book from "@/pages/Book";
import Pass from "@/pages/Pass";
import Scan from "@/pages/Scan";
import Login from "@/pages/Login";
import Register from "@/pages/Register";

import Overview from "@/pages/Overview";
import Bookings from "@/pages/Bookings";
import Clients from "@/pages/Clients";
import Promos from "@/pages/Promos";
import CheckIn from "@/pages/CheckIn";
import ScanArrivals from "@/pages/ScanArrivals";
import Team from "@/pages/Team";
import Board from "@/pages/Board";
import Tasks from "@/pages/Tasks";
import MyTasks from "@/pages/MyTasks";
import Attendance from "@/pages/Attendance";
import MyBookings from "@/pages/MyBookings";
import NotFound from "@/pages/NotFound";

/**
 * `/app` itself.
 *
 * Overview is the admin and staff landing page, but a client cannot see it —
 * and if this simply rendered `<Overview/>` behind `RequireArea`, a client
 * would get the refusal screen whose "Back to the console" button returns them
 * to `/app` and the refusal again. So the index asks where this role actually
 * belongs and sends them there.
 */
function ConsoleIndex() {
  const { role, can } = useAuth();
  if (role && !can("overview")) return <Navigate to={homeFor(role)} replace />;
  return <Overview />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* ------------------------------------------------- public */}
        {/* The console's own origin opens the console, not the marketing site. */}
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/services" element={<Services />} />
        <Route path="/book" element={<Book />} />
        <Route path="/pass/:id" element={<Pass />} />
        <Route path="/scan" element={<Scan />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        {/* ------------------------------------------------ console */}
        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<ConsoleIndex />} />
          <Route
            path="bookings"
            element={
              <RequireArea area="bookings">
                <Bookings />
              </RequireArea>
            }
          />
          <Route
            path="clients"
            element={
              <RequireArea area="clients">
                <Clients />
              </RequireArea>
            }
          />
          <Route
            path="promos"
            element={
              <RequireArea area="promos">
                <Promos />
              </RequireArea>
            }
          />
          <Route
            path="team"
            element={
              <RequireArea area="employees">
                <Team />
              </RequireArea>
            }
          />
          <Route
            path="check-in"
            element={
              <RequireArea area="check-in">
                <CheckIn />
              </RequireArea>
            }
          />
          <Route
            path="scan-arrivals"
            element={
              <RequireArea area="scan-arrivals">
                <ScanArrivals />
              </RequireArea>
            }
          />
          <Route
            path="tasks"
            element={
              <RequireArea area="tasks">
                <Tasks />
              </RequireArea>
            }
          />
          <Route
            path="my-tasks"
            element={
              <RequireArea area="my-tasks">
                <MyTasks />
              </RequireArea>
            }
          />
          <Route
            path="attendance"
            element={
              <RequireArea area="attendance">
                <Attendance />
              </RequireArea>
            }
          />
          <Route
            path="board"
            element={
              <RequireArea area="board">
                <Board />
              </RequireArea>
            }
          />
          <Route
            path="my-bookings"
            element={
              <RequireArea area="my-bookings">
                <MyBookings />
              </RequireArea>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
