/**
 * The Beauty Alley — domain data.
 * Deterministic fixtures so the demo reads the same on every render.
 */

export type Tier = "Champagne" | "Emerald" | "Blossom";

export interface Service {
  id: string;
  name: string;
  category: "Hair" | "Skin" | "Nails" | "Body" | "Bridal";
  minutes: number;
  price: number;
  accent: string;
}

export interface Stylist {
  id: string;
  name: string;
  role: string;
  specialties: Service["category"][];
  utilisation: number;
  rating: number;
  clientsThisWeek: number;
  revenueThisWeek: number;
  status: "on-floor" | "with-client" | "break" | "off";
  shift: string;
}

export interface Client {
  id: string;
  name: string;
  tier: Tier;
  phone: string;
  email: string;
  visits: number;
  lifetimeValue: number;
  lastVisit: string;
  nextVisit?: string;
  favourite: string;
  notes: string;
  since: string;
}

export type AppointmentStatus =
  | "confirmed"
  | "checked-in"
  | "in-service"
  | "completed"
  | "no-show";

export interface Appointment {
  id: string;
  time: number; // minutes from midnight
  minutes: number;
  clientId: string;
  stylistId: string;
  serviceId: string;
  status: AppointmentStatus;
  chair: string;
  note?: string;
}

/* ------------------------------------------------------------------ */

export const SERVICES: Service[] = [
  { id: "svc-facial", name: "Signature Facial", category: "Skin", minutes: 60, price: 120, accent: "#2A5D4D" },
  { id: "svc-balayage", name: "Balayage & Gloss", category: "Hair", minutes: 150, price: 260, accent: "#1B4D3E" },
  { id: "svc-cut", name: "Precision Cut & Style", category: "Hair", minutes: 45, price: 75, accent: "#3D7663" },
  { id: "svc-mani", name: "Gel Manicure", category: "Nails", minutes: 45, price: 55, accent: "#5F9382" },
  { id: "svc-massage", name: "Deep Tissue Massage", category: "Body", minutes: 60, price: 110, accent: "#0E2B23" },
  { id: "svc-lash", name: "Lash Extensions", category: "Skin", minutes: 90, price: 150, accent: "#8FB6A7" },
  { id: "svc-bridal", name: "Bridal Hair & Makeup", category: "Bridal", minutes: 120, price: 320, accent: "#C2A167" },
  { id: "svc-brow", name: "Brow Lamination", category: "Skin", minutes: 45, price: 70, accent: "#2A5D4D" },
  { id: "svc-blowout", name: "Blowout & Treatment", category: "Hair", minutes: 45, price: 65, accent: "#3D7663" },
];

export const STYLISTS: Stylist[] = [
  { id: "st-amara", name: "Amara Okafor", role: "Lead Stylist", specialties: ["Hair", "Bridal"], utilisation: 92, rating: 4.9, clientsThisWeek: 34, revenueThisWeek: 4820, status: "with-client", shift: "9:00 – 18:00" },
  { id: "st-priya", name: "Priya Raman", role: "Colour Specialist", specialties: ["Hair"], utilisation: 88, rating: 4.8, clientsThisWeek: 29, revenueThisWeek: 6140, status: "on-floor", shift: "10:00 – 19:00" },
  { id: "st-sofia", name: "Sofia Marchetti", role: "Aesthetician", specialties: ["Skin"], utilisation: 76, rating: 4.9, clientsThisWeek: 31, revenueThisWeek: 3760, status: "with-client", shift: "9:30 – 17:30" },
  { id: "st-nadia", name: "Nadia Haddad", role: "Nail Artist", specialties: ["Nails"], utilisation: 81, rating: 4.7, clientsThisWeek: 38, revenueThisWeek: 2140, status: "break", shift: "9:00 – 17:00" },
  { id: "st-elena", name: "Elena Petrova", role: "Massage Therapist", specialties: ["Body"], utilisation: 69, rating: 5.0, clientsThisWeek: 22, revenueThisWeek: 2480, status: "on-floor", shift: "11:00 – 20:00" },
  { id: "st-chloe", name: "Chloe Bennett", role: "Junior Stylist", specialties: ["Hair", "Nails"], utilisation: 58, rating: 4.6, clientsThisWeek: 19, revenueThisWeek: 1290, status: "off", shift: "Off today" },
];

export const CLIENTS: Client[] = [
  { id: "cl-1", name: "Isabelle Moreau", tier: "Champagne", phone: "+1 (415) 555-0142", email: "isabelle.m@example.com", visits: 38, lifetimeValue: 7240, lastVisit: "2026-09-24", nextVisit: "2026-10-09", favourite: "Balayage & Gloss", notes: "Prefers cool ash tones. Allergic to almond oil.", since: "2021-03-11" },
  { id: "cl-2", name: "Renée Dubois", tier: "Emerald", phone: "+1 (415) 555-0198", email: "renee.d@example.com", visits: 24, lifetimeValue: 3980, lastVisit: "2026-09-30", nextVisit: "2026-10-09", favourite: "Signature Facial", notes: "Sensitive skin — use the fragrance-free line.", since: "2022-01-20" },
  { id: "cl-3", name: "Marcus Lindqvist", tier: "Emerald", phone: "+1 (415) 555-0173", email: "m.lindqvist@example.com", visits: 19, lifetimeValue: 2860, lastVisit: "2026-09-18", nextVisit: "2026-10-09", favourite: "Precision Cut & Style", notes: "Books every 4 weeks, prefers morning slots.", since: "2022-08-04" },
  { id: "cl-4", name: "Amelia Fontaine", tier: "Blossom", phone: "+1 (415) 555-0110", email: "amelia.f@example.com", visits: 6, lifetimeValue: 640, lastVisit: "2026-09-12", nextVisit: "2026-10-10", favourite: "Gel Manicure", notes: "New client — referred by Isabelle M.", since: "2026-05-22" },
  { id: "cl-5", name: "Yuki Tanaka", tier: "Champagne", phone: "+1 (415) 555-0155", email: "yuki.t@example.com", visits: 42, lifetimeValue: 9120, lastVisit: "2026-10-02", nextVisit: "2026-10-16", favourite: "Lash Extensions", notes: "VIP. Always books the private room.", since: "2020-06-15" },
  { id: "cl-6", name: "Grace Abara", tier: "Emerald", phone: "+1 (415) 555-0121", email: "grace.a@example.com", visits: 15, lifetimeValue: 2210, lastVisit: "2026-09-27", nextVisit: "2026-10-11", favourite: "Deep Tissue Massage", notes: "Marathon runner — focuses on calves.", since: "2023-02-09" },
  { id: "cl-7", name: "Camille Rousseau", tier: "Blossom", phone: "+1 (415) 555-0166", email: "camille.r@example.com", visits: 4, lifetimeValue: 380, lastVisit: "2026-09-05", favourite: "Brow Lamination", notes: "First-time brow client. Follow up on retention.", since: "2026-07-18" },
  { id: "cl-8", name: "Daniela Rossi", tier: "Emerald", phone: "+1 (415) 555-0187", email: "d.rossi@example.com", visits: 27, lifetimeValue: 4460, lastVisit: "2026-10-01", nextVisit: "2026-10-09", favourite: "Bridal Hair & Makeup", notes: "Wedding 2027 — trial booked for November.", since: "2021-11-30" },
  { id: "cl-9", name: "Naomi Clarke", tier: "Blossom", phone: "+1 (415) 555-0134", email: "naomi.c@example.com", visits: 2, lifetimeValue: 150, lastVisit: "2026-08-29", favourite: "Blowout & Treatment", notes: "Dormant 6 weeks — send a re-engagement offer.", since: "2026-08-14" },
  { id: "cl-10", name: "Fatima Al-Sayed", tier: "Champagne", phone: "+1 (415) 555-0199", email: "fatima.a@example.com", visits: 33, lifetimeValue: 6780, lastVisit: "2026-09-29", nextVisit: "2026-10-13", favourite: "Signature Facial", notes: "Monthly facial subscription. Never misses.", since: "2020-09-02" },
  { id: "cl-11", name: "Hannah Weber", tier: "Emerald", phone: "+1 (415) 555-0148", email: "hannah.w@example.com", visits: 21, lifetimeValue: 3140, lastVisit: "2026-09-21", nextVisit: "2026-10-12", favourite: "Balayage & Gloss", notes: "Colour every 8 weeks. Loves a scalp massage.", since: "2022-04-27" },
  { id: "cl-12", name: "Leila Nasser", tier: "Blossom", phone: "+1 (415) 555-0176", email: "leila.n@example.com", visits: 5, lifetimeValue: 520, lastVisit: "2026-09-15", nextVisit: "2026-10-14", favourite: "Gel Manicure", notes: "Prefers Nadia. Nail art on special occasions.", since: "2026-04-03" },
];

export const TODAY = "2026-10-09";

export const APPOINTMENTS: Appointment[] = [
  { id: "ap-1", time: 540, minutes: 45, clientId: "cl-3", stylistId: "st-amara", serviceId: "svc-cut", status: "completed", chair: "Chair 1" },
  { id: "ap-2", time: 570, minutes: 60, clientId: "cl-2", stylistId: "st-sofia", serviceId: "svc-facial", status: "completed", chair: "Room A" },
  { id: "ap-3", time: 600, minutes: 150, clientId: "cl-1", stylistId: "st-priya", serviceId: "svc-balayage", status: "in-service", chair: "Colour Bar", note: "Cool ash toner — mixed at 8.1" },
  { id: "ap-4", time: 615, minutes: 45, clientId: "cl-12", stylistId: "st-nadia", serviceId: "svc-mani", status: "in-service", chair: "Nail Studio" },
  { id: "ap-5", time: 660, minutes: 60, clientId: "cl-6", stylistId: "st-elena", serviceId: "svc-massage", status: "checked-in", chair: "Room B" },
  { id: "ap-6", time: 690, minutes: 90, clientId: "cl-5", stylistId: "st-sofia", serviceId: "svc-lash", status: "checked-in", chair: "Room A", note: "VIP — private room" },
  { id: "ap-7", time: 720, minutes: 45, clientId: "cl-7", stylistId: "st-sofia", serviceId: "svc-brow", status: "confirmed", chair: "Room C" },
  { id: "ap-8", time: 750, minutes: 120, clientId: "cl-8", stylistId: "st-amara", serviceId: "svc-bridal", status: "confirmed", chair: "Chair 1", note: "Wedding trial — bring lookbook" },
  { id: "ap-9", time: 780, minutes: 45, clientId: "cl-11", stylistId: "st-priya", serviceId: "svc-blowout", status: "confirmed", chair: "Chair 2" },
  { id: "ap-10", time: 810, minutes: 45, clientId: "cl-4", stylistId: "st-nadia", serviceId: "svc-mani", status: "confirmed", chair: "Nail Studio" },
  { id: "ap-11", time: 840, minutes: 60, clientId: "cl-10", stylistId: "st-sofia", serviceId: "svc-facial", status: "confirmed", chair: "Room A" },
  { id: "ap-12", time: 900, minutes: 60, clientId: "cl-9", stylistId: "st-elena", serviceId: "svc-massage", status: "confirmed", chair: "Room B" },
  { id: "ap-13", time: 930, minutes: 45, clientId: "cl-3", stylistId: "st-chloe", serviceId: "svc-cut", status: "confirmed", chair: "Chair 2" },
  { id: "ap-14", time: 960, minutes: 150, clientId: "cl-1", stylistId: "st-priya", serviceId: "svc-balayage", status: "confirmed", chair: "Colour Bar", note: "Return for gloss top-up" },
];

/* ------------------------------------------------------------------ *
 * Derived + chart data
 * ------------------------------------------------------------------ */

export const WEEKLY_FLOW = [
  { day: "Mon", booked: 24, completed: 23, walkins: 3, revenue: 3120 },
  { day: "Tue", booked: 27, completed: 25, walkins: 4, revenue: 3480 },
  { day: "Wed", booked: 31, completed: 29, walkins: 5, revenue: 4020 },
  { day: "Thu", booked: 34, completed: 33, walkins: 6, revenue: 4640 },
  { day: "Fri", booked: 41, completed: 39, walkins: 8, revenue: 5860 },
  { day: "Sat", booked: 52, completed: 50, walkins: 11, revenue: 7420 },
  { day: "Sun", booked: 18, completed: 18, walkins: 2, revenue: 2210 },
];

export const HOURLY_LOAD = [
  { hour: "9a", chairs: 2, bookings: 2 },
  { hour: "10a", chairs: 3, bookings: 4 },
  { hour: "11a", chairs: 4, bookings: 5 },
  { hour: "12p", chairs: 4, bookings: 4 },
  { hour: "1p", chairs: 3, bookings: 3 },
  { hour: "2p", chairs: 5, bookings: 6 },
  { hour: "3p", chairs: 5, bookings: 6 },
  { hour: "4p", chairs: 6, bookings: 7 },
  { hour: "5p", chairs: 5, bookings: 5 },
  { hour: "6p", chairs: 3, bookings: 3 },
];

export const SERVICE_MIX = [
  { name: "Hair", share: 0.44, value: 18420, fill: "#1B4D3E" },
  { name: "Skin", share: 0.24, value: 10040, fill: "#2A5D4D" },
  { name: "Nails", share: 0.13, value: 5440, fill: "#5F9382" },
  { name: "Body", share: 0.11, value: 4600, fill: "#8FB6A7" },
  { name: "Bridal", share: 0.08, value: 3360, fill: "#C2A167" },
];

export const RETENTION = [
  { month: "Apr", returning: 68, new: 32 },
  { month: "May", returning: 71, new: 29 },
  { month: "Jun", returning: 69, new: 31 },
  { month: "Jul", returning: 74, new: 26 },
  { month: "Aug", returning: 76, new: 24 },
  { month: "Sep", returning: 79, new: 21 },
  { month: "Oct", returning: 82, new: 18 },
];

export interface ActivityEntry {
  id: string;
  person: string;
  action: string;
  time: string;
  tone: "neutral" | "positive" | "attention";
}

export const ACTIVITY: ActivityEntry[] = [
  { id: "ac-1", person: "Priya Raman", action: "started Balayage & Gloss for Isabelle Moreau", time: "10:04", tone: "neutral" },
  { id: "ac-2", person: "Isabelle Moreau", action: "checked in via QR at the front desk", time: "9:58", tone: "positive" },
  { id: "ac-3", person: "Sofia Marchetti", action: "completed Signature Facial for Renée Dubois", time: "9:47", tone: "positive" },
  { id: "ac-4", person: "System", action: "flagged Naomi Clarke as dormant (42 days)", time: "9:30", tone: "attention" },
  { id: "ac-5", person: "Amara Okafor", action: "completed Precision Cut for Marcus Lindqvist", time: "9:22", tone: "positive" },
  { id: "ac-6", person: "Nadia Haddad", action: "started Gel Manicure for Leila Nasser", time: "9:15", tone: "neutral" },
  { id: "ac-7", person: "Front desk", action: "rebooked Yuki Tanaka for 16 Oct, 3:00 PM", time: "9:02", tone: "positive" },
];

export interface Kpi {
  label: string;
  value: string;
  delta: number;
  hint: string;
  goodWhen: "up" | "down";
}

export const KPIS: Kpi[] = [
  { label: "Revenue today", value: "$6,480", delta: 12, hint: "vs. last Friday", goodWhen: "up" },
  { label: "Bookings today", value: "41", delta: 8, hint: "vs. last Friday", goodWhen: "up" },
  { label: "Chair occupancy", value: "87%", delta: 5, hint: "across 6 chairs", goodWhen: "up" },
  { label: "No-show rate", value: "2.4%", delta: -1.6, hint: "vs. last month", goodWhen: "down" },
];

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export const serviceById = (id: string) =>
  SERVICES.find((s) => s.id === id) as Service;
export const stylistById = (id: string) =>
  STYLISTS.find((s) => s.id === id) as Stylist;
export const clientById = (id: string) =>
  CLIENTS.find((c) => c.id === id) as Client;

export const TIER_META: Record<
  Tier,
  { variant: "champagne" | "success" | "secondary"; blurb: string }
> = {
  Champagne: { variant: "champagne", blurb: "VIP · 30+ visits" },
  Emerald: { variant: "success", blurb: "Established" },
  Blossom: { variant: "secondary", blurb: "New & growing" },
};
