import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, supportTicketsTable, supportMessagesTable, supportAttachmentsTable } from "@workspace/db";
import { eq, desc, and, or, ilike, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { requireClerkUser } from "../middlewares/requireClerkUser";
import { requireAdmin, isAdminSessionCookieValid } from "../lib/adminAuth";
import pino from "pino";

const logger = pino({ name: "support-routes" });
const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function ticketNumber(id: number): string {
  return `TM-${String(id).padStart(6, "0")}`;
}

function isAdmin(req: { signedCookies?: Record<string, unknown> }): boolean {
  return isAdminSessionCookieValid(req.signedCookies ?? {});
}

// ── Validation Schemas ────────────────────────────────────────────────────────

const VALID_CATEGORIES = [
  "Technical Problem",
  "Prediction Issue",
  "Subscription or Billing",
  "Account Problem",
  "Feature Request",
  "Recommendation",
  "Data Problem",
  "Other",
] as const;

const VALID_STATUSES = ["open", "waiting_for_support", "waiting_for_user", "resolved", "closed"] as const;
const VALID_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

const AttachmentSchema = z.object({
  fileName: z.string().max(255),
  fileType: z.string().max(100),
  fileSizeBytes: z.number().int().max(10 * 1024 * 1024), // 10MB max
  dataUri: z.string().max(2 * 1024 * 1024), // 2MB base64 string max (≈1.5MB file)
});

const CreateTicketSchema = z.object({
  category: z.enum(VALID_CATEGORIES),
  subject: z.string().min(1).max(120),
  message: z.string().min(10).max(5000),
  sourceRoute: z.string().max(500).optional(),
  appVersion: z.string().max(50).optional(),
  deviceInfo: z.string().max(500).optional(),
  userName: z.string().max(200).optional(),
  userEmail: z.string().max(300).optional(),
  subscriptionPlan: z.string().max(50).optional(),
  isTrialing: z.string().max(10).optional(),
  accountRole: z.string().max(50).optional(),
  attachments: z.array(AttachmentSchema).max(5).optional(),
});

const AddMessageSchema = z.object({
  message: z.string().min(1).max(5000),
  attachments: z.array(AttachmentSchema).max(5).optional(),
});

const UpdateTicketSchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
});

const AdminUpdateTicketSchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  priority: z.enum(VALID_PRIORITIES).optional(),
  assignedAdminId: z.string().max(200).nullable().optional(),
});

const AdminAddMessageSchema = z.object({
  message: z.string().min(1).max(5000),
  isInternalNote: z.boolean().optional().default(false),
  attachments: z.array(AttachmentSchema).max(5).optional(),
});

// ── Shared helpers ────────────────────────────────────────────────────────────

async function getTicketWithMessages(ticketId: number) {
  const [ticket] = await db
    .select()
    .from(supportTicketsTable)
    .where(eq(supportTicketsTable.id, ticketId))
    .limit(1);
  if (!ticket) return null;

  const messages = await db
    .select()
    .from(supportMessagesTable)
    .where(and(
      eq(supportMessagesTable.ticketId, ticketId),
      eq(supportMessagesTable.isInternalNote, false), // users never see internal notes
    ))
    .orderBy(supportMessagesTable.createdAt);

  const attachments = await db
    .select()
    .from(supportAttachmentsTable)
    .where(eq(supportAttachmentsTable.ticketId, ticketId))
    .orderBy(supportAttachmentsTable.createdAt);

  return { ticket, messages, attachments };
}

async function getAdminTicketWithMessages(ticketId: number) {
  const [ticket] = await db
    .select()
    .from(supportTicketsTable)
    .where(eq(supportTicketsTable.id, ticketId))
    .limit(1);
  if (!ticket) return null;

  const messages = await db
    .select()
    .from(supportMessagesTable)
    .where(eq(supportMessagesTable.ticketId, ticketId))
    .orderBy(supportMessagesTable.createdAt);

  const attachments = await db
    .select()
    .from(supportAttachmentsTable)
    .where(eq(supportAttachmentsTable.ticketId, ticketId))
    .orderBy(supportAttachmentsTable.createdAt);

  return { ticket, messages, attachments };
}

// ── USER ROUTES ───────────────────────────────────────────────────────────────

// GET /api/support/unread-count
router.get("/support/unread-count", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) { res.json({ count: 0 }); return; }
  try {
    const rows = await db
      .select({ id: supportMessagesTable.id })
      .from(supportMessagesTable)
      .innerJoin(supportTicketsTable, eq(supportTicketsTable.id, supportMessagesTable.ticketId))
      .where(and(
        eq(supportTicketsTable.clerkUserId, clerkUserId),
        eq(supportMessagesTable.senderRole, "admin"),
        eq(supportMessagesTable.isInternalNote, false),
        eq(supportMessagesTable.isReadByUser, false),
      ));
    res.json({ count: rows.length });
  } catch (err) {
    logger.error({ err }, "Failed to get unread count");
    res.json({ count: 0 });
  }
});

// GET /api/support/tickets
router.get("/support/tickets", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const tickets = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.clerkUserId, clerkUserId))
      .orderBy(desc(supportTicketsTable.updatedAt));

    // For each ticket, get unread count and latest message preview
    const enriched = await Promise.all(tickets.map(async (t) => {
      const [latestMsg] = await db
        .select()
        .from(supportMessagesTable)
        .where(and(
          eq(supportMessagesTable.ticketId, t.id),
          eq(supportMessagesTable.isInternalNote, false),
        ))
        .orderBy(desc(supportMessagesTable.createdAt))
        .limit(1);

      const unreadRows = await db
        .select({ id: supportMessagesTable.id })
        .from(supportMessagesTable)
        .where(and(
          eq(supportMessagesTable.ticketId, t.id),
          eq(supportMessagesTable.senderRole, "admin"),
          eq(supportMessagesTable.isInternalNote, false),
          eq(supportMessagesTable.isReadByUser, false),
        ));

      return {
        ...t,
        ticketNumber: t.ticketNumber ?? ticketNumber(t.id),
        latestMessageAt: latestMsg?.createdAt ?? t.createdAt,
        latestMessagePreview: latestMsg ? latestMsg.message.slice(0, 120) : null,
        latestMessageFrom: latestMsg?.senderRole ?? null,
        unreadCount: unreadRows.length,
      };
    }));

    res.json(enriched);
  } catch (err) {
    logger.error({ err }, "Failed to list tickets");
    res.status(500).json({ error: "Failed to load support tickets" });
  }
});

// POST /api/support/tickets
router.post("/support/tickets", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const parsed = CreateTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", detail: parsed.error.message });
    return;
  }
  const body = parsed.data;

  try {
    const [ticket] = await db
      .insert(supportTicketsTable)
      .values({
        clerkUserId,
        category: body.category,
        subject: body.subject,
        status: "open",
        priority: "normal",
        sourceRoute: body.sourceRoute ?? null,
        appVersion: body.appVersion ?? null,
        deviceInfo: body.deviceInfo ?? null,
        userName: body.userName ?? null,
        userEmail: body.userEmail ?? null,
        subscriptionPlan: body.subscriptionPlan ?? null,
        isTrialing: body.isTrialing ?? null,
        accountRole: body.accountRole ?? null,
        // Legacy
        name: body.userName ?? null,
        email: body.userEmail ?? null,
        message: body.message,
        sourceIp: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      })
      .returning();

    if (!ticket) { res.status(500).json({ error: "Failed to create ticket" }); return; }

    // Set ticket number
    await db
      .update(supportTicketsTable)
      .set({ ticketNumber: ticketNumber(ticket.id) })
      .where(eq(supportTicketsTable.id, ticket.id));

    // Create first message
    const [firstMessage] = await db
      .insert(supportMessagesTable)
      .values({
        ticketId: ticket.id,
        senderUserId: clerkUserId,
        senderRole: "user",
        senderName: body.userName ?? null,
        message: body.message,
        isInternalNote: false,
        isReadByUser: true,
        isReadByAdmin: false,
      })
      .returning();

    // Store attachments
    if (body.attachments && body.attachments.length > 0 && firstMessage) {
      await db.insert(supportAttachmentsTable).values(
        body.attachments.map((att) => ({
          ticketId: ticket.id,
          messageId: firstMessage.id,
          uploadedByUserId: clerkUserId,
          fileName: att.fileName,
          fileType: att.fileType,
          fileSizeBytes: att.fileSizeBytes,
          dataUri: att.dataUri,
        })),
      );
    }

    res.status(201).json({ ...ticket, ticketNumber: ticketNumber(ticket.id) });
  } catch (err) {
    logger.error({ err }, "Failed to create support ticket");
    res.status(500).json({ error: "Failed to create support ticket" });
  }
});

// GET /api/support/tickets/:id
router.get("/support/tickets/:id", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid ticket ID" }); return; }

  try {
    const result = await getTicketWithMessages(id);
    if (!result) { res.status(404).json({ error: "Ticket not found" }); return; }

    // Users can only see their own tickets
    if (result.ticket.clerkUserId !== clerkUserId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    // Mark admin messages as read
    await db
      .update(supportMessagesTable)
      .set({ isReadByUser: true })
      .where(and(
        eq(supportMessagesTable.ticketId, id),
        eq(supportMessagesTable.senderRole, "admin"),
        eq(supportMessagesTable.isReadByUser, false),
      ));

    res.json({
      ...result,
      ticket: { ...result.ticket, ticketNumber: result.ticket.ticketNumber ?? ticketNumber(result.ticket.id) },
    });
  } catch (err) {
    logger.error({ err }, "Failed to get ticket");
    res.status(500).json({ error: "Failed to load ticket" });
  }
});

// POST /api/support/tickets/:id/messages
router.post("/support/tickets/:id/messages", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid ticket ID" }); return; }

  const parsed = AddMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", detail: parsed.error.message });
    return;
  }
  const body = parsed.data;

  try {
    const [ticket] = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id))
      .limit(1);

    if (!ticket) { res.status(404).json({ error: "Ticket not found" }); return; }
    if (ticket.clerkUserId !== clerkUserId) { res.status(403).json({ error: "Access denied" }); return; }
    if (ticket.status === "closed") { res.status(400).json({ error: "Cannot reply to a closed ticket" }); return; }

    const [message] = await db
      .insert(supportMessagesTable)
      .values({
        ticketId: id,
        senderUserId: clerkUserId,
        senderRole: "user",
        senderName: ticket.userName,
        message: body.message,
        isInternalNote: false,
        isReadByUser: true,
        isReadByAdmin: false,
      })
      .returning();

    if (!message) { res.status(500).json({ error: "Failed to add message" }); return; }

    // Store attachments
    if (body.attachments && body.attachments.length > 0) {
      await db.insert(supportAttachmentsTable).values(
        body.attachments.map((att) => ({
          ticketId: id,
          messageId: message.id,
          uploadedByUserId: clerkUserId,
          fileName: att.fileName,
          fileType: att.fileType,
          fileSizeBytes: att.fileSizeBytes,
          dataUri: att.dataUri,
        })),
      );
    }

    // Update ticket status and timestamp
    await db
      .update(supportTicketsTable)
      .set({ status: "waiting_for_support", updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, id));

    res.status(201).json(message);
  } catch (err) {
    logger.error({ err }, "Failed to add message");
    res.status(500).json({ error: "Failed to send message" });
  }
});

// PATCH /api/support/tickets/:id/status
router.patch("/support/tickets/:id/status", requireClerkUser, async (req, res): Promise<void> => {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid ticket ID" }); return; }

  const parsed = UpdateTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", detail: parsed.error.message });
    return;
  }

  const { status } = parsed.data;
  if (!status) { res.status(400).json({ error: "Status required" }); return; }
  // Users can only resolve or reopen
  if (!["resolved", "open"].includes(status)) {
    res.status(400).json({ error: "Users can only mark tickets resolved or reopen them" });
    return;
  }

  try {
    const [ticket] = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id))
      .limit(1);

    if (!ticket) { res.status(404).json({ error: "Ticket not found" }); return; }
    if (ticket.clerkUserId !== clerkUserId) { res.status(403).json({ error: "Access denied" }); return; }

    await db
      .update(supportTicketsTable)
      .set({
        status,
        resolvedAt: status === "resolved" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(supportTicketsTable.id, id));

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to update ticket status");
    res.status(500).json({ error: "Failed to update status" });
  }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// GET /api/support/admin/tickets
router.get("/support/admin/tickets", requireAdmin, async (req, res): Promise<void> => {
  try {
    const { status, category, priority, search, sort } = req.query as Record<string, string | undefined>;

    let query = db.select().from(supportTicketsTable).$dynamic();

    const conditions = [];
    if (status) conditions.push(eq(supportTicketsTable.status, status));
    if (category) conditions.push(eq(supportTicketsTable.category, category));
    if (priority) conditions.push(eq(supportTicketsTable.priority, priority));
    if (search) {
      conditions.push(or(
        ilike(supportTicketsTable.userName, `%${search}%`),
        ilike(supportTicketsTable.userEmail, `%${search}%`),
        ilike(supportTicketsTable.subject, `%${search}%`),
        ilike(supportTicketsTable.ticketNumber, `%${search}%`),
      ));
    }
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const orderCol = sort === "oldest" ? supportTicketsTable.createdAt : supportTicketsTable.updatedAt;
    const tickets = await query.orderBy(desc(orderCol));

    // Enrich with unread counts and message previews
    const enriched = await Promise.all(tickets.map(async (t) => {
      const [latestMsg] = await db
        .select()
        .from(supportMessagesTable)
        .where(eq(supportMessagesTable.ticketId, t.id))
        .orderBy(desc(supportMessagesTable.createdAt))
        .limit(1);

      const unreadForAdmin = await db
        .select({ id: supportMessagesTable.id })
        .from(supportMessagesTable)
        .where(and(
          eq(supportMessagesTable.ticketId, t.id),
          eq(supportMessagesTable.senderRole, "user"),
          eq(supportMessagesTable.isReadByAdmin, false),
        ));

      const attachmentCount = await db
        .select({ id: supportAttachmentsTable.id })
        .from(supportAttachmentsTable)
        .where(eq(supportAttachmentsTable.ticketId, t.id));

      return {
        ...t,
        ticketNumber: t.ticketNumber ?? ticketNumber(t.id),
        latestMessageAt: latestMsg?.createdAt ?? t.createdAt,
        latestMessagePreview: latestMsg ? latestMsg.message.slice(0, 120) : null,
        latestMessageFrom: latestMsg?.senderRole ?? null,
        unreadCount: unreadForAdmin.length,
        attachmentCount: attachmentCount.length,
      };
    }));

    res.json(enriched);
  } catch (err) {
    logger.error({ err }, "Failed to list admin tickets");
    res.status(500).json({ error: "Failed to load tickets" });
  }
});

// GET /api/support/admin/dashboard
router.get("/support/admin/dashboard", requireAdmin, async (req, res): Promise<void> => {
  try {
    const allTickets = await db.select().from(supportTicketsTable);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const unreadMessages = await db
      .select({ id: supportMessagesTable.id })
      .from(supportMessagesTable)
      .where(and(
        eq(supportMessagesTable.senderRole, "user"),
        eq(supportMessagesTable.isReadByAdmin, false),
      ));

    const stats = {
      total: allTickets.length,
      open: allTickets.filter(t => t.status === "open").length,
      waitingForSupport: allTickets.filter(t => t.status === "waiting_for_support").length,
      waitingForUser: allTickets.filter(t => t.status === "waiting_for_user").length,
      resolved: allTickets.filter(t => t.status === "resolved").length,
      closed: allTickets.filter(t => t.status === "closed").length,
      resolvedToday: allTickets.filter(t => t.status === "resolved" && t.resolvedAt && t.resolvedAt >= today).length,
      high: allTickets.filter(t => t.priority === "high" || t.priority === "urgent").length,
      unreadMessages: unreadMessages.length,
    };

    res.json(stats);
  } catch (err) {
    logger.error({ err }, "Failed to get dashboard stats");
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

// GET /api/support/admin/tickets/:id
router.get("/support/admin/tickets/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid ticket ID" }); return; }

  try {
    const result = await getAdminTicketWithMessages(id);
    if (!result) { res.status(404).json({ error: "Ticket not found" }); return; }

    // Mark user messages as read by admin
    await db
      .update(supportMessagesTable)
      .set({ isReadByAdmin: true })
      .where(and(
        eq(supportMessagesTable.ticketId, id),
        eq(supportMessagesTable.senderRole, "user"),
        eq(supportMessagesTable.isReadByAdmin, false),
      ));

    res.json({
      ...result,
      ticket: { ...result.ticket, ticketNumber: result.ticket.ticketNumber ?? ticketNumber(result.ticket.id) },
    });
  } catch (err) {
    logger.error({ err }, "Failed to get admin ticket");
    res.status(500).json({ error: "Failed to load ticket" });
  }
});

// POST /api/support/admin/tickets/:id/messages
router.post("/support/admin/tickets/:id/messages", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid ticket ID" }); return; }

  const parsed = AdminAddMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", detail: parsed.error.message });
    return;
  }
  const body = parsed.data;

  try {
    const [ticket] = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id))
      .limit(1);

    if (!ticket) { res.status(404).json({ error: "Ticket not found" }); return; }

    const [message] = await db
      .insert(supportMessagesTable)
      .values({
        ticketId: id,
        senderUserId: "admin",
        senderRole: "admin",
        senderName: "Support Team",
        message: body.message,
        isInternalNote: body.isInternalNote,
        isReadByUser: false,
        isReadByAdmin: true,
      })
      .returning();

    if (!message) { res.status(500).json({ error: "Failed to add message" }); return; }

    if (body.attachments && body.attachments.length > 0) {
      await db.insert(supportAttachmentsTable).values(
        body.attachments.map((att) => ({
          ticketId: id,
          messageId: message.id,
          uploadedByUserId: "admin",
          fileName: att.fileName,
          fileType: att.fileType,
          fileSizeBytes: att.fileSizeBytes,
          dataUri: att.dataUri,
        })),
      );
    }

    // Update ticket status unless it's an internal note
    if (!body.isInternalNote) {
      await db
        .update(supportTicketsTable)
        .set({ status: "waiting_for_user", updatedAt: new Date() })
        .where(eq(supportTicketsTable.id, id));
    } else {
      await db
        .update(supportTicketsTable)
        .set({ updatedAt: new Date() })
        .where(eq(supportTicketsTable.id, id));
    }

    res.status(201).json(message);
  } catch (err) {
    logger.error({ err }, "Failed to add admin message");
    res.status(500).json({ error: "Failed to send message" });
  }
});

// PATCH /api/support/admin/tickets/:id
router.patch("/support/admin/tickets/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid ticket ID" }); return; }

  const parsed = AdminUpdateTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", detail: parsed.error.message });
    return;
  }
  const body = parsed.data;

  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status === "resolved") updates.resolvedAt = new Date();
      if (body.status === "closed") updates.closedAt = new Date();
    }
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.assignedAdminId !== undefined) updates.assignedAdminId = body.assignedAdminId;

    await db
      .update(supportTicketsTable)
      .set(updates)
      .where(eq(supportTicketsTable.id, id));

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to update ticket");
    res.status(500).json({ error: "Failed to update ticket" });
  }
});

// DELETE /api/support/admin/tickets/:id
router.delete("/support/admin/tickets/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id ?? "0"), 10);
  if (!id) { res.status(400).json({ error: "Invalid ticket ID" }); return; }

  try {
    await db.delete(supportAttachmentsTable).where(eq(supportAttachmentsTable.ticketId, id));
    await db.delete(supportMessagesTable).where(eq(supportMessagesTable.ticketId, id));
    await db.delete(supportTicketsTable).where(eq(supportTicketsTable.id, id));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete ticket");
    res.status(500).json({ error: "Failed to delete ticket" });
  }
});

export default router;
