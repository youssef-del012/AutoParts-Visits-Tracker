import { useState, useEffect, useRef, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { getDistanceMeters } from "../../../shared/utils";
import { useGeofenceContext } from "@/App";
import { Link } from "wouter";
import { Loader2 } from "lucide-react";
import { MapView, MapMarker, GeofenceCircle, type MapCenter } from "@/components/Map";
import { Capacitor } from "@capacitor/core";
import NotesModal, { type NotesModalType } from "./NotesModal";
import "./BranchCheckIn.css";

export default function BranchCheckIn() {
  const [view, setView] = useState<"list" | "map">("map");
  const [fly, setFly] = useState<MapCenter | null>(null);
  const didAutoFlyRef = useRef(false);

  const [notesModalState, setNotesModalState] = useState<{
    isOpen: boolean;
    type: NotesModalType;
    branchId?: number;
  }>({ isOpen: false, type: "check_in_branch" });
  const [visitNotes, setVisitNotes] = useState("");

  const isWebPlatform = !Capacitor.isNativePlatform();

  // ── Block Android browser users — they must use the native app ──────────────
  const isAndroidBrowser = isWebPlatform &&
    /android/i.test(navigator.userAgent);

  const { latestLocation } = useGeofenceContext();
  const gpsLocation = latestLocation ? { lat: latestLocation.lat, lon: latestLocation.lon } : null;
  const globalMockedStatus = latestLocation?.isMocked ?? false;

  // ✅ staleTime 5 دقايق — الفروع المسندة نادراً ما تتغير خلال الجلسة
  const { data: assignedBranches = [] } = trpc.manager.getMyBranches.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  // ✅ getActive بدل myHistory{limit:5} — استعلام أخف بيرجّع الزيارة النشطة مباشرة (أو null)
  const { data: activeVisit, refetch: refetchVisits } = trpc.visit.getActive.useQuery(undefined, {
    staleTime: 30_000,
  });
  const checkInMutation = trpc.visit.checkIn.useMutation();
  const checkOutMutation = trpc.visit.checkOut.useMutation();

  // أول ما يوصل أول إشارة GPS → طيّر الخريطة على مكانك تلقائياً
  useEffect(() => {
    if (gpsLocation && !didAutoFlyRef.current) {
      didAutoFlyRef.current = true;
      setFly({ lat: gpsLocation.lat, lng: gpsLocation.lon });
    }
  }, [gpsLocation]);

  // ✅ useMemo: المسافات محسوبة على موقع GPS مقرّب (3 كسور عشرية ≈ 100 متر)
  // — مش بيعيد الحساب مع كل tick، بس لما المدير يتحرك فعلياً أو الفروع/الزيارة تتغير
  const gpsLat = gpsLocation ? Number(gpsLocation.lat.toFixed(3)) : null;
  const gpsLon = gpsLocation ? Number(gpsLocation.lon.toFixed(3)) : null;

  const branchesWithDistance = useMemo(() => {
    return (assignedBranches as any[]).map((b) => {
      const dist = gpsLat !== null && gpsLon !== null
        ? getDistanceMeters(gpsLat, gpsLon, parseFloat(b.latitude), parseFloat(b.longitude))
        : Infinity;
      return {
        ...b,
        distanceM: dist,
        inRange: gpsLat !== null && gpsLon !== null ? dist <= (b.geofenceRadiusMeters || 200) : false,
        status: activeVisit?.branchId === b.id ? "visited" : "pending",
      };
    });
  }, [assignedBranches, gpsLat, gpsLon, activeVisit?.branchId]);

  const sortedBranches = useMemo(
    () => [...branchesWithDistance].sort(
      (a, b) => (a.distanceM === Infinity ? 1 : a.distanceM) - (b.distanceM === Infinity ? 1 : b.distanceM)
    ),
    [branchesWithDistance]
  );
  const closestBranch = sortedBranches[0];

  const openCheckInModal = (branchId: number) => {
    if (!gpsLocation) return toast.error("لسه بنحدد موقعك — استنى ثواني");
    if (globalMockedStatus) {
      return toast.error("🚨 الموقع وهمي! اقفل اي برنامج Fake GPS وحاول تاني");
    }
    setNotesModalState({ isOpen: true, type: "check_in_branch", branchId });
    setVisitNotes("");
  };

  const openExternalMissionModal = () => {
    if (!gpsLocation) return toast.error("لسه بنحدد موقعك — استنى ثواني");
    if (globalMockedStatus) {
      return toast.error("🚨 الموقع وهمي! اقفل اي برنامج Fake GPS وحاول تاني");
    }
    setNotesModalState({ isOpen: true, type: "check_in_external" });
    setVisitNotes("");
  };


  const handleManualCheckOutClick = () => {
    if (!activeVisit) return;
    // للمأموريات الخارجية: نسمح دائماً بالخروج بدون قيود وقت
    if (activeVisit.visitType === "external_mission") {
      setNotesModalState({ isOpen: true, type: "check_out_general" });
      setVisitNotes("");
      return;
    }
    const checkInTime = activeVisit.checkInAt ? new Date(activeVisit.checkInAt).getTime() : Date.now();
    const durationMin = (new Date().getTime() - checkInTime) / 60000;

    // إذا كانت الزيارة أقل من 20 دقيقة (وتشمل 7 لـ 20 دقيقة كما طلب المستخدم)
    if (durationMin < 20) {
      setNotesModalState({ isOpen: true, type: "check_out_short" });
      setVisitNotes("");
    } else {
      setNotesModalState({ isOpen: true, type: "check_out_general" });
      setVisitNotes("");
    }
  };

  const submitModal = async () => {
    const { type, branchId } = notesModalState;
    if (type === "check_in_external" && !visitNotes.trim()) {
      return toast.error("برجاء إدخال تفاصيل المأمورية الخارجية");
    }
    if (type === "check_out_short" && !visitNotes.trim() && !isWebPlatform) {
      return toast.error("برجاء إدخال سبب قصر مدة الزيارة");
    }

    // الصورة المحفوظة من شاشة الـ Selfie تم إيقافها

    try {
      if (type === "check_in_branch") {
        if (!branchId) return;
        const branchName = sortedBranches.find((b) => b.id === branchId)?.name ?? "";
        await checkInMutation.mutateAsync({
          branchId,
          latitude: gpsLocation!.lat.toString(),
          longitude: gpsLocation!.lon.toString(),
          isMocked: globalMockedStatus,
          visitType: "branch",
          noteType: "general",
          manual: true,
          notes: visitNotes.trim() || undefined,
        });
        toast.success(`✅ تم تسجيل دخولك في ${branchName}`);
        refetchVisits();
      } else if (type === "check_in_external") {
        await checkInMutation.mutateAsync({
          latitude: gpsLocation!.lat.toString(),
          longitude: gpsLocation!.lon.toString(),
          isMocked: globalMockedStatus,
          visitType: "external_mission",
          noteType: "external_mission",
          notes: visitNotes.trim(),
        });
        toast.success(`✅ تم بدء مأمورية خارجية بنجاح`);
        refetchVisits();
      } else if (type === "check_out_short" || type === "check_out_general") {
        // null guard: لو إحنا بينما المودال مفتوحة وبيتم refetch وتغيرت حالة الزيارة
        if (!activeVisit) {
          toast.error("انتهت الجلسة من تلقاء نفسها");
          setNotesModalState({ ...notesModalState, isOpen: false });
          return;
        }
        await checkOutMutation.mutateAsync({
          visitId: activeVisit.id,
          notes: visitNotes.trim() || undefined,
          noteType: type === "check_out_short" ? "short_visit" : undefined,
        });
        toast.success("🔴 تم تسجيل خروجك — سلامات!");
        refetchVisits();
      }
      setNotesModalState({ isOpen: false, type: "check_in_branch" });
    } catch (err: any) {
      toast.error(`❌ حدث خطأ: ${err.message || String(err)}`);
    }
  };

  const formatDistance = (m: number): string => {
    if (!isFinite(m)) return "--";
    return m < 1000 ? `${Math.round(m)} م` : `${(m / 1000).toFixed(1)} كم`;
  };

  const gpsDenied = !gpsLocation;

  // ── Block Android browser: show friendly redirect screen ──────────────────
  if (isAndroidBrowser) {
    return (
      <div style={{
        minHeight: "100svh",
        background: "#111417",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 24px",
        textAlign: "center",
        gap: 20,
        color: "#fff",
        fontFamily: "'Cairo', sans-serif",
      }}>
        <div style={{
          width: 80, height: 80, borderRadius: "50%",
          background: "linear-gradient(135deg, #1a2236, #0fa5f833)",
          border: "2px solid #0fa5f8",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 40, marginBottom: 8,
        }}>
          📱
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          استخدم التطبيق على أندرويد
        </h2>
        <p style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", lineHeight: 1.8, maxWidth: 300 }}>
          هذا الرابط مخصص لمستخدمي iPhone فقط.
          على أندرويد، يجب استخدام <strong style={{ color: "#0fa5f8" }}>التطبيق المُثبَّت</strong> على هاتفك للتسجيل.
        </p>
        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginTop: 8 }}>
          إذا واجهت مشكلة، تواصل مع مديرك المباشر.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="blue-dot-map-page">
        {/* ── الخريطة الحقيقية ── */}
        {view === "map" && (
          <div className="absolute inset-0">
            <MapView
              initialCenter={{ lat: 30.0444, lng: 31.2357 }}
              initialZoom={gpsLocation ? 16 : 11}
              flyTo={fly}
              flyToZoom={16}
              className="h-full w-full"
            >
              {branchesWithDistance.map((b: any) =>
                b.latitude && b.longitude ? (
                  <GeofenceCircle
                    key={`c-${b.id}`}
                    lat={parseFloat(b.latitude)}
                    lng={parseFloat(b.longitude)}
                    radiusMeters={b.geofenceRadiusMeters || 200}
                    color="#0fa5f8"
                    inRange={b.inRange}
                  />
                ) : null
              )}
              {branchesWithDistance.map((b: any) =>
                b.latitude && b.longitude ? (
                  <MapMarker
                    key={`m-${b.id}`}
                    lat={parseFloat(b.latitude)}
                    lng={parseFloat(b.longitude)}
                    label={`${b.inRange ? "✅" : ""} ${b.name}`}
                    color={activeVisit?.branchId === b.id ? "#34d399" : "#0fa5f8"}
                  />
                ) : null
              )}
              {gpsLocation && (
                <MapMarker lat={gpsLocation.lat} lng={gpsLocation.lon} label="أنت" color="#f59e0b" />
              )}
            </MapView>
          </div>
        )}

        {/* ── قائمة الفروع ── */}
        {view === "list" && (
          <div className="branches-scroll">
            {sortedBranches.map((b: any) => (
              <div key={b.id} className="branch-row">
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 26, color: b.inRange ? "#34d399" : "rgba(255,255,255,0.35)" }}
                >
                  {b.status === "visited" ? "check_circle" : b.inRange ? "location_on" : "location_off"}
                </span>
                <div className="branch-row-info">
                  <h4>{b.name}</h4>
                  <p>{b.address || formatDistance(b.distanceM)}</p>
                </div>
                <span
                  className="dist-chip"
                  style={{
                    background: b.inRange ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.06)",
                    color: b.inRange ? "#34d399" : "rgba(255,255,255,0.55)",
                  }}
                >
                  {formatDistance(b.distanceM)}
                </span>
                {!activeVisit && b.inRange && (
                  <button
                    className="mini-checkin-btn"
                    onClick={() => openCheckInModal(b.id)}
                    disabled={checkInMutation.isPending}
                  >
                    دخول
                  </button>
                )}
              </div>
            ))}
            {sortedBranches.length === 0 && (
              <p style={{ textAlign: "center", marginTop: 60, fontSize: 13, color: "rgba(255,255,255,0.4)" }}>
                مفيش فروع مسندة لك حالياً
              </p>
            )}
          </div>
        )}

        {/* ── شريط علوي ── */}
        <div className="top-bar">
          <Link href="/">
            <a className="icon-btn">
              <span className="material-symbols-outlined">arrow_forward</span>
            </a>
          </Link>
          <div className="top-bar-title">الفروع القريبة</div>
          <button
            className={`sidebar-btn ${view === "list" ? "active" : ""}`}
            style={{ width: 40, height: 40 }}
            onClick={() => setView(view === "list" ? "map" : "list")}
            title="تبديل بين الخريطة والقائمة"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
              {view === "list" ? "map" : "list"}
            </span>
          </button>
        </div>

        {/* حالة الـ GPS الحقيقية */}
        {view === "map" && gpsLocation && (
          <div className="gps-chip">
            <span style={{ color: "#34d399" }}>●</span>
            دقة الموقع
            <span style={{ color: "#fff", fontFamily: "monospace" }}>
              ±{latestLocation?.accuracy ? Math.round(latestLocation.accuracy) : "?"} م
            </span>
          </div>
        )}

        {/* زر المأمورية الخارجية - يظهر دائمًا */}
        {!activeVisit && gpsLocation && (
          <button
            className="external-mission-btn"
            onClick={openExternalMissionModal}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>explore</span>
            مأمورية خارجية
          </button>
        )}

        {/* زرار موقعي */}
        {view === "map" && (
          <div className="floating-sidebar">
            <button
              className="sidebar-btn"
              onClick={() => {
                if (gpsLocation) {
                  setFly({ lat: gpsLocation.lat, lng: gpsLocation.lon });
                  toast.info("تم تثبيت الخريطة على موقعك");
                } else {
                  toast.error("لسه بنحدد موقعك — استنى ثواني");
                }
              }}
              title="موقعي"
            >
              <span className="material-symbols-outlined">my_location</span>
            </button>
          </div>
        )}

        {/* أوفرلاي انتظار/مشكلة الـ GPS — يختفي لو في زيارة نشطة */}
        {view === "map" && !gpsLocation && !activeVisit && (
          <div className="map-overlay-gps">
            <Loader2 className="w-8 h-8 animate-spin text-[#0fa5f8]" />
            <p style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>جاري تحديد موقعك...</p>
            <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", margin: 0, lineHeight: 1.8 }}>
              لو استغرق وقت طويل، اتأكد إن صلاحية الموقع مفتوحة للتطبيق<br />
              (الإعدادات ← التطبيقات ← Branch Tracker ← الأذونات ← الموقع)
            </p>
          </div>
        )}

        {/* ── الكارت السفلي ── */}
        <div className="bottom-card-container">
          <div className="check-in-card">
            <div className="card-header">
              <div className="branch-info">
                <h2>
                  {activeVisit
                    ? (activeVisit.branchName || "مأمورية خارجية")
                    : (closestBranch?.name || "مفيش فروع قريبة")}
                </h2>
                <p>
                  {gpsLocation
                    ? activeVisit
                      ? `انت مسجل حالياً في ${activeVisit.branchName || "مأمورية خارجية"}${activeVisit.visitType === "external_mission" ? ` • نطاق تلقائي ${activeVisit.missionRadiusMeters ?? 200}م` : ""}`
                      : closestBranch?.inRange
                        ? "✅ انت داخل نطاق الفرع — تقدر تسجل دخول"
                        : `أقرب فرع على بعد ${formatDistance(closestBranch?.distanceM ?? Infinity)}`
                    : "في وضعية تحديد الموقع..."}
                </p>
              </div>
            </div>

            {activeVisit ? (
              <button
                className="action-button btn-red"
                onClick={handleManualCheckOutClick}
                disabled={checkOutMutation.isPending}
              >
                {checkOutMutation.isPending ? <Loader2 className="animate-spin" /> : "تسجيل الخروج"}
              </button>
            ) : (
              <button
                className="action-button btn-cyan"
                onClick={() => closestBranch && openCheckInModal(closestBranch.id)}
                disabled={!closestBranch || !closestBranch.inRange || checkInMutation.isPending}
                title={!closestBranch?.inRange ? "لازم تكون داخل نطاق الفرع الأول" : ""}
              >
                {checkInMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : closestBranch?.inRange ? (
                  "تسجيل الدخول هنا"
                ) : (
                  "اقترب من الفرع لتسجيل الدخول"
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* مودال النوتس */}
      <NotesModal
        open={notesModalState.isOpen}
        type={notesModalState.type}
        visitNotes={visitNotes}
        onVisitNotesChange={setVisitNotes}
        onClose={() => setNotesModalState({ ...notesModalState, isOpen: false })}
        onSubmit={submitModal}
        isPending={checkInMutation.isPending || checkOutMutation.isPending}
      />

    </>
  );
}
