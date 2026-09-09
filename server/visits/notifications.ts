import { eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import { notifyOwner } from "../_core/notification";
import type { Db } from "./distance";

export async function getManagerName(db: Db, userId: number): Promise<string> {
  const rows = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.name ?? "مدير غير معروف";
}

// ── 🚨 إشعارات الأدمن (fire-and-forget — فشلها لا يوقف العملية الأصلية) ─────
// كل دالة بتبني نفس نص الرسالة الحرفي اللي كان inline في الـ endpoints

// زيارة وهمية وقت check-in فوري
export function notifyMockedCheckIn(managerName: string, locationName: string, isTeleporting: boolean): void {
  notifyOwner({
    title: "🚨 زيارة وهمية مكتشفة",
    content: `المدير: ${managerName}\nالمكان: ${locationName}\nالوقت: ${new Date().toLocaleString("ar-EG")}\n${isTeleporting ? "تم اكتشاف انتقال غير منطقي (Teleportation)" : "تحديد موقع وهمي"}`,
  }).catch(() => {}); // لا نوقف الـ check-in لو فشل الإشعار
}

// زيارة وهمية جاية من مزامنة أوفلاين
export function notifyMockedCheckInOffline(managerName: string, branchName: string, checkInTime: Date, isTeleporting: boolean): void {
  notifyOwner({
    title: "🚨 زيارة وهمية مكتشفة (أوفلاين)",
    content: `المدير: ${managerName}\nالفرع: ${branchName}\nوقت الدخول: ${checkInTime.toLocaleString("ar-EG")}\n${isTeleporting ? "تم اكتشاف انتقال غير منطقي (Teleportation)" : "تحديد موقع وهمي"}`,
  }).catch(() => {});
}

// انتقال وهمي مكتشف وقت الخروج
export function notifyTeleportation(managerName: string, branchName: string | null, distanceKm: number | null, when: Date): void {
  notifyOwner({
    title: "🚨 انتقال وهمي مكتشف (Teleportation)",
    content: `المدير: ${managerName}\nالفرع: ${branchName}\nالمسافة: ${distanceKm?.toFixed(1) ?? "?"} كم\nالوقت: ${when.toLocaleString("ar-EG")}`,
  }).catch(() => {});
}

// زيارة قصيرة مشبوهة (أقل من 3 دقايق) وقت الخروج
export function notifyShortVisit(managerName: string, branchName: string | null, durationMin: number, when: Date): void {
  notifyOwner({
    title: "🚨 زيارة قصيرة مشبوهة",
    content: `المدير: ${managerName}\nالفرع: ${branchName}\nمدة الزيارة: ${Math.round(durationMin * 60)} ثانية فقط\nالوقت: ${when.toLocaleString("ar-EG")}`,
  }).catch(() => {});
}

// مأمورية خارجية جديدة بانتظار مراجعة الأدمن
export function notifyExternalMissionPending(managerName: string, notes: string | undefined, lat: number, lng: number, accuracy: string | undefined, nearestBranch: string | undefined, nearestBranchKm: string | undefined, when: Date): void {
  const nearestLine = nearestBranch ? `\nأقرب فرع: ${nearestBranch}${nearestBranchKm ? ` • ${nearestBranchKm} كم` : ""}` : "";
  notifyOwner({
    title: "🧭 مأمورية خارجية جديدة بانتظار المراجعة",
    content: `المدير: ${managerName}\nالغرض/الملاحظات: ${notes || "—"}\nالإحداثيات: ${lat.toFixed(5)}, ${lng.toFixed(5)}\nالدقة: ${accuracy || "—"}${nearestLine}\nالخريطة: https://maps.google.com/?q=${lat},${lng}\nالوقت: ${when.toLocaleString("ar-EG")}\nراجعها من تقارير الزيارات: موافقة ✅ أو رفض ❌`,
  }).catch(() => {}); // لا نوقف الـ check-in لو فشل الإشعار
}
