import { eq, and } from "drizzle-orm";
import { visits } from "../../drizzle/schema";
import { checkTravelFromPrevBranch, type Db } from "./distance";

export interface VisitForCheckout {
  id: number;
  checkInAt: Date;
  notes?: string | null;
  branchName: string | null; // جاي إنه null للمأموريات الخارجية (leftJoin)
  branchLatitude?: string | null;
  branchLongitude?: string | null;
  // ✅ جايين مع الـ select الأصلي للزيارة — بدل استعلام إضافي هنا
  suspicionScore?: number | null;
  mockReasons?: string | null;
}

// ── 🎯 الدالة الموحدة لإغلاق زيارة (كانت منسوخة 3 مرات — دلوقتي مرة واحدة) ──
// بتستخدمها: checkOut + nativeCheckOut + syncOfflineVisits
export async function finalizeCheckOut(
  db: Db,
  managerId: number,
  visit: VisitForCheckout,
  checkOutTime: Date,
): Promise<{ durationMin: number; distanceKm: number | null; isTeleporting: boolean; distanceEstimated: boolean }> {
  const durationMin = (checkOutTime.getTime() - visit.checkInAt.getTime()) / 60_000;

  // المسافة والـ Teleportation بيتحسبوا دايماً بغض النظر عن المدة
  let distanceKm: number | undefined;
  let isTeleporting = false;
  let distanceEstimated = false;

  // ✅ لا نحسب مسافة للمأموريات الخارجية (branchName = null يعني مفيش فرع)
  if (visit.branchName) {
    const travel = await checkTravelFromPrevBranch(
      db,
      managerId,
      visit.branchName,
      visit.branchLatitude ? parseFloat(visit.branchLatitude) : undefined,
      visit.branchLongitude ? parseFloat(visit.branchLongitude) : undefined,
      visit.checkInAt
    );
    if (travel.km !== null) {
      distanceKm = travel.km;
      distanceEstimated = travel.estimated;
      // إعادة فحص Teleportation كـ double-check (الأساسي بيحصل وقت checkIn)
      if (travel.isTeleporting) {
        isTeleporting = true;
      }
    }
  }

  // ✅ الـ suspicionScore/mockReasons جايين مع الـ select الأصلي للزيارة (بدون استعلام إضافي)
  const existingScore   = visit.suspicionScore ?? 0;
  const existingReasons: string[] = (() => {
    try { return JSON.parse(visit.mockReasons ?? "[]"); } catch { return []; }
  })();

  // ✅ بناء الأسباب الجديدة: تاج مصدر المسافة + الزيارة القصيرة
  const newReasons = [...existingReasons];
  if (distanceEstimated) newReasons.push("DIST_HAVERSINE_ESTIMATE");
  let shortVisitScore = 0;
  if (durationMin < 3) {
    shortVisitScore = 80;
    newReasons.push(`SHORT_VISIT:${Math.round(durationMin * 60)}sec`);
  } else if (durationMin < 7) {
    shortVisitScore = 40;
    newReasons.push(`SHORT_VISIT:${Math.round(durationMin)}min`);
  }

  const finalScore = existingScore + shortVisitScore; // teleport score اتحسب وقت checkIn
  // ✅ مقارنة بالمحتوى مش بالطول — عشان أي تغيير في الأسباب يتسجل
  const reasonsChanged = JSON.stringify(newReasons) !== JSON.stringify(existingReasons);
  const isShortMocked = shortVisitScore >= 80; // أقل من 3 دقايق → وهمي مباشرة

  // لا نكتب "no" أبداً — فقط "yes" إذا اكتشفنا teleporting أو زيارة قصيرة جداً
  const mockedUpdate = (isTeleporting || isShortMocked)
    ? { isMocked: "yes" as const }
    : {};

  await db.update(visits).set({
    checkOutAt: checkOutTime,
    status: "checked_out",
    ...mockedUpdate,
    ...(distanceKm !== undefined ? { distanceToPrevBranchKm: distanceKm.toString() } : {}),
    ...(reasonsChanged ? {
      suspicionScore: finalScore,
      mockReasons: JSON.stringify(newReasons),
    } : {}),
  }).where(and(
    eq(visits.id, visit.id),
    eq(visits.managerId, managerId),
    eq(visits.status, "checked_in"), // ✅ حارس: ميتكتبش على زيارة متقفلة خلاص (idempotency)
  ));

  return {
    durationMin,
    distanceKm: distanceKm ?? null,
    isTeleporting,
    distanceEstimated,
  };
}
