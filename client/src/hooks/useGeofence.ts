/**
 * useGeofence — Background Geolocation + Software Geofencing Hook
 *
 * Uses @capacitor-community/background-geolocation which runs an Android
 * Foreground Service (persistent notification) to keep tracking even when
 * the app is in the background or the screen is off.
 *
 * Geofencing is implemented in software by comparing the current position
 * against each assigned branch's coordinates using the Haversine formula.
 *
 * Flow:
 *  1. On mount: fetch assigned branches.
 *  2. Start background watcher (native Foreground Service on Android).
 *  3. On each position update → check distance against all branches.
 *  4. If inside a branch radius and not checked-in → auto check-in.
 *     - If online  → send to server immediately.
 *     - If offline → save locally as pending_checkin.
 *  5. If outside active branch radius and checked-in → auto check-out.
 *     - If online  → send to server immediately.
 *     - If offline → save locally as pending_checkout.
 *  6. All location updates are queued in localforage when offline and synced on reconnect.
 *  7. On reconnect → sync pending visits first, then location logs.
 *
 * ── الإصلاحات ────────────────────────────────────────────────────────────────
 *  • Cooldown 3 دقايق لكل فرع — يمنع check-in تلقائي متكرر
 *  • الـ watcher يُنشأ مرة واحدة فقط عبر watcherStartedRef
 *  • كل mutations تمر عبر refs — الـ watcher لا يُعاد بسبب تغيُّر الـ callbacks
 *  • syncAll لا تُستدعى مع كل GPS update — فقط كل 5 دقايق / foreground / online
 *  • إشعار "رجع النت" مرة واحدة كل 10 ثواني على الأكثر (debounce)
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "../_core/hooks/useAuth";
import { App } from "@capacitor/app";
import { Preferences } from "@capacitor/preferences";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import localforage from "localforage";
import { getDistanceMeters } from "../../../shared/utils";
import { SERVER_BASE_URL, MAX_LOCATIONS_PER_SYNC, MAX_VISITS_PER_SYNC } from "@/lib/config";

// ─── Offline stores ───────────────────────────────────────────────────────────

// نقاط GPS لمسار المدير
const locationStore = localforage.createInstance({
  name: "branch-tracker",
  storeName: "offline_locations",
});

// الزيارات المعلقة (check-in / check-out وهو أوفلاين)
const visitStore = localforage.createInstance({
  name: "branch-tracker",
  storeName: "offline_visits",
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IOSNearbyBranch {
  id: number;
  name: string;
  address: string | null;
  distanceMeters: number;
  accuracy?: number;
}

interface OfflineLocation {
  latitude: string;
  longitude: string;
  accuracy?: string;
  timestamp: string;
}

interface PendingCheckIn {
  type: "check_in";
  branchId: number;
  branchName: string;
  latitude: string;
  longitude: string;
  accuracy?: string;
  checkInAt: string; // وقت الدخول الحقيقي
  localId: string;   // ID محلي مؤقت
  isMocked?: boolean; // هل الموقع وهمي؟
  attempts?: number;  // ✅ عدد مرات رفض المزامنة — بعد 3 يتشال كزومبي
}

interface PendingCheckOut {
  type: "check_out";
  localCheckInId: string; // نفس localId بتاع الـ check-in
  serverVisitId?: number; // لو الـ check-in اتبعت للسيرفر وجه ID
  branchName: string;
  checkInAt: string;  // ✅ محتاجه السيرفر يحسب المدة (15 دقيقة)
  checkOutAt: string; // وقت الخروج الحقيقي
}

type PendingVisit = PendingCheckIn | PendingCheckOut;

// ─── Global State for mock detection ──────────────────────────────────────────
export let globalMockedStatus = false;

// ─── Cooldown: يمنع check-in تلقائي متكرر لنفس الفرع ───────────────────────
// ✅ الإصلاح: يُخزَّن في Preferences (يبقى بعد إعادة فتح التطبيق)
// بدلاً من Map في الـ memory (تُمسح عند إعادة الفتح → double check-in)
const CHECK_IN_COOLDOWN_MS = 3 * 60 * 1000;
// ✅ cooldown قصير بعد فشل المحاولة (شبكة ضعيفة مثلاً) — يمنع إعادة المحاولة العشوائية
const CHECK_IN_FAILURE_COOLDOWN_MS = 60 * 1000;

// ── ✅ إصلاح الخروج العشوائي: فلتر دقة الـ GPS ───────────────────────────────
// أي قراءة بدقة أسوأ من 100 متر تُتجاهل تماماً — كانت السبب الرئيسي في
// تسجيل خروج وهمي والمدير واقف مكانها (GPS ضعيف لحظياً)
const MAX_GEOFENCE_ACCURACY_M = 100;
// ✅ نأكد من قراءتين متتاليتين خارج النطاق قبل الـ check-out
// (قراءة واحدة سيئة مش هتقطع الزيارة)
const REQUIRED_OUTSIDE_READINGS = 2;

// ── ✅ مزامنة نقاط التتبع كل دقيقة (كانت 5 دقايق → التتبع اللحظي كان بطيء) ──
const LOCATION_SYNC_INTERVAL_MS = 60 * 1000;

// ── ✅ Dwell Time & Speed Check ──────────────────────────────────────────────
const DWELL_TIME_MS = 2 * 60 * 1000; // دقيقتين
const MAX_CHECKIN_SPEED_M_S = 4.16; // 15 كم/ساعة

async function getCooldownKey(branchId: number): Promise<string> {
  return `checkin_cooldown_${branchId}`;
}

async function isBranchInCooldown(branchId: number): Promise<boolean> {
  try {
    const { Preferences } = await import("@capacitor/preferences");
    const key = await getCooldownKey(branchId);
    const { value } = await Preferences.get({ key });
    if (!value) return false;
    // القيمة المخزنة هي وقت انتهاء الـ cooldown (مش وقت المحاولة)
    return Date.now() < parseInt(value, 10);
  } catch {
    return false; // لو فشل الـ Preferences → اسمح بالـ check-in
  }
}

async function setBranchCooldown(branchId: number, durationMs: number = CHECK_IN_COOLDOWN_MS): Promise<void> {
  try {
    const { Preferences } = await import("@capacitor/preferences");
    const key = await getCooldownKey(branchId);
    await Preferences.set({ key, value: (Date.now() + durationMs).toString() });
  } catch { /* silent */ }
}

// ─── Debounce للـ "online" toast (مرة واحدة كل 10 ثواني) ───────────────────
let lastOnlineToastAt = 0;
const ONLINE_TOAST_DEBOUNCE_MS = 10_000;

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useGeofence() {
  const { data: branches = [], isSuccess: branchesLoaded } =
    trpc.manager.getMyBranches.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const { data: historyData, refetch: refetchHistory, isLoading: historyLoading } =
    trpc.visit.myHistory.useQuery({ limit: 1, offset: 0 }, { staleTime: 30_000 });

  const checkInMutation = trpc.visit.checkIn.useMutation();

  // ?? ???? ???????? (checkinMode) — ?? ????? ?? ???? ???????
  const { user: authUser } = useAuth();
  const checkinMode = authUser?.checkinMode ?? "automatic";
  const autoCheckinEnabledRef = useRef(checkinMode === "automatic");
  autoCheckinEnabledRef.current = checkinMode === "automatic";
  const checkOutMutation = trpc.visit.checkOut.useMutation();
  const syncOfflineMutation = trpc.visit.syncOfflineData.useMutation();
  const syncVisitsMutation = trpc.visit.syncOfflineVisits.useMutation();

  const activeVisit = historyData?.items[0]?.status === "checked_in"
    ? historyData.items[0]
    : null;

  // Keep refs fresh for use inside callbacks (avoid stale closures)
  const activeVisitRef = useRef(activeVisit);
  activeVisitRef.current = activeVisit;

  const branchesRef = useRef(branches);
  branchesRef.current = branches;

  const historyLoadingRef = useRef(historyLoading);
  historyLoadingRef.current = historyLoading;

  const refetchHistoryRef = useRef(refetchHistory);
  refetchHistoryRef.current = refetchHistory;

  // Ref to hold the background watcher ID so cleanup can remove it
  const watcherIdRef = useRef<string | null>(null);

  // Flag: الـ watcher اتعمل — يمنع إنشاء watcher ثاني
  const watcherStartedRef = useRef(false);

  // ── Mutation refs (يمنع إعادة إنشاء الـ watcher عند تغيُّر الـ mutations) ──
  const checkInMutationRef = useRef(checkInMutation);
  checkInMutationRef.current = checkInMutation;

  const checkOutMutationRef = useRef(checkOutMutation);
  checkOutMutationRef.current = checkOutMutation;

  const syncOfflineMutationRef = useRef(syncOfflineMutation);
  syncOfflineMutationRef.current = syncOfflineMutation;

  const syncVisitsMutationRef = useRef(syncVisitsMutation);
  syncVisitsMutationRef.current = syncVisitsMutation;

  // State to expose the latest background location to the UI
  const [latestLocation, setLatestLocation] = useState<{
    lat: number;
    lon: number;
    accuracy?: number;
    isMocked: boolean;
  } | null>(null);

  // ── Sync to Native Preferences ──────────────────────────────────────────
  useEffect(() => {
    if (branches.length > 0 && Capacitor.isNativePlatform()) {
      Preferences.set({
        key: "branches_data",
        value: JSON.stringify(branches),
      });
      Preferences.set({
        key: "api_url",
        value: SERVER_BASE_URL,
      });
      // \u2705 keep the native engine aware of the user's check-in mode
      Preferences.set({
        key: "user_checkin_mode",
        value: checkinMode,
      });
    }
  }, [branches, checkinMode]);

  // Sync active_branch_id for NativeGeofenceEngine
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      if (activeVisit) {
        Preferences.set({ key: "active_branch_id", value: activeVisit.branchId.toString() });
      } else {
        Preferences.remove({ key: "active_branch_id" });
      }
    }
  }, [activeVisit?.branchId]);

  // ── مساعد: هل في نت؟ ──────────────────────────────────────────────────────
  const isOnline = () => navigator.onLine;

  // ── مساعد: جلب الزيارات المعلقة ───────────────────────────────────────────
  const getPendingVisits = async (): Promise<PendingVisit[]> => {
    return (await visitStore.getItem<PendingVisit[]>("queue")) || [];
  };

  // ── مساعد: حفظ الزيارات المعلقة ───────────────────────────────────────────
  const setPendingVisits = async (visits: PendingVisit[]) => {
    await visitStore.setItem("queue", visits);
  };

  // ── مساعد: هل في check-in معلق محلياً؟ ───────────────────────────────────
  const getLocalActiveVisit = async (): Promise<PendingCheckIn | null> => {
    const pending = await getPendingVisits();
    const checkIns = pending.filter((v): v is PendingCheckIn => v.type === "check_in");
    const checkOuts = pending.filter((v): v is PendingCheckOut => v.type === "check_out");
    const checkedOutIds = new Set(checkOuts.map((v) => v.localCheckInId));
    return checkIns.find((v) => !checkedOutIds.has(v.localId)) || null;
  };

  // ── مزامنة الزيارات المعلقة مع السيرفر ────────────────────────────────────
  // ✅ بنبعت على دفعات (chunks) مطابقة لحد السيرفر — كانت الدفعة الكبيرة
  //    بترفض كلها مرة واحدة وتبقي المزامنة معطلة للأبد بعد فترة أوفلاين طويلة
  const syncPendingVisitsRef = useRef(async () => {
    if (!navigator.onLine) return;
    try {
      const pending = await getPendingVisits();
      if (pending.length === 0) return;

      let allFailedIds: string[] = [];
      let totalSynced = 0;
      let totalRejected = 0;

      for (let i = 0; i < pending.length; i += MAX_VISITS_PER_SYNC) {
        const chunk = pending.slice(i, i + MAX_VISITS_PER_SYNC);
        const res = await syncVisitsMutationRef.current.mutateAsync({ visits: chunk });
        totalSynced += res.synced;
        totalRejected += res.rejected;
        allFailedIds.push(...(res.failedLocalIds ?? []));
      }

      if (totalSynced > 0 || totalRejected > 0) {
        const failedIds = new Set<string>(allFailedIds);
        const sentIds = new Set(
          pending.map((v) => (v.type === "check_in" ? v.localId : v.localCheckInId))
        );

        const currentPending = await getPendingVisits();
        // ✅ تنظيف الزومبي: check-in اترفض 3 مرات = بيانات بايظة — نشيله
        //   عشان ميفضش يعطل الـ auto check-in للأبد
        const remaining: PendingVisit[] = [];
        for (const v of currentPending) {
          const id = v.type === "check_in" ? v.localId : v.localCheckInId;
          const keepUnsent = !sentIds.has(id);
          const keepFailed = failedIds.has(id);
          if (!keepUnsent && !keepFailed) continue;

          if (keepFailed && v.type === "check_in") {
            const attempts = (v.attempts ?? 0) + 1;
            if (attempts >= 3) {
              toast.warning(`⚠️ تسجيل دخول أوفلاين اتلغى بعد ${attempts} محاولات رفض من السيرفر (${v.branchName})`);
              continue; // زومبي — امسحه
            }
            remaining.push({ ...v, attempts });
          } else {
            remaining.push(v);
          }
        }

        await setPendingVisits(remaining);
        refetchHistoryRef.current();

        if (totalRejected > 0) {
          toast.warning(`⚠️ ${totalRejected} زيارة مرفوضة — سيُعاد المحاولة تلقائياً`);
        }
      }
    } catch {
      // هيحاول تاني المرة الجاية
    }
  });

  // ── مزامنة نقاط GPS ────────────────────────────────────────────────────────
  const syncOfflineDataRef = useRef(async () => {
    if (!navigator.onLine) return;
    try {
      const pending: OfflineLocation[] = (await locationStore.getItem("queue")) || [];
      if (pending.length > 0) {
        // ✅ دفعات محدودة — كانت الكمية الكبيرة بترفض من السيرفر (max 2000)
        //    والمزامنة بتتعطل للأبد. لو أي دفعة فشلت، الـ catch بيحافظ على الطابور
        for (let i = 0; i < pending.length; i += MAX_LOCATIONS_PER_SYNC) {
          const chunk = pending.slice(i, i + MAX_LOCATIONS_PER_SYNC);
          await syncOfflineMutationRef.current.mutateAsync({ locations: chunk });
        }
        await locationStore.setItem("queue", []);
      }
    } catch {
      // silently fail — will retry next time
    }
  });

  // ── مزامنة شاملة ─────────────────────────────────────────────────────────
  const syncAllRef = useRef(async () => {
    await syncPendingVisitsRef.current();
    await syncOfflineDataRef.current();
  });

  // نسخة stable من syncAll للاستخدام الخارجي لو احتجنا
  const syncAll = useCallback(async () => {
    await syncAllRef.current();
  }, []);

  // Periodic sync every 5 minutes — يستخدم الـ ref مباشرة
  useEffect(() => {
    const interval = setInterval(() => syncAllRef.current(), 1000 * 60 * 5);
    return () => clearInterval(interval);
  }, []);

  // ── نظام مبسط لكشف المواقع الوهمية ──────────────────────────────────────
  const checkIsMocked = (
    accuracy: number | undefined,
    isMockedFromNative: boolean,
    currentLat?: number,
    currentLng?: number,
  ): boolean => {
    if (isMockedFromNative) return true;
    if (accuracy !== undefined && accuracy === 0) return true;

    // فحص ثبات الموقع الجغرافي — أقوى مؤشر للـ Fake GPS
    if (currentLat !== undefined && currentLng !== undefined) {
      const recent = recentPositionsRef.current;
      recent.push({ lat: currentLat, lng: currentLng });
      if (recent.length > 6) recent.shift();

      if (recent.length >= 5) {
        const allSameLat = recent.every(p => p.lat === recent[0].lat);
        const allSameLng = recent.every(p => p.lng === recent[0].lng);
        if (allSameLat && allSameLng) return true;
      }
    }

    return false;
  };

  const recentPositionsRef = useRef<{ lat: number; lng: number }[]>([]);

  // ── ✅ قفل محلي لمنع الإرسال المتزامن عند وصول إحداثيات سريعة متتالية ─────────
  const isProcessingCheckInRef = useRef(false);

  // ── ✅ عدّاد القراءات الخارجية لكل فرع (لتأكيد الخروج بقراءتين) ─────────────
  const outsideCountRef = useRef<Map<number, number>>(new Map());

  // ── ✅ وقت أول مشاهدة داخل النطاق لكل فرع (لتطبيق Dwell Time) ──────────────
  const firstSeenAtRef = useRef<Map<number, number>>(new Map());

  // ── ✅ آخر وقت اتعملت فيه مزامنة لنقاط التتبع (كل دقيقة بدل 5) ─────────────
  const lastLocationSyncAtRef = useRef(0);

  // ── Handle a position update ───────────────────────────────────────────────
  const handlePositionUpdate = useCallback(async (
    currentLat: number,
    currentLng: number,
    accuracy?: number,
    isMocked?: boolean,
    speed?: number,
  ) => {
    // ✅ إصلاح حرج: تجاهل القراءات سيئة الدقة تماماً
    // (GPS ضعيف لحظياً كان بيخلي النظام يفتكر المدير خرج من الفرع وهو واقف مكانه)
    if (accuracy !== undefined && accuracy > MAX_GEOFENCE_ACCURACY_M) {
      console.debug(`[Geofence] Skipping inaccurate fix (${accuracy}m > ${MAX_GEOFENCE_ACCURACY_M}m)`);
      return;
    }

    const detectedMock = checkIsMocked(accuracy, !!isMocked, currentLat, currentLng);
    globalMockedStatus = detectedMock;

    setLatestLocation({
      lat: currentLat,
      lon: currentLng,
      accuracy: typeof accuracy === "number" ? accuracy : undefined,
      isMocked: detectedMock,
    });
    if (historyLoadingRef.current) return;

    // 1. احفظ نقطة الـ GPS في الـ queue
    const pendingLocs: OfflineLocation[] = (await locationStore.getItem("queue")) || [];
    pendingLocs.push({
      latitude: currentLat.toString(),
      longitude: currentLng.toString(),
      accuracy: accuracy?.toString(),
      timestamp: new Date().toISOString(),
    });
    await locationStore.setItem("queue", pendingLocs);

    // ⚡✅ مزامنة نقاط التتبع كل دقيقة (مدفوعة بتحديثات GPS الأصلية —
    // بتشتغل حتى لو الـ WebView throttled في الخلفية، عكس setInterval)
    const now = Date.now();
    if (isOnline() && now - lastLocationSyncAtRef.current >= LOCATION_SYNC_INTERVAL_MS) {
      lastLocationSyncAtRef.current = now;
      syncOfflineDataRef.current(); // fire-and-forget — مش بنوقف المنطق عليها
    }

    // ── ✅ المأمورية الخارجية النشطة: خروج تلقائي لما المدير يخرج من نطاق المأمورية ──
    // المأمورية القديمة بدون إحداثيات مركز تكمّل مسارها العادي من غير معالجة
    const missionVisit = activeVisitRef.current;
    if (missionVisit?.visitType === "external_mission" && missionVisit.missionLatitude && missionVisit.missionLongitude) {
      const radius = missionVisit.missionRadiusMeters || 200;
      // مفتاح سالب فريد — ميتصادش مع مفاتيح عدّادات الفروع
      const missionKey = -missionVisit.id;
      const dist = getDistanceMeters(
        currentLat, currentLng,
        parseFloat(missionVisit.missionLatitude),
        parseFloat(missionVisit.missionLongitude)
      );
      if (dist > radius + 50) {
        // ✅ نأكد من قراءتين متتاليتين خارج النطاق قبل إنهاء المأمورية
        const count = (outsideCountRef.current.get(missionKey) ?? 0) + 1;
        outsideCountRef.current.set(missionKey, count);
        if (count < REQUIRED_OUTSIDE_READINGS) return;

        outsideCountRef.current.delete(missionKey);
        if (isOnline()) {
          try {
            await checkOutMutationRef.current.mutateAsync({ visitId: missionVisit.id });
            toast.success(`✅ تم إنهاء المأمورية الخارجية تلقائيًا (خروج من نطاق ${radius}م)`);
            refetchHistoryRef.current();
            // ⚡ ابعت نقاط التتبع فوراً مع الحدث
            syncOfflineDataRef.current();
          } catch { /* ignore */ }
        } else {
          // ✅ بنبعت checkInAt عشان السيرفر يقدر يحسب المدة صح
          const pending = await getPendingVisits();
          pending.push({
            type: "check_out",
            localCheckInId: `server_${missionVisit.id}`,
            serverVisitId: missionVisit.id,
            branchName: "مأمورية خارجية",
            checkInAt: missionVisit.checkInAt instanceof Date
              ? missionVisit.checkInAt.toISOString()
              : String(missionVisit.checkInAt),
            checkOutAt: new Date().toISOString(),
          });
          await setPendingVisits(pending);
          toast.info(`📦 سجلنا خروج المأمورية أوفلاين وسيُزامن تلقائيًا`);
        }
        return;
      }
      // داخل نطاق المأمورية → صفّر العداد
      outsideCountRef.current.delete(missionKey);
      return;
    }

    // ── لو الوضع manual: استمر في تسجيل الإحداثيات (Live Tracking) لكن أوقف التسجيل التلقائي ──
    if (!autoCheckinEnabledRef.current) return;

    const currentBranches = branchesRef.current;

    // ── نبص على الحالة الحالية (سيرفر أو محلية) ──────────────────────────
    const serverActiveVisit = activeVisitRef.current;
    const localActiveVisit = await getLocalActiveVisit();

    // ── 2. Auto check-out (بعد تأكيد قراءتين خارج النطاق) ──────────────────
    if (serverActiveVisit) {
      const activeBranch = currentBranches.find((b) => b.id === serverActiveVisit.branchId);
      if (activeBranch?.latitude && activeBranch?.longitude) {
        const dist = getDistanceMeters(
          currentLat, currentLng,
          parseFloat(activeBranch.latitude),
          parseFloat(activeBranch.longitude)
        );
        if (dist > (activeBranch.geofenceRadiusMeters || 200) + 50) {
          // ✅ نحتاج قراءتين متتاليتين خارج النطاق قبل ما نسجل خروج
          const count = (outsideCountRef.current.get(activeBranch.id) ?? 0) + 1;
          outsideCountRef.current.set(activeBranch.id, count);
          if (count < REQUIRED_OUTSIDE_READINGS) return;

          outsideCountRef.current.delete(activeBranch.id);
          if (isOnline()) {
            try {
              await checkOutMutationRef.current.mutateAsync({ visitId: serverActiveVisit.id });
              toast.info(`🔴 تسجيل خروج تلقائي من ${activeBranch.name}`);
              refetchHistoryRef.current();
              // ⚡ ابعت نقاط التتبع فوراً مع الحدث
              syncOfflineDataRef.current();
            } catch { /* ignore */ }
          } else {
            // ✅ بنبعت checkInAt عشان السيرفر يقدر يحسب المدة صح
            const pending = await getPendingVisits();
            pending.push({
              type: "check_out",
              localCheckInId: `server_${serverActiveVisit.id}`,
              serverVisitId: serverActiveVisit.id,
              branchName: activeBranch.name,
              checkInAt: serverActiveVisit.checkInAt instanceof Date
                ? serverActiveVisit.checkInAt.toISOString()
                : String(serverActiveVisit.checkInAt),
              checkOutAt: new Date().toISOString(),
            });
            await setPendingVisits(pending);
            toast.info(`🔴 خروج مؤقت من ${activeBranch.name} — سيُرسل لما النت يرجع`);
          }
        } else {
          // رجعنا جوه النطاق → صفّر العداد
          outsideCountRef.current.delete(activeBranch.id);
        }
      }
      return;
    }

    if (localActiveVisit) {
      const activeBranch = currentBranches.find((b) => b.id === localActiveVisit.branchId);
      if (activeBranch?.latitude && activeBranch?.longitude) {
        const dist = getDistanceMeters(
          currentLat, currentLng,
          parseFloat(activeBranch.latitude),
          parseFloat(activeBranch.longitude)
        );
        if (dist > (activeBranch.geofenceRadiusMeters || 200) + 50) {
          const count = (outsideCountRef.current.get(activeBranch.id) ?? 0) + 1;
          outsideCountRef.current.set(activeBranch.id, count);
          if (count < REQUIRED_OUTSIDE_READINGS) return;

          outsideCountRef.current.delete(activeBranch.id);
          const pending = await getPendingVisits();
          pending.push({
            type: "check_out",
            localCheckInId: localActiveVisit.localId,
            branchName: activeBranch.name,
            checkInAt: localActiveVisit.checkInAt, // ✅ موجود في PendingCheckIn أصلاً
            checkOutAt: new Date().toISOString(),
          });
          await setPendingVisits(pending);
          toast.info(`🔴 خروج مؤقت من ${activeBranch.name} — سيُرسل لما النت يرجع`);
        } else {
          outsideCountRef.current.delete(activeBranch.id);
        }
      }
      return;
    }

    // ── 3. Auto check-in ───────────────────────────────────────────────────
    if (isProcessingCheckInRef.current) return;
    isProcessingCheckInRef.current = true;

    try {
      for (const branch of currentBranches) {
        if (!branch.latitude || !branch.longitude) continue;
        const dist = getDistanceMeters(
          currentLat, currentLng,
          parseFloat(branch.latitude),
          parseFloat(branch.longitude)
        );
        if (dist <= (branch.geofenceRadiusMeters || 200)) {
          // ── Cooldown: تجنب تسجيل الدخول أكثر من مرة للفرع نفسه في 3 دقايق ──
          // ✅ يُحفظ في Preferences → يبقى بعد إعادة فتح التطبيق
          if (await isBranchInCooldown(branch.id)) {
            break; // في cooldown — تجاهل هذه المحاولة
          }

          // ── Dwell Time & Speed Check ───────────────────────────────────────
          if (speed !== undefined && speed > MAX_CHECKIN_SPEED_M_S) {
            console.debug(`[Geofence] Moving too fast (${speed}m/s), skipping check-in`);
            firstSeenAtRef.current.delete(branch.id);
            break;
          }

          const nowTime = Date.now();
          const firstSeen = firstSeenAtRef.current.get(branch.id);
          if (!firstSeen) {
            console.debug(`[Geofence] First seen at ${branch.name}, starting dwell timer`);
            firstSeenAtRef.current.set(branch.id, nowTime);
            break; // Wait for dwell time
          }
          if (nowTime - firstSeen < DWELL_TIME_MS) {
            console.debug(`[Geofence] Waiting for dwell time at ${branch.name} (${Math.round((nowTime - firstSeen) / 1000)}s)`);
            break; // Wait
          }

          await setBranchCooldown(branch.id);

          if (isOnline()) {
            try {
              await checkInMutationRef.current.mutateAsync({
                branchId: branch.id,
                latitude: currentLat.toString(),
                longitude: currentLng.toString(),
                isMocked: detectedMock,
              });
              toast.success(`✅ تسجيل دخول تلقائي في ${branch.name}`);
              refetchHistoryRef.current();
              // ⚡ ابعت نقاط التتبع فوراً مع الحدث
              syncOfflineDataRef.current();
            } catch (err: any) {
              if (err.message?.includes("Already checked")) {
                // المستخدم محسوب عليه check-in بالفعل — حدِّث الحالة فقط
                refetchHistoryRef.current();
              } else {
                // ✅ cooldown قصير (دقيقة) بدل مسحه — يمنع إعادة المحاولة العشوائية
                // وToast spam لما الشبكة ضعيفة، مع إعادة المحاولة سريعاً نسبياً
                await setBranchCooldown(branch.id, CHECK_IN_FAILURE_COOLDOWN_MS);
              }
            }
          } else {
            const localId = `local_${Date.now()}_${branch.id}`;
            const pending = await getPendingVisits();
            pending.push({
              type: "check_in",
              branchId: branch.id,
              branchName: branch.name,
              latitude: currentLat.toString(),
              longitude: currentLng.toString(),
              accuracy: accuracy?.toString(),
              checkInAt: new Date().toISOString(),
              localId,
              isMocked: detectedMock,
            });
            await setPendingVisits(pending);
            toast.success(`✅ دخول مؤقت في ${branch.name} — سيُرسل لما النت يرجع`);
          }
          firstSeenAtRef.current.delete(branch.id); // Reset dwell timer after successful trigger
          break; // check-in في فرع واحد بس
        } else {
          // Outside the branch, reset its dwell timer
          firstSeenAtRef.current.delete(branch.id);
        }
      }
    } finally {
      isProcessingCheckInRef.current = false;
    }
  }, []); // جميع المتغيرات تمر عبر refs — لا داعي لإعادة الإنشاء

  // ── Setup geolocation watcher (native or web) ─────────────────────────────
  // ✅ يُشغَّل أول ما يخلص تحميل الفروع — حتى لو المدير معندوش فروع متسابَة،
  // عشان نقاط التتبع (breadcrumbs) توصل للتتبع اللحظي عند الأدمن
  useEffect(() => {
    if (!branchesLoaded) return;
    // \u2705 react to mode changes without app restart (re-run watcher setup)
    if (!watcherStartedRef.current) { /* first run */ } else { watcherStartedRef.current = false; }
    // لا تُنشئ watcher ثاني لو الأول شغّال
    if (watcherStartedRef.current) return;
    watcherStartedRef.current = true;

    let cleanupFn: (() => void) | null = null;
    // ✅ حارس السباق: لو الكومبوننت اتقفل قبل ما الـ setup يخلص،
    //   الـ watcher اللي هيتضاف بعدها لازم يتشال فوراً — كان بيسرب
    //   خدمة تتبع يتيمة في الخلفية بعد كل Logout/Login
    let cancelled = false;

    const setup = async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          // Dynamic import — only runs on native Android/iOS.
          const bgGeoModule = "@capacitor-community/background-geolocation";
          const { BackgroundGeolocation } = await import(/* @vite-ignore */ bgGeoModule);

          if (cancelled) return;
          // ?? ???? manual: ?? ?? ??? ??????? ??????? — ??? GPS ??????? ??? ???????? ???
          if (!autoCheckinEnabledRef.current) {
            console.log("[Geofence] Manual check-in mode: skipping background watcher, using foreground-only GPS");
            await setupWebGeolocation();
            return;
          }

          if (cancelled) return; // اتقفلنا ونا بنجهز — متضيفش حاجة

          const id = await BackgroundGeolocation.addWatcher(
            {
              backgroundTitle: "تتبع الزيارات نشط",
              backgroundMessage: "يتم تتبع موقعك لضمان دقة الزيارات الميدانية.",
              requestPermissions: true,
              stale: false,
              distanceFilter: 20,
            },
            async (location: any, error: any) => {
              if (error) {
                if (error.code === "NOT_AUTHORIZED") {
                  toast.error(
                    "يرجى السماح بالوصول للموقع دائماً من الإعدادات",
                    {
                      action: {
                        label: "الإعدادات",
                        onClick: () => BackgroundGeolocation.openSettings(),
                      },
                    }
                  );
                }
                return;
              }
              if (location) {
                await handlePositionUpdate(location.latitude, location.longitude, location.accuracy, !!location.simulated, location.speed);
              }
            }
          );

          if (cancelled) {
            // اتقفلنا والـ watcher لسه ليه اتضاف — شيله فوراً
            await BackgroundGeolocation.removeWatcher({ id });
            return;
          }

          watcherIdRef.current = id;
          cleanupFn = async () => {
            if (watcherIdRef.current) {
              await BackgroundGeolocation.removeWatcher({ id: watcherIdRef.current });
              watcherIdRef.current = null;
            }
          };
        } catch (err) {
          console.error("[Geofence] Native setup error:", err);
          console.warn("[Geofence] Falling back to web geolocation...");
          if (!cancelled) await setupWebGeolocation();
        }
      } else {
        await setupWebGeolocation();
      }
    };

    // ── Shared web geolocation fallback ──────────────────────────────────────
    async function setupWebGeolocation() {
      try {
        const { Geolocation } = await import("@capacitor/geolocation");
        const permissions = await Geolocation.checkPermissions();
        if (permissions.location !== "granted") {
          const req = await Geolocation.requestPermissions();
          if (req.location !== "granted") return;
        }
        const watchId = await Geolocation.watchPosition(
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
          (pos, err) => {
            if (!err && pos) {
              // ✅ accuracy===1 كانت بتعلّم مواقع حقيقية إنها وهمية على الويب
              //   المتصفحات بتبلغ دقة عالية جداً أحياناً — نعتمد على 0 بس
              const isSuspicious = pos.coords.accuracy === 0;
              handlePositionUpdate(
                pos.coords.latitude,
                pos.coords.longitude,
                pos.coords.accuracy,
                isSuspicious,
                pos.coords.speed !== null ? pos.coords.speed : undefined
              );
            }
          }
        );
        cleanupFn = () => Geolocation.clearWatch({ id: watchId });
      } catch (geoErr) {
        console.error("[Geofence] Web geolocation error:", geoErr);
      }
    }

    setup();

    // لما التطبيق يرجع للفورجراوند → زامن عبر الـ ref مباشرة
    const listenerPromise = App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) syncAllRef.current();
    });

    // لما النت يرجع → toast مرة واحدة مع debounce + مزامنة
    const handleOnline = () => {
      const now = Date.now();
      if (now - lastOnlineToastAt > ONLINE_TOAST_DEBOUNCE_MS) {
        lastOnlineToastAt = now;
        toast.info("🌐 رجع النت — جاري مزامنة البيانات...");
      }
      syncAllRef.current();
    };
    window.addEventListener("online", handleOnline);

    return () => {
      cancelled = true; // ✅ أوقف الـ setup لو لسه شغال
      watcherStartedRef.current = false;
      if (typeof cleanupFn === "function") cleanupFn();
      listenerPromise.then((l) => l.remove());
      window.removeEventListener("online", handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchesLoaded ? 1 : 0, checkinMode]); // يُشغَّل مرة واحدة فقط أول ما الاستعلام يخلص

  return { latestLocation };
}
