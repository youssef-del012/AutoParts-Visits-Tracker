import { z } from "zod";
import { eq, and, or, ne, gte, lte, desc, count, sql } from "drizzle-orm";
import { router, protectedProcedure, adminProcedure, superAdminProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { visits, managers, branches, users, locationLogs } from "../drizzle/schema";
import { storagePut } from "./storage";
import { getDistanceMeters } from "../shared/utils";
import { checkTravelFromPrevBranch, type Db } from "./visits/distance";
import { finalizeCheckOut } from "./visits/checkout";
import { getManagerName, notifyMockedCheckIn, notifyMockedCheckInOffline, notifyShortVisit, notifyTeleportation, notifyExternalMissionPending } from "./visits/notifications";

// ── In-Memory Lock لمنع الدخول المتزامن (Race Condition) ─────────────────────
const activeCheckInLocks = new Set<number>();

// ── Schemas مشتركة ────────────────────────────────────────────────────────────
const coordSchema = z.string().regex(/^-?\d{1,3}(\.\d+)?$/, "invalid coordinate");

type BranchRow = typeof branches.$inferSelect;

// ── الحقول المشتركة بين myHistory و getActive (نفس شكل عنصر myHistory) ──────
const visitHistorySelection = {
  id: visits.id, checkInAt: visits.checkInAt, checkOutAt: visits.checkOutAt,
  status: visits.status, photoUrl: visits.photoUrl, notes: visits.notes,
  latitudeIn: visits.latitudeIn, longitudeIn: visits.longitudeIn,
  distanceToPrevBranchKm: visits.distanceToPrevBranchKm,
  isMocked: visits.isMocked,
  visitType: visits.visitType, noteType: visits.noteType,
  missionLatitude: visits.missionLatitude, missionLongitude: visits.missionLongitude, missionRadiusMeters: visits.missionRadiusMeters,
  branchName: branches.name, branchId: branches.id, branchCode: branches.code, branchAddress: branches.address,
};

export const visitRouter = router({
  // POST — manager checks in to a branch or external mission
  checkIn: protectedProcedure
    .input(z.object({
      branchId: z.number().int().positive().optional(),
      visitType: z.enum(["branch", "external_mission"]).default("branch"),
      noteType: z.enum(["general", "short_visit", "non_primary", "external_mission"]).default("general"),
      latitude: coordSchema,
      longitude: coordSchema,
      accuracy: z.string().max(32).optional(),
      // ── نطاق المأمورية الخارجية التلقائي (اختياري) ─────────────────────────
      missionLatitude: coordSchema.optional(),
      missionLongitude: coordSchema.optional(),
      missionRadiusMeters: z.number().int().min(20).max(10000).optional(),
      photoBase64: z.string().max(6_000_000).optional(),
      notes: z.string().max(1000).optional(),
      isMocked: z.boolean().optional(),
      // explicit flag: the request comes from the user-initiated manual check-in button
      manual: z.boolean().optional(),
      suspicionScore: z.number().int().min(0).max(10_000).optional(),
      mockReasons: z.array(z.string().max(200)).max(20).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // ✅ استعلام واحد بدل اثنين: المدير + وضع التسجيل checkinMode (join managers↔users)
      const managerRows = await db.select({ manager: managers, checkinMode: users.checkinMode })
        .from(managers)
        .innerJoin(users, eq(managers.userId, users.id))
        .where(eq(managers.userId, ctx.user!.id))
        .limit(1);
      if (!managerRows[0]) throw new Error("Manager profile not found");
      const manager = managerRows[0].manager;

      if (activeCheckInLocks.has(manager.id)) {
        throw new Error("Already processing a check-in request, please wait.");
      }
      activeCheckInLocks.add(manager.id);

      try {
        const existingVisits = await db.select({ id: visits.id }).from(visits)
          .where(and(eq(visits.managerId, manager.id), eq(visits.status, "checked_in"))).limit(1);
        if (existingVisits.length > 0) throw new Error("Already checked into a branch. Please check out first.");

      // \u2705 Manual mode enforcement: the user's app-level auto engine is expected to be off,
      // but any client could still call this endpoint without geofence/sensor context.
        // manual-mode users may check in ONLY via the explicit manual button flag;
        // any auto-engine path (native or web) is rejected.
        if (managerRows[0].checkinMode === "manual" && input.visitType === "branch" && !input.manual) {
          throw new Error("MANUAL_MODE_BLOCKED");
        }

      let branch: BranchRow | undefined;

      if (input.visitType === "branch" || input.branchId) {
        if (!input.branchId) throw new Error("Branch ID is required for a branch visit.");
        const branchResult = await db.select().from(branches).where(eq(branches.id, input.branchId)).limit(1);
        if (!branchResult[0]) throw new Error("Branch not found");
        const currentBranch = branchResult[0];
        branch = currentBranch;

        const dist = getDistanceMeters(
          parseFloat(input.latitude), parseFloat(input.longitude),
          parseFloat(currentBranch.latitude), parseFloat(currentBranch.longitude)
        );
        if (dist > (currentBranch.geofenceRadiusMeters || 200) + 50) throw new Error("You are too far from the branch to check in.");
      }

      let photoUrl: string | undefined;
      if (input.photoBase64) {
        const buffer = Buffer.from(input.photoBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
        const stored = await storagePut(`visits/${manager.id}_${Date.now()}.jpg`, buffer, "image/jpeg");
        photoUrl = stored.url;
      }

      // ── 🚨 فحص Teleportation وقت الـ CheckIn (الأهم) ────────────────────────
      let isTeleporting = false;
      const teleportReasons: string[] = [];

      if (branch) {
        // ✅ الفحص الموحد (كانت منسوخة هنا + في syncOfflineVisits + في finalizeCheckOut)
        const travel = await checkTravelFromPrevBranch(
          db, manager.id, branch.name,
          parseFloat(branch.latitude), parseFloat(branch.longitude),
          new Date()
        );
        if (travel.isTeleporting) {
          isTeleporting = true;
          teleportReasons.push(travel.teleportReason!);
        }
      } else if (input.visitType === "external_mission") {
        // 🚨 فحص Teleportation للمأمورية الخارجية — الاسم غير موجود في جدول المسافات
        // فيعمل Fallback Haversine بالإحداثيات (نفس الفحص الموحد ونفس فورمات السبب)
        const travel = await checkTravelFromPrevBranch(
          db, manager.id, "مأمورية خارجية",
          parseFloat(input.latitude), parseFloat(input.longitude),
          new Date()
        );
        if (travel.isTeleporting) {
          isTeleporting = true;
          teleportReasons.push(travel.teleportReason!);
        }
      }

      // ── 📍 أقرب فرع للمأمورية الخارجية (يُخزن للعرض في تقارير الأدمن) ─────────
      let nearestBranchId: number | undefined;
      let nearestBranchName: string | undefined;
      let nearestBranchDistanceKm: string | undefined;
      if (input.visitType === "external_mission") {
        const activeBranches = await db.select({
          id: branches.id, name: branches.name,
          latitude: branches.latitude, longitude: branches.longitude,
        }).from(branches).where(eq(branches.isActive, "yes"));
        const missionLat = parseFloat(input.latitude);
        const missionLng = parseFloat(input.longitude);
        let best: { id: number; name: string; km: number } | null = null;
        for (const b of activeBranches) {
          const meters = getDistanceMeters(missionLat, missionLng, parseFloat(b.latitude), parseFloat(b.longitude));
          const km = meters / 1000;
          if (!best || km < best.km) best = { id: b.id, name: b.name, km };
        }
        if (best) {
          nearestBranchId = best.id;
          nearestBranchName = best.name;
          nearestBranchDistanceKm = best.km.toFixed(2);
        }
      }

      const finalIsMocked = input.isMocked || isTeleporting;

      const combinedReasons = [...(input.mockReasons || []), ...teleportReasons];
      const finalReasons  = combinedReasons.length > 0 ? JSON.stringify(combinedReasons) : null;
      const finalScore = (input.suspicionScore || 0) + (isTeleporting ? 100 : 0);

      await db.update(managers).set({ isActive: "yes" }).where(eq(managers.id, manager.id));

      await db.insert(visits).values({
        managerId: manager.id, branchId: input.branchId,
        visitType: input.visitType, noteType: input.noteType,

        latitudeIn: input.latitude, longitudeIn: input.longitude,
        accuracyIn: input.accuracy, photoUrl, notes: input.notes,
        status: "checked_in",
        isMocked: finalIsMocked ? "yes" : "no",
        suspicionScore: finalScore,
        mockReasons: finalReasons,
        // ── مركز المأمورية للجيوفنس التلقائي — يُخزن للمأمورية الخارجية فقط ──
        ...(input.visitType === "external_mission" ? {
          missionLatitude: input.missionLatitude ?? input.latitude,
          missionLongitude: input.missionLongitude ?? input.longitude,
          missionRadiusMeters: input.missionRadiusMeters ?? 200,
          // المأمورية الخارجية تتسجل بانتظار المراجعة — الفروع تبقى approved من الـ default
          approvalStatus: "pending" as const,
          // أقرب فرع للإحداثيات — لو مفيش فروع نشطة يتسيبوا undefined (NULL)
          ...(nearestBranchId !== undefined ? {
            nearestBranchId, nearestBranchName, nearestBranchDistanceKm,
          } : {}),
        } : {}),
      });

      // 🧭 لو مأمورية خارجية — إشعار كامل للأدمن بانتظار المراجعة (fire-and-forget)
      if (input.visitType === "external_mission") {
        const managerName = await getManagerName(db, ctx.user!.id);
        notifyExternalMissionPending(
          managerName, input.notes,
          parseFloat(input.latitude), parseFloat(input.longitude), input.accuracy,
          nearestBranchName, nearestBranchDistanceKm, new Date()
        );
      }

      // 🚨 لو الزيارة وهمية — ابعت إشعار فوري للأدمن
      if (finalIsMocked) {
        const managerName = await getManagerName(db, ctx.user!.id);
        notifyMockedCheckIn(managerName, branch ? branch.name : "مأمورية خارجية", isTeleporting);
      }

      return { success: true };
      } finally {
        activeCheckInLocks.delete(manager.id);
      }
    }),

  // POST — Android native background service checkout (accepts branchId, looks up the active visitId itself)
  // Used by NativeGeofenceEngine.java which only knows the branchId, not the visitId
  nativeCheckOut: protectedProcedure
    .input(z.object({ branchId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // ✅ استعلام واحد بدل اثنين: المدير + checkinMode (نفس نمط checkIn)
      const managerRows = await db.select({ manager: managers, checkinMode: users.checkinMode })
        .from(managers)
        .innerJoin(users, eq(managers.userId, users.id))
        .where(eq(managers.userId, ctx.user!.id))
        .limit(1);
      if (!managerRows[0]) throw new Error("Manager profile not found");
      const manager = managerRows[0].manager;

      // \u2705 Manual mode: native auto check-out is disabled
      if (managerRows[0].checkinMode === "manual") {
        throw new Error("MANUAL_MODE_BLOCKED");
      }

      // Find the active check-in for this specific branch
      const activeVisit = await db.select({
        id: visits.id,
        checkInAt: visits.checkInAt,
        branchName: branches.name,
        branchLatitude: branches.latitude,
        branchLongitude: branches.longitude,
        // ✅ جايين مع الـ select الأصلي — finalizeCheckOut مش محتاجة استعلام إضافي
        suspicionScore: visits.suspicionScore,
        mockReasons: visits.mockReasons,
      }).from(visits)
        .innerJoin(branches, eq(visits.branchId, branches.id))
        .where(and(
          eq(visits.managerId, manager.id),
          eq(visits.branchId, input.branchId),
          eq(visits.status, "checked_in"),
        ))
        .limit(1);

      if (!activeVisit[0]) {
        // No active visit for this branch — nothing to check out from
        return { success: true, skipped: true };
      }

      const result = await finalizeCheckOut(db, manager.id, activeVisit[0], new Date());

      return {
        success: true,
        skipped: false,
        durationMin: Math.round(result.durationMin),
        distanceRecorded: result.distanceKm,
      };
    }),

  // POST — manager checks out
  checkOut: protectedProcedure
    .input(z.object({
      visitId: z.number().int().positive(),
      notes: z.string().max(1000).optional(),
      noteType: z.enum(["general", "short_visit", "non_primary", "external_mission"]).optional()
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const managerResult = await db.select().from(managers).where(eq(managers.userId, ctx.user!.id)).limit(1);
      if (!managerResult[0]) throw new Error("Manager profile not found");
      const manager = managerResult[0];

      // ── اجيب بيانات الزيارة الحالية ────────────────────────────────────────
      const visitResult = await db.select({
        id:        visits.id,
        checkInAt: visits.checkInAt,
        notes:     visits.notes,
        branchName: branches.name,
        branchLatitude: branches.latitude,
        branchLongitude: branches.longitude,
        // ✅ جايين مع الـ select الأصلي — finalizeCheckOut مش محتاجة استعلام إضافي
        suspicionScore: visits.suspicionScore,
        mockReasons: visits.mockReasons,
      }).from(visits)
        .leftJoin(branches, eq(visits.branchId, branches.id))
        .where(and(
          eq(visits.id, input.visitId),
          eq(visits.managerId, manager.id),
          eq(visits.status, "checked_in"),
        ))
        .limit(1);

      if (!visitResult[0]) throw new Error("Visit not found or already checked out.");
      const now = new Date();
      const visit = visitResult[0];
      const result = await finalizeCheckOut(db, manager.id, visit, now);

      if (input.notes || input.noteType) {
        const finalNotes = input.notes ? (visit.notes ? `${visit.notes}\n---\nخروج: ${input.notes}` : input.notes) : visit.notes;
        await db.update(visits).set({
          ...(input.noteType ? { noteType: input.noteType } : {}),
          ...(input.notes ? { notes: finalNotes } : {}),
        }).where(eq(visits.id, visit.id));
      }

      // 🚨 إشعار للأدمن — teleporting أو زيارة قصيرة جداً
      if (result.isTeleporting) {
        const managerName = await getManagerName(db, ctx.user!.id);
        notifyTeleportation(managerName, visit.branchName, result.distanceKm, now);
      }

      const isShortMocked = result.durationMin < 3;
      if (isShortMocked) {
        const managerName = await getManagerName(db, ctx.user!.id);
        notifyShortVisit(managerName, visit.branchName, result.durationMin, now);
      }

      return {
        success: true,
        durationMin: Math.round(result.durationMin),
        distanceRecorded: result.distanceKm,
      };
    }),

  // GET — current manager's visit history
  myHistory: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerResult = await db.select().from(managers).where(eq(managers.userId, ctx.user!.id)).limit(1);
      if (!managerResult[0]) return { items: [], total: 0, activeCount: 0, doneCount: 0 };
      const managerId = managerResult[0].id;
      // إخفاء المأموريات المرفوضة من المدير — على القوائم والعدادات (total/activeCount/doneCount)
      const whereClause = and(
        eq(visits.managerId, managerId),
        or(ne(visits.visitType, "external_mission"), ne(visits.approvalStatus, "rejected")),
      );
      // ✅ استعلام عدّ واحد بدل استعلام total منفصل: total + activeCount + doneCount
      const [{ total, activeCount, doneCount }] = await db.select({
        total: count(),
        activeCount: sql<number>`count(case when ${visits.status} = 'checked_in' then 1 end)`.mapWith(Number),
        doneCount: sql<number>`count(case when ${visits.status} = 'checked_out' then 1 end)`.mapWith(Number),
      }).from(visits).where(whereClause);
      const items = await db.select(visitHistorySelection)
        .from(visits).leftJoin(branches, eq(visits.branchId, branches.id))
        .where(whereClause).orderBy(desc(visits.checkInAt)).limit(input.limit).offset(input.offset);
      return { items, total, activeCount, doneCount };
    }),

  // GET — الزيارة النشطة الحالية للمدير (بنفس شكل عنصر myHistory) أو null
  // خفيفة: idx_visits_manager_status + limit 1 — بديل أخف لـ myHistory{limit:5} في شاشة تسجيل الدخول
  getActive: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const managerResult = await db.select({ id: managers.id }).from(managers).where(eq(managers.userId, ctx.user!.id)).limit(1);
    if (!managerResult[0]) return null;
    const items = await db.select(visitHistorySelection)
      .from(visits).leftJoin(branches, eq(visits.branchId, branches.id))
      .where(and(
        eq(visits.managerId, managerResult[0].id),
        eq(visits.status, "checked_in"),
        // المأمورية المرفوضة لا تظهر كزيارة نشطة للمدير
        or(ne(visits.visitType, "external_mission"), ne(visits.approvalStatus, "rejected")),
      ))
      .orderBy(desc(visits.checkInAt))
      .limit(1);
    return items[0] ?? null;
  }),

  // GET — admin: all visits with filters
  adminList: adminProcedure
    .input(z.object({
      managerId: z.number().int().positive().optional(),
      branchId: z.number().int().positive().optional(),
      startDate: z.string().max(32).optional(),
      endDate: z.string().max(32).optional(),
      approvalStatus: z.enum(["pending", "approved", "rejected"]).optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const conditions: any[] = [];
      if (input.managerId) conditions.push(eq(visits.managerId, input.managerId));
      if (input.branchId) conditions.push(eq(visits.branchId, input.branchId));
      if (input.startDate) conditions.push(gte(visits.checkInAt, new Date(input.startDate)));
      if (input.endDate) {
        const end = new Date(input.endDate);
        end.setHours(23, 59, 59, 999);
        conditions.push(lte(visits.checkInAt, end));
      }
      if (input.approvalStatus) conditions.push(eq(visits.approvalStatus, input.approvalStatus));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      const [{ total }] = await db.select({ total: count() }).from(visits)
        .innerJoin(managers, eq(visits.managerId, managers.id))
        .innerJoin(users, eq(managers.userId, users.id)).where(whereClause);
      const items = await db.select({
        id: visits.id, checkInAt: visits.checkInAt, checkOutAt: visits.checkOutAt,
        status: visits.status, photoUrl: visits.photoUrl, notes: visits.notes,
        distanceToPrevBranchKm: visits.distanceToPrevBranchKm,
        isMocked: visits.isMocked,
        // ✅ أسباب التلاعب — تظهر فقط للأدمن في التقارير
        mockReasons: visits.mockReasons,
        visitType: visits.visitType, noteType: visits.noteType,
        // ── حقول المأمورية الخارجية — إضافة للعرض في تقارير الأدمن ─────────────
        latitudeIn: visits.latitudeIn, longitudeIn: visits.longitudeIn,
        missionLatitude: visits.missionLatitude, missionLongitude: visits.missionLongitude, missionRadiusMeters: visits.missionRadiusMeters,
        nearestBranchId: visits.nearestBranchId, nearestBranchName: visits.nearestBranchName, nearestBranchDistanceKm: visits.nearestBranchDistanceKm,
        // ── حالة اعتماد المأمورية — للـ badge وأزرار الموافقة/الرفض في تقارير الأدمن ──
        approvalStatus: visits.approvalStatus,
        reviewedAt: visits.reviewedAt,
        branchName: branches.name, branchId: branches.id, branchCode: branches.code,
        managerName: users.name, managerEmail: users.email,
        managerPhotoUrl: managers.photoUrl,
      }).from(visits).leftJoin(branches, eq(visits.branchId, branches.id))
        .innerJoin(managers, eq(visits.managerId, managers.id))
        .innerJoin(users, eq(managers.userId, users.id))
        .where(whereClause).orderBy(desc(visits.checkInAt)).limit(input.limit).offset(input.offset);
      return { items, total };
    }),

  // POST — admin: اعتماد أو رفض مأمورية خارجية (الرفض يغلق الزيارة النشطة لو كانت شغالة)
  reviewMission: adminProcedure
    .input(z.object({
      visitId: z.number().int().positive(),
      decision: z.enum(["approved", "rejected"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.update(visits).set({
        approvalStatus: input.decision,
        reviewedAt: new Date(),
        reviewedByUserId: ctx.user!.id,
      }).where(and(eq(visits.id, input.visitId), eq(visits.visitType, "external_mission")));
      if (input.decision === "rejected") {
        await db.update(visits).set({
          checkOutAt: new Date(),
          status: "checked_out",
        }).where(and(eq(visits.id, input.visitId), eq(visits.status, "checked_in")));
      }
      return { success: true };
    }),

  // GET — admin dashboard stats
  stats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const [{ totalBranches }] = await db
      .select({ totalBranches: count() })
      .from(branches)
      .where(eq(branches.isActive, "yes"));

    const [{ totalManagers }] = await db
      .select({ totalManagers: count() })
      .from(managers)
      .where(eq(managers.isActive, "yes"));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // ✅ استعلام واحد بدل اثنين: زيارات النهاردة + الوهمية منها (conditional count)
    // (totalBranches/totalManagers على جدولين مختلفين — دمجهم cross-join هيضرب العدّادات)
    const [{ todayVisits, mockedVisitsToday }] = await db
      .select({
        todayVisits: count(),
        mockedVisitsToday: sql<number>`count(case when ${visits.isMocked} = 'yes' then 1 end)`.mapWith(Number),
      })
      .from(visits)
      .where(gte(visits.checkInAt, today));

    return { totalBranches, totalManagers, todayVisits, mockedVisitsToday };
  }),

  // GET — recent visits for dashboard
  recentVisits: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(5) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const items = await db.select({
        id: visits.id,
        checkInAt: visits.checkInAt,
        checkOutAt: visits.checkOutAt,
        status: visits.status,
        isMocked: visits.isMocked,
        visitType: visits.visitType,
        branchName: branches.name,
        managerName: users.name,
        managerId: managers.id,
      }).from(visits)
        .leftJoin(branches, eq(visits.branchId, branches.id))
        .innerJoin(managers, eq(visits.managerId, managers.id))
        .innerJoin(users, eq(managers.userId, users.id))
        .orderBy(desc(visits.checkInAt))
        .limit(input.limit);
      return items;
    }),

  // GET — الزيارات المفتوحة حالياً لكل مدير (للداشبورد)
  activeVisits: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const items = await db.select({
      managerId: managers.id,
      branchName: branches.name,
      visitType: visits.visitType,
      checkInAt: visits.checkInAt,
    }).from(visits)
      .leftJoin(branches, eq(visits.branchId, branches.id))
      .innerJoin(managers, eq(visits.managerId, managers.id))
      .where(eq(visits.status, "checked_in"));
    return items;
  }),

  // POST — sync offline visits (check-in / check-out)
  syncOfflineVisits: protectedProcedure
    .input(z.object({
      visits: z.array(z.discriminatedUnion("type", [
        z.object({
          type: z.literal("check_in"),
          branchId: z.number().int().positive(),
          branchName: z.string().max(255),
          latitude: coordSchema,
          longitude: coordSchema,
          accuracy: z.string().max(32).optional(),
          checkInAt: z.string().datetime({ offset: true }),
          localId: z.string().max(128),
          isMocked: z.boolean().optional(),
        }),
        z.object({
          type: z.literal("check_out"),
          localCheckInId: z.string().max(128),
          serverVisitId: z.number().int().positive().optional(),
          branchName: z.string().max(255),
          checkOutAt: z.string().datetime({ offset: true }),
          checkInAt: z.string().datetime({ offset: true }),
        }),
      ])).max(50),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const managerResult = await db.select().from(managers)
        .where(eq(managers.userId, ctx.user!.id)).limit(1);
      if (!managerResult[0]) throw new Error("Manager profile not found");
      const manager = managerResult[0];

      // ✅ المعالجة كلها جوه transaction واحدة (drizzle mysql2) — بدل استعلامات متفرقة
      return db.transaction(async (tx: Db) => {
        let synced = 0;
        let rejected = 0;
        const failedLocalIds: string[] = [];
        const localToServerId = new Map<string, number>();

        // ── 1. check-ins ──────────────────────────────────────────────────────
        const checkIns = input.visits.filter((v) => v.type === "check_in");
        for (const ci of checkIns) {
          try {
            const existing = await tx.select({ id: visits.id }).from(visits)
              .where(and(eq(visits.managerId, manager.id), eq(visits.status, "checked_in")))
              .limit(1);
            if (existing.length > 0) { failedLocalIds.push(ci.localId); rejected++; continue; }

            const branchResult = await tx.select().from(branches)
              .where(eq(branches.id, ci.branchId)).limit(1);
            if (!branchResult[0]) { failedLocalIds.push(ci.localId); rejected++; continue; }
            const branch = branchResult[0];

            const dist = getDistanceMeters(
              parseFloat(ci.latitude), parseFloat(ci.longitude),
              parseFloat(branch.latitude), parseFloat(branch.longitude)
            );
            if (dist > (branch.geofenceRadiusMeters || 200) + 50) {
              console.warn(`[syncOfflineVisits] Rejected: manager ${manager.id} was ${Math.round(dist)}m from branch ${branch.name}`);
              failedLocalIds.push(ci.localId);
              rejected++;
              continue;
            }

            // ✅ check-in offline: فحص Teleportation + mock detection (الفحص الموحد)
            const ciReasons: string[] = [];

            let isTeleporting = false;
            const checkInTime = new Date(ci.checkInAt);
            const travel = await checkTravelFromPrevBranch(
              tx, manager.id, ci.branchName,
              parseFloat(branch.latitude), parseFloat(branch.longitude),
              checkInTime
            );
            if (travel.isTeleporting) {
              isTeleporting = true;
              ciReasons.push(travel.teleportReason!);
            }

            const ciFinalMocked = ci.isMocked || isTeleporting;

            await tx.update(managers).set({ isActive: "yes" }).where(eq(managers.id, manager.id));

            const inserted = await tx.insert(visits).values({
              managerId: manager.id,
              branchId: ci.branchId,
              latitudeIn: ci.latitude,
              longitudeIn: ci.longitude,
              accuracyIn: ci.accuracy,
              checkInAt: checkInTime,
              status: "checked_in",
              isMocked: ciFinalMocked ? "yes" : "no",
              suspicionScore: ciFinalMocked ? 100 : 0,
              mockReasons: ciReasons.length > 0 ? JSON.stringify(ciReasons) : null,
            }).$returningId();

            // 🚨 لو الزيارة المتزامنة وهمية — ابعت إشعار للأدمن
            if (ciFinalMocked) {
              const managerName = await getManagerName(tx, ctx.user!.id);
              notifyMockedCheckInOffline(managerName, branch.name, checkInTime, isTeleporting);
            }

            localToServerId.set(ci.localId, inserted.id);
            synced++;
          } catch (err) {
            console.error("[syncOfflineVisits] checkIn error:", err);
            failedLocalIds.push(ci.localId);
          }
        }

        // ── 2. check-outs ─────────────────────────────────────────────────────
        const checkOuts = input.visits.filter((v) => v.type === "check_out");
        for (const co of checkOuts) {
          try {
            const visitId = localToServerId.get(co.localCheckInId)
              ?? (co.serverVisitId ?? null);

            if (!visitId) { failedLocalIds.push(co.localCheckInId); continue; }

            const visitRow = await tx.select({
              id: visits.id,
              checkInAt: visits.checkInAt,
              branchName: branches.name,
              branchLatitude: branches.latitude,
              branchLongitude: branches.longitude,
              // ✅ جايين مع الـ select الأصلي — finalizeCheckOut مش محتاجة استعلام إضافي
              suspicionScore: visits.suspicionScore,
              mockReasons: visits.mockReasons,
            })
              .from(visits)
              .leftJoin(branches, eq(visits.branchId, branches.id))
              .where(and(eq(visits.id, visitId), eq(visits.managerId, manager.id)))
              .limit(1);

            if (!visitRow[0]) continue;

            await finalizeCheckOut(tx, manager.id, visitRow[0], new Date(co.checkOutAt));
            synced++;
          } catch (err) {
            console.error("[syncOfflineVisits] checkOut error:", err);
          }
        }

        return { synced, rejected, failedLocalIds };
      });
    }),

  // POST — sync offline tracking data
  syncOfflineData: protectedProcedure
    .input(z.object({
      locations: z.array(z.object({
        latitude: coordSchema,
        longitude: coordSchema,
        accuracy: z.string().max(32).optional(),
        timestamp: z.string().datetime({ offset: true }),
      })).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerResult = await db.select().from(managers).where(eq(managers.userId, ctx.user!.id)).limit(1);
      if (!managerResult[0]) throw new Error("Manager profile not found");
      const manager = managerResult[0];
      if (input.locations.length > 0) {
        await db.insert(locationLogs).values(input.locations.map(loc => ({
          managerId: manager.id, latitude: loc.latitude, longitude: loc.longitude,
          accuracy: loc.accuracy, timestamp: new Date(loc.timestamp), syncedAt: new Date(),
        })));
      }
      return { success: true, syncedLocations: input.locations.length };
    }),

  // ── 🦸‍♂️ السوبر أدمن ──────────────────────────────────────────────────────────
  superadminUpdate: superAdminProcedure
    .input(z.object({
      id: z.number(),
      managerId: z.number().optional(),
      branchId: z.number().nullable().optional(),
      visitType: z.enum(["branch", "external_mission"]).optional(),
      noteType: z.enum(["general", "short_visit", "non_primary", "external_mission"]).optional(),
      checkInAt: z.string().optional(),
      checkOutAt: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      status: z.enum(["checked_in", "checked_out"]).optional(),
      isMocked: z.enum(["yes", "no"]).optional(),
      distanceToPrevBranchKm: z.number().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const { id, ...data } = input;
      const updateData: any = { ...data };
      if (input.checkInAt !== undefined) updateData.checkInAt = new Date(input.checkInAt);
      if (input.checkOutAt !== undefined) updateData.checkOutAt = input.checkOutAt ? new Date(input.checkOutAt) : null;
      if (input.distanceToPrevBranchKm !== undefined) updateData.distanceToPrevBranchKm = input.distanceToPrevBranchKm?.toString();
      await db.update(visits).set(updateData).where(eq(visits.id, id));
      return { success: true };
    }),

  superadminDelete: superAdminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.delete(visits).where(eq(visits.id, input.id));
      return { success: true };
    }),

  superadminCreate: superAdminProcedure
    .input(z.object({
      managerId: z.number(),
      branchId: z.number().nullable(),
      visitType: z.enum(["branch", "external_mission"]),
      noteType: z.enum(["general", "short_visit", "non_primary", "external_mission"]),
      checkInAt: z.string(),
      checkOutAt: z.string().nullable(),
      notes: z.string().nullable(),
      status: z.enum(["checked_in", "checked_out"]),
      isMocked: z.enum(["yes", "no"]),
      latitudeIn: z.string(),
      longitudeIn: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const updateData: any = { ...input };
      updateData.checkInAt = new Date(input.checkInAt);
      if (input.checkOutAt) updateData.checkOutAt = new Date(input.checkOutAt);

      await db.insert(visits).values(updateData);
      return { success: true };
    }),

  // ── GET — تقرير المدير الشهري (بدون أي معلومات وهمية) ─────────────────────
  // يُستخدم من صفحة تقارير المدير — نظيف تماماً من mockReasons/isMocked
  myReport: protectedProcedure
    .input(z.object({
      startDate: z.string().max(32).optional(),
      endDate: z.string().max(32).optional(),
      limit: z.number().int().min(1).max(1000).default(500),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const managerResult = await db.select().from(managers).where(eq(managers.userId, ctx.user!.id)).limit(1);
      if (!managerResult[0]) return { items: [], total: 0 };
      const managerId = managerResult[0].id;

      const conditions: any[] = [
        eq(visits.managerId, managerId),
        // إخفاء المأموريات المرفوضة من تقرير المدير
        or(ne(visits.visitType, "external_mission"), ne(visits.approvalStatus, "rejected")),
      ];
      if (input.startDate) conditions.push(gte(visits.checkInAt, new Date(input.startDate)));
      if (input.endDate) {
        const end = new Date(input.endDate);
        end.setHours(23, 59, 59, 999);
        conditions.push(lte(visits.checkInAt, end));
      }
      const whereClause = and(...conditions);

      const [{ total }] = await db.select({ total: count() }).from(visits).where(whereClause);
      const items = await db.select({
        id: visits.id,
        checkInAt: visits.checkInAt,
        checkOutAt: visits.checkOutAt,
        status: visits.status,
        visitType: visits.visitType,
        noteType: visits.noteType,
        notes: visits.notes,
        distanceToPrevBranchKm: visits.distanceToPrevBranchKm,
        // لا نُرسل isMocked ولا mockReasons للمدير أبداً
        branchName: branches.name,
        branchId: branches.id,
        branchCode: branches.code,
        branchAddress: branches.address,
      }).from(visits)
        .leftJoin(branches, eq(visits.branchId, branches.id))
        .where(whereClause)
        .orderBy(desc(visits.checkInAt))
        .limit(input.limit)
        .offset(input.offset);
      return { items, total };
    }),
});
