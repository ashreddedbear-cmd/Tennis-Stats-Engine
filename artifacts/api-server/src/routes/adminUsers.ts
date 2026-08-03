/**
 * Admin-only: Users & Subscriptions management.
 * All routes require requireAdmin middleware.
 * Sensitive actions are written to admin_audit_log.
 */
import { Router, type IRouter } from "express";
import { requireAdmin } from "../lib/adminAuth";
import { pool, db, adminAuditLogTable, adminUserNotesTable, paymentsAccountTable } from "@workspace/db";
import { clerkClient } from "@clerk/express";
import { eq, sql, desc, asc, and, or, ilike, gte, lte, inArray } from "drizzle-orm";

const router: IRouter = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function clerkIdFromAccountKey(accountKey: string): string | null {
  return accountKey.startsWith("user_") ? accountKey.slice(5) : null;
}

async function fetchClerkUsers(clerkIds: string[]): Promise<Map<string, { name: string; email: string; createdAt: number | null; lastSignInAt: number | null; lastActiveAt: number | null }>> {
  const map = new Map<string, { name: string; email: string; createdAt: number | null; lastSignInAt: number | null; lastActiveAt: number | null }>();
  if (clerkIds.length === 0) return map;
  try {
    // Fetch in batches of 100 (Clerk limit)
    for (let i = 0; i < clerkIds.length; i += 100) {
      const batch = clerkIds.slice(i, i + 100);
      const response = await clerkClient.users.getUserList({ userId: batch, limit: 100 });
      const users = Array.isArray(response) ? response : (response as { data?: unknown[] }).data ?? [];
      for (const u of users as Array<{ id: string; firstName?: string | null; lastName?: string | null; emailAddresses?: Array<{ emailAddress: string }>; createdAt?: number | null; lastSignInAt?: number | null; lastActiveAt?: number | null }>) {
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "—";
        const email = u.emailAddresses?.[0]?.emailAddress ?? "—";
        map.set(u.id, { name, email, createdAt: u.createdAt ?? null, lastSignInAt: u.lastSignInAt ?? null, lastActiveAt: u.lastActiveAt ?? null });
      }
    }
  } catch {
    // Clerk unavailable — return what we have (names will show as blank)
  }
  return map;
}

async function appendAuditLog(targetClerkUserId: string, targetEmail: string | null, action: string, previousValue: unknown, newValue: unknown, reason?: string) {
  await db.insert(adminAuditLogTable).values({
    targetClerkUserId,
    targetEmail,
    action,
    previousValue,
    newValue,
    reason: reason ?? null,
  });
}

type StripeMethod = "GET" | "POST" | "DELETE";
async function stripeRequest<T>(method: StripeMethod, path: string, form?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("Stripe secret key not configured");
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  const init: RequestInit = { method, headers };
  if (form) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (v !== null && v !== undefined) body.set(k, String(v));
    }
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = body.toString();
  }
  const res = await fetch(`https://api.stripe.com${path}`, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? `Stripe error ${res.status}`);
  return data as T;
}

// ── GET /admin/users/stats ────────────────────────────────────────────────────

router.get("/admin/users/stats", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const result = await pool.query<{
      total: string; free: string; pro: string; elite: string; team: string;
      monthly: string; annual: string; trialing: string; paying: string;
      past_due: string; failed: string; scheduled_cancel: string;
      active_accounts: string;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%') AS total,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND (plan_key IS NULL OR plan_key = 'free')) AS free,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND plan_key IN ('pro', 'pro_annual')) AS pro,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND plan_key IN ('elite', 'elite_annual')) AS elite,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND plan_key = 'team') AS team,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND plan_key IN ('pro', 'elite')) AS monthly,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND plan_key IN ('pro_annual', 'elite_annual')) AS annual,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND subscription_status = 'trialing') AS trialing,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND subscription_status = 'active') AS paying,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND subscription_status = 'past_due') AS past_due,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND failed_payment_count > 0) AS failed,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND cancel_at_period_end = TRUE) AS scheduled_cancel,
        COUNT(*) FILTER (WHERE account_key LIKE 'user_%' AND subscription_status NOT IN ('canceled', 'incomplete_expired')) AS active_accounts
      FROM payments_accounts
    `);

    const r = result.rows[0];

    // MRR approximation from Stripe price amounts
    const mrr = await pool.query<{ mrr: string }>(`
      SELECT COALESCE(SUM(
        CASE
          WHEN plan_key IN ('pro', 'elite') THEN last_payment_amount
          WHEN plan_key IN ('pro_annual', 'elite_annual') THEN ROUND(last_payment_amount / 12.0)
          ELSE 0
        END
      ), 0) AS mrr
      FROM payments_accounts
      WHERE account_key LIKE 'user_%'
        AND subscription_status = 'active'
        AND last_payment_amount IS NOT NULL
    `);

    const arr = await pool.query<{ arr: string }>(`
      SELECT COALESCE(SUM(last_payment_amount), 0) AS arr
      FROM payments_accounts
      WHERE account_key LIKE 'user_%'
        AND plan_key IN ('pro_annual', 'elite_annual')
        AND subscription_status = 'active'
        AND last_payment_amount IS NOT NULL
    `);

    res.json({
      total: parseInt(r.total),
      free: parseInt(r.free),
      pro: parseInt(r.pro),
      elite: parseInt(r.elite),
      team: parseInt(r.team),
      monthly: parseInt(r.monthly),
      annual: parseInt(r.annual),
      trialing: parseInt(r.trialing),
      paying: parseInt(r.paying),
      pastDue: parseInt(r.past_due),
      failedPayments: parseInt(r.failed),
      scheduledCancellations: parseInt(r.scheduled_cancel),
      activeAccounts: parseInt(r.active_accounts),
      mrr: parseInt(mrr.rows[0].mrr) / 100,
      arr: parseInt(arr.rows[0].arr) / 100,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to load stats" });
  }
});

// ── GET /admin/users ──────────────────────────────────────────────────────────

router.get("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  try {
    const {
      search = "",
      plan = "",
      status = "",
      billing = "",
      page = "1",
      limit = "50",
      sort = "created_at",
      order = "desc",
      signupFrom = "",
      signupTo = "",
      renewalFrom = "",
      renewalTo = "",
      failedPayments = "",
      scheduledCancel = "",
      trialing = "",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = ["pa.account_key LIKE 'user_%'"];
    const params: unknown[] = [];
    let pi = 1;

    if (plan) {
      const planMap: Record<string, string[]> = {
        free: ["free", null as unknown as string],
        pro: ["pro", "pro_annual"],
        elite: ["elite", "elite_annual"],
        team: ["team"],
      };
      const keys = planMap[plan] ?? [];
      if (keys.includes(null as unknown as string)) {
        conditions.push(`(pa.plan_key IS NULL OR pa.plan_key = 'free')`);
      } else {
        params.push(keys);
        conditions.push(`pa.plan_key = ANY($${pi++})`);
      }
    }

    if (status) {
      if (status === "active") conditions.push(`aun.account_status = 'active' OR aun.account_status IS NULL`);
      else if (status === "suspended") conditions.push(`aun.account_status = 'suspended'`);
      else if (status === "banned") conditions.push(`aun.account_status = 'banned'`);
      else if (status === "past_due") conditions.push(`pa.subscription_status = 'past_due'`);
      else if (status === "canceled") conditions.push(`pa.subscription_status = 'canceled'`);
      else if (status === "trialing") conditions.push(`pa.subscription_status = 'trialing'`);
    }

    if (billing === "monthly") conditions.push(`pa.plan_key IN ('pro', 'elite')`);
    if (billing === "annual") conditions.push(`pa.plan_key IN ('pro_annual', 'elite_annual')`);
    if (failedPayments === "1") conditions.push(`pa.failed_payment_count > 0`);
    if (scheduledCancel === "1") conditions.push(`pa.cancel_at_period_end = TRUE`);
    if (trialing === "1") conditions.push(`pa.subscription_status = 'trialing'`);

    if (signupFrom) { params.push(signupFrom); conditions.push(`pa.created_at >= $${pi++}`); }
    if (signupTo) { params.push(signupTo); conditions.push(`pa.created_at <= $${pi++}`); }
    if (renewalFrom) { params.push(renewalFrom); conditions.push(`pa.current_period_end_at >= $${pi++}`); }
    if (renewalTo) { params.push(renewalTo); conditions.push(`pa.current_period_end_at <= $${pi++}`); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const allowedSorts: Record<string, string> = {
      created_at: "pa.created_at",
      plan_key: "pa.plan_key",
      subscription_status: "pa.subscription_status",
      current_period_end_at: "pa.current_period_end_at",
      last_payment_at: "pa.last_payment_at",
      failed_payment_count: "pa.failed_payment_count",
    };
    const sortCol = allowedSorts[sort] ?? "pa.created_at";
    const sortDir = order === "asc" ? "ASC" : "DESC";

    const baseQuery = `
      FROM payments_accounts pa
      LEFT JOIN admin_user_notes aun ON aun.clerk_user_id = SUBSTRING(pa.account_key, 6)
      LEFT JOIN (
        SELECT clerk_user_id, COUNT(*) AS total_predictions,
          COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS predictions_today
        FROM predictions GROUP BY clerk_user_id
      ) pred ON pred.clerk_user_id = SUBSTRING(pa.account_key, 6)
      LEFT JOIN (
        SELECT clerk_user_id, COUNT(*) FILTER (WHERE status = 'open') AS open_tickets
        FROM support_tickets GROUP BY clerk_user_id
      ) st ON st.clerk_user_id = SUBSTRING(pa.account_key, 6)
      ${where}
    `;

    const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count ${baseQuery}`, params);
    const total = parseInt(countResult.rows[0].count);

    let dataQuery = `
      SELECT
        pa.*,
        SUBSTRING(pa.account_key, 6) AS clerk_user_id,
        COALESCE(aun.note, '') AS admin_note,
        COALESCE(aun.account_status, 'active') AS account_status,
        aun.complimentary_plan,
        aun.complimentary_expires_at,
        COALESCE(pred.total_predictions, 0) AS total_predictions,
        COALESCE(pred.predictions_today, 0) AS predictions_today,
        COALESCE(st.open_tickets, 0) AS open_tickets
      ${baseQuery}
      ORDER BY ${sortCol} ${sortDir} NULLS LAST
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const rows = await pool.query(dataQuery, params);
    const clerkIds = rows.rows.map((r: { clerk_user_id: string }) => r.clerk_user_id).filter(Boolean);

    let clerkMap = new Map<string, { name: string; email: string; createdAt: number | null; lastSignInAt: number | null; lastActiveAt: number | null }>();
    if (search) {
      // If searching by name/email, fetch all then filter
      clerkMap = await fetchClerkUsers(clerkIds);
    } else {
      clerkMap = await fetchClerkUsers(clerkIds);
    }

    const users = rows.rows.map((row: Record<string, unknown>) => {
      const cid = row.clerk_user_id as string;
      const clerk = clerkMap.get(cid) ?? { name: "—", email: "—", createdAt: null, lastSignInAt: null, lastActiveAt: null };
      return { ...row, clerkName: clerk.name, clerkEmail: clerk.email, clerkCreatedAt: clerk.createdAt, lastSignInAt: clerk.lastSignInAt, lastActiveAt: clerk.lastActiveAt };
    }).filter((u: { clerkName: string; clerkEmail: string }) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return u.clerkName.toLowerCase().includes(q) || u.clerkEmail.toLowerCase().includes(q);
    });

    res.json({ users, total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to list users" });
  }
});

// ── GET /admin/users/export.csv ────────────────────────────────────────────────

router.get("/admin/users/export.csv", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const rows = await pool.query(`
      SELECT
        SUBSTRING(pa.account_key, 6) AS clerk_user_id,
        pa.stripe_customer_id, pa.stripe_subscription_id,
        pa.plan_key, pa.subscription_status,
        pa.current_period_start_at, pa.current_period_end_at,
        pa.trial_start_at, pa.trial_end_at,
        pa.cancel_at_period_end, pa.canceled_at,
        pa.failed_payment_count, pa.last_payment_at, pa.last_payment_amount, pa.last_payment_status,
        pa.created_at,
        COALESCE(aun.account_status, 'active') AS account_status,
        COALESCE(pred.total_predictions, 0) AS total_predictions
      FROM payments_accounts pa
      LEFT JOIN admin_user_notes aun ON aun.clerk_user_id = SUBSTRING(pa.account_key, 6)
      LEFT JOIN (SELECT clerk_user_id, COUNT(*) AS total_predictions FROM predictions GROUP BY clerk_user_id) pred
        ON pred.clerk_user_id = SUBSTRING(pa.account_key, 6)
      WHERE pa.account_key LIKE 'user_%'
      ORDER BY pa.created_at DESC
    `);

    const clerkIds = rows.rows.map((r: { clerk_user_id: string }) => r.clerk_user_id).filter(Boolean);
    const clerkMap = await fetchClerkUsers(clerkIds);

    const headers = ["Name","Email","Clerk User ID","Stripe Customer ID","Stripe Subscription ID","Plan","Status","Account Status","Billing Cycle","Signup Date","Trial Start","Trial End","Period Start","Period End","Cancel At Period End","Canceled At","Failed Payments","Last Payment Date","Last Payment Amount","Last Payment Status","Total Predictions"];
    const csvRows = [headers.join(",")];

    for (const r of rows.rows as Record<string, unknown>[]) {
      const cid = r.clerk_user_id as string;
      const clerk = clerkMap.get(cid) ?? { name: "—", email: "—", createdAt: null, lastSignInAt: null, lastActiveAt: null };
      const plan = r.plan_key as string | null;
      const cycle = plan?.includes("annual") ? "Annual" : plan && plan !== "free" ? "Monthly" : "Free";
      const amt = r.last_payment_amount ? `$${((r.last_payment_amount as number) / 100).toFixed(2)}` : "";
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      csvRows.push([
        esc(clerk.name), esc(clerk.email), esc(cid),
        esc(r.stripe_customer_id), esc(r.stripe_subscription_id),
        esc(plan ?? "free"), esc(r.subscription_status), esc(r.account_status),
        esc(cycle),
        esc(r.created_at ? new Date(r.created_at as string).toISOString() : ""),
        esc(r.trial_start_at ? new Date(r.trial_start_at as string).toISOString() : ""),
        esc(r.trial_end_at ? new Date(r.trial_end_at as string).toISOString() : ""),
        esc(r.current_period_start_at ? new Date(r.current_period_start_at as string).toISOString() : ""),
        esc(r.current_period_end_at ? new Date(r.current_period_end_at as string).toISOString() : ""),
        esc(r.cancel_at_period_end ? "Yes" : "No"),
        esc(r.canceled_at ? new Date(r.canceled_at as string).toISOString() : ""),
        esc(r.failed_payment_count),
        esc(r.last_payment_at ? new Date(r.last_payment_at as string).toISOString() : ""),
        esc(amt), esc(r.last_payment_status), esc(r.total_predictions),
      ].join(","));
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="users-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csvRows.join("\n"));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Export failed" });
  }
});

// ── GET /admin/users/:userId ───────────────────────────────────────────────────

router.get("/admin/users/:userId", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  try {
    const accountKey = `user_${userId}`;
    const [account] = await db.select().from(paymentsAccountTable).where(eq(paymentsAccountTable.accountKey, accountKey)).limit(1);
    const [notes] = await db.select().from(adminUserNotesTable).where(eq(adminUserNotesTable.clerkUserId, userId)).limit(1);

    // Prediction stats
    const predStats = await pool.query<{ total: string; today: string }>(`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today
      FROM predictions WHERE clerk_user_id = $1
    `, [userId]);

    // Support tickets
    const tickets = await pool.query(`
      SELECT id, subject, status, priority, created_at, updated_at
      FROM support_tickets WHERE clerk_user_id = $1 ORDER BY created_at DESC LIMIT 20
    `, [userId]);

    // Audit log
    const auditLog = await pool.query(`
      SELECT * FROM admin_audit_log WHERE target_clerk_user_id = $1 ORDER BY created_at DESC LIMIT 50
    `, [userId]);

    // Webhook events for this user (payment history)
    const webhookEvents = account?.stripeSubscriptionId ? await pool.query(`
      SELECT event_type, received_at, payload
      FROM webhook_events
      WHERE stripe_subscription_id = $1
      ORDER BY received_at DESC LIMIT 30
    `, [account.stripeSubscriptionId]) : { rows: [] };

    // Clerk user detail
    const clerkMap = await fetchClerkUsers([userId]);
    const clerk = clerkMap.get(userId) ?? { name: "—", email: "—", createdAt: null, lastSignInAt: null, lastActiveAt: null };

    res.json({
      clerkUserId: userId,
      clerkName: clerk.name,
      clerkEmail: clerk.email,
      clerkCreatedAt: clerk.createdAt,
      lastSignInAt: clerk.lastSignInAt,
      lastActiveAt: clerk.lastActiveAt,
      account: account ?? null,
      notes: notes ?? null,
      totalPredictions: parseInt(predStats.rows[0]?.total ?? "0"),
      predictionsToday: parseInt(predStats.rows[0]?.today ?? "0"),
      supportTickets: tickets.rows,
      auditLog: auditLog.rows,
      paymentEvents: webhookEvents.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Failed to load user" });
  }
});

// ── POST /admin/users/:userId/status ──────────────────────────────────────────

router.post("/admin/users/:userId/status", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { status, reason } = req.body as { status: "active" | "suspended" | "banned"; reason?: string };
  if (!["active", "suspended", "banned"].includes(status)) { res.status(400).json({ error: "Invalid status" }); return; }
  try {
    const existing = await db.select().from(adminUserNotesTable).where(eq(adminUserNotesTable.clerkUserId, userId)).limit(1);
    const prev = existing[0]?.accountStatus ?? "active";
    await db.insert(adminUserNotesTable).values({ clerkUserId: userId, accountStatus: status, note: existing[0]?.note ?? "", updatedAt: new Date() })
      .onConflictDoUpdate({ target: adminUserNotesTable.clerkUserId, set: { accountStatus: status, updatedAt: new Date() } });
    const clerkMap = await fetchClerkUsers([userId]);
    const email = clerkMap.get(userId)?.email ?? null;
    await appendAuditLog(userId, email, status === "banned" ? "ban" : status === "suspended" ? "suspend" : "unsuspend", { accountStatus: prev }, { accountStatus: status }, reason);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

// ── POST /admin/users/:userId/notes ───────────────────────────────────────────

router.post("/admin/users/:userId/notes", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { note } = req.body as { note: string };
  try {
    await db.insert(adminUserNotesTable).values({ clerkUserId: userId, note, updatedAt: new Date() })
      .onConflictDoUpdate({ target: adminUserNotesTable.clerkUserId, set: { note, updatedAt: new Date() } });
    const clerkMap = await fetchClerkUsers([userId]);
    await appendAuditLog(userId, clerkMap.get(userId)?.email ?? null, "note_updated", null, { note });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

// ── POST /admin/users/:userId/complimentary ───────────────────────────────────

router.post("/admin/users/:userId/complimentary", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { plan, expiresAt, reason } = req.body as { plan: "pro" | "elite" | null; expiresAt?: string; reason?: string };
  try {
    const existing = await db.select().from(adminUserNotesTable).where(eq(adminUserNotesTable.clerkUserId, userId)).limit(1);
    const prev = { complimentaryPlan: existing[0]?.complimentaryPlan ?? null };
    await db.insert(adminUserNotesTable).values({
      clerkUserId: userId,
      note: existing[0]?.note ?? "",
      complimentaryPlan: plan,
      complimentaryExpiresAt: expiresAt ? new Date(expiresAt) : null,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: adminUserNotesTable.clerkUserId,
      set: { complimentaryPlan: plan, complimentaryExpiresAt: expiresAt ? new Date(expiresAt) : null, updatedAt: new Date() },
    });
    const clerkMap = await fetchClerkUsers([userId]);
    await appendAuditLog(userId, clerkMap.get(userId)?.email ?? null, "complimentary_access", prev, { complimentaryPlan: plan, expiresAt }, reason);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

// ── POST /admin/users/:userId/cancel ──────────────────────────────────────────

router.post("/admin/users/:userId/cancel", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { immediate = false, reason } = req.body as { immediate?: boolean; reason?: string };
  try {
    const [account] = await db.select().from(paymentsAccountTable).where(eq(paymentsAccountTable.accountKey, `user_${userId}`)).limit(1);
    if (!account?.stripeSubscriptionId) { res.status(400).json({ error: "No active subscription" }); return; }
    if (immediate) {
      await stripeRequest("DELETE", `/v1/subscriptions/${account.stripeSubscriptionId}`);
    } else {
      await stripeRequest("POST", `/v1/subscriptions/${account.stripeSubscriptionId}`, { cancel_at_period_end: true });
    }
    const clerkMap = await fetchClerkUsers([userId]);
    await appendAuditLog(userId, clerkMap.get(userId)?.email ?? null, "cancel_subscription", { subscriptionId: account.stripeSubscriptionId }, { immediate }, reason);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

// ── POST /admin/users/:userId/restore ─────────────────────────────────────────

router.post("/admin/users/:userId/restore", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { reason } = req.body as { reason?: string };
  try {
    const [account] = await db.select().from(paymentsAccountTable).where(eq(paymentsAccountTable.accountKey, `user_${userId}`)).limit(1);
    if (!account?.stripeSubscriptionId) { res.status(400).json({ error: "No subscription" }); return; }
    await stripeRequest("POST", `/v1/subscriptions/${account.stripeSubscriptionId}`, { cancel_at_period_end: false });
    const clerkMap = await fetchClerkUsers([userId]);
    await appendAuditLog(userId, clerkMap.get(userId)?.email ?? null, "restore_cancellation", { cancelAtPeriodEnd: true }, { cancelAtPeriodEnd: false }, reason);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

// ── POST /admin/users/:userId/extend-trial ────────────────────────────────────

router.post("/admin/users/:userId/extend-trial", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { trialEndDate, reason } = req.body as { trialEndDate: string; reason?: string };
  try {
    const [account] = await db.select().from(paymentsAccountTable).where(eq(paymentsAccountTable.accountKey, `user_${userId}`)).limit(1);
    if (!account?.stripeSubscriptionId) { res.status(400).json({ error: "No subscription" }); return; }
    const trialEnd = Math.floor(new Date(trialEndDate).getTime() / 1000);
    await stripeRequest("POST", `/v1/subscriptions/${account.stripeSubscriptionId}`, { trial_end: trialEnd });
    const clerkMap = await fetchClerkUsers([userId]);
    await appendAuditLog(userId, clerkMap.get(userId)?.email ?? null, "extend_trial", { prevTrialEnd: account.trialEndAt }, { trialEnd: trialEndDate }, reason);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

// ── POST /admin/users/:userId/refund ──────────────────────────────────────────

router.post("/admin/users/:userId/refund", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { chargeId, amount, reason } = req.body as { chargeId: string; amount?: number; reason?: string };
  if (!chargeId) { res.status(400).json({ error: "chargeId required" }); return; }
  try {
    const form: Record<string, string | number> = { charge: chargeId };
    if (amount) form.amount = amount;
    const refund = await stripeRequest<{ id: string; amount: number; status: string }>("POST", "/v1/refunds", form);
    const clerkMap = await fetchClerkUsers([userId]);
    await appendAuditLog(userId, clerkMap.get(userId)?.email ?? null, "refund", { chargeId }, { refundId: refund.id, amount: refund.amount, status: refund.status }, reason);
    res.json({ ok: true, refund });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

// ── POST /admin/users/:userId/reset-predictions ───────────────────────────────

router.post("/admin/users/:userId/reset-predictions", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  const { reason } = req.body as { reason?: string };
  try {
    // Delete today's predictions for this user (soft reset — clears daily count)
    await pool.query(
      `DELETE FROM predictions WHERE clerk_user_id = $1 AND created_at::date = CURRENT_DATE`,
      [userId]
    );
    const clerkMap = await fetchClerkUsers([userId]);
    await appendAuditLog(userId, clerkMap.get(userId)?.email ?? null, "reset_predictions", null, { resetDate: new Date().toISOString().slice(0, 10) }, reason);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

// ── GET /admin/users/:userId/audit-log ────────────────────────────────────────

router.get("/admin/users/:userId/audit-log", requireAdmin, async (req, res): Promise<void> => {
  const userId = String(req.params.userId);
  try {
    const rows = await pool.query(`SELECT * FROM admin_audit_log WHERE target_clerk_user_id = $1 ORDER BY created_at DESC`, [userId]);
    res.json({ entries: rows.rows });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : "Failed" }); }
});

export default router;
