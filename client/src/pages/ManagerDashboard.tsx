import { useAuth } from "@/_core/hooks/useAuth";
import { Link } from "wouter";
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { SERVER_BASE_URL } from "@/lib/config";


function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h} س ${m} د`;
  return `${m} دقيقة`;
}

export default function ManagerDashboard() {
  const { user } = useAuth();
  // صورة المدير بتتخزن في جدول managers مش users
  const { data: managerProfile } = trpc.manager.getCurrentManager.useQuery();
  const photoUrl = managerProfile?.photoUrl ?? null;

  // ── البيانات الحقيقية من السيرفر ────────────────────────────────────────────
  const { data: visitsData } = trpc.visit.myHistory.useQuery({ limit: 200, offset: 0 }, { staleTime: 30_000 });
  const { data: branches = [] } = trpc.manager.getMyBranches.useQuery(undefined, { staleTime: 5 * 60 * 1000 });

  // مؤقت حي لتحديث مدة الزيارة الحالية كل دقيقة
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── حسابات اليوم الفعلية ────────────────────────────────────────────────────
  const visits = (visitsData?.items ?? []) as any[];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayVisits = visits.filter((v) => new Date(v.checkInAt) >= todayStart);
  const visitsToday = todayVisits.length;
  const distanceTodayKm = todayVisits.reduce(
    (acc, v) => acc + (v.distanceToPrevBranchKm != null ? parseFloat(v.distanceToPrevBranchKm) : 0),
    0
  );
  const targetCount = Math.max(branches.length, 1);
  const progressPct = Math.min(100, Math.round((visitsToday / targetCount) * 100));

  // الزيارة الحالية المفتوحة — أهم معلومة في الشاشة
  const activeVisit = visits.find((v: any) => v.status === "checked_in") ?? null;
  const activeVisitDuration =
    activeVisit ? formatDuration(now - new Date(activeVisit.checkInAt).getTime()) : "";

  return (
    <>
      <style>{`
        .blue-dot-dashboard {
          min-height: 100svh;
          background-color: #111417; /* Deep black/gray */
          color: #ffffff;
          font-family: 'Inter', 'Fira Sans', sans-serif;
          position: relative;
          overflow-y: auto;
          overflow-x: hidden;
          padding-bottom: 100px;
        }

        /* Top Cyan Glow */
        .dashboard-glow {
          position: absolute;
          top: -100px;
          right: -50px;
          width: 300px;
          height: 300px;
          background: radial-gradient(circle, rgba(15,165,248,0.25) 0%, rgba(15,165,248,0) 70%);
          border-radius: 50%;
          pointer-events: none;
          z-index: 0;
        }

        .header-section {
          padding: 40px 24px 20px;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          position: relative;
          z-index: 1;
        }

        .greeting h2 {
          font-size: 16px;
          font-weight: 400;
          color: rgba(255,255,255,0.8);
          margin: 0 0 4px 0;
        }
        .greeting h1 {
          font-size: 28px;
          font-weight: 700;
          margin: 0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .notification-btn {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          background: rgba(30, 34, 40, 0.6);
          border: 1px solid rgba(255,255,255,0.05);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #0fa5f8;
          cursor: pointer;
        }

        .hero-banner {
          position: relative;
          margin: 0 24px 30px;
          height: 160px;
          background: linear-gradient(135deg, rgba(30, 34, 40, 0.8) 0%, rgba(30, 34, 40, 0.2) 100%);
          border-radius: 20px;
          border: 1px solid rgba(255,255,255,0.05);
          display: flex;
          align-items: center;
          padding: 20px;
          z-index: 1;
          overflow: hidden;
        }
        
        /* Simulating the car image from the design with an icon for now, 
           since we don't have a 3D auto parts asset */
        .hero-icon {
          font-size: 80px;
          color: rgba(15,165,248,0.15);
          position: absolute;
          right: -10px;
          bottom: -10px;
        }

        .hero-content {
          position: relative;
          z-index: 2;
        }
        .hero-content h3 {
          font-size: 20px;
          font-weight: 600;
          margin: 0 0 8px 0;
        }
        .hero-content p {
          font-size: 12px;
          color: rgba(255,255,255,0.6);
          margin: 0;
          max-width: 60%;
          line-height: 1.4;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          padding: 0 24px;
          margin-bottom: 30px;
          z-index: 1;
          position: relative;
        }

        .stat-card {
          background: rgba(30, 34, 40, 0.6);
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 20px;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .stat-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          color: rgba(255,255,255,0.6);
        }
        .stat-value {
          font-size: 24px;
          font-weight: 700;
          display: flex;
          align-items: flex-end;
          gap: 4px;
        }
        .stat-unit {
          font-size: 12px;
          font-weight: 400;
          color: rgba(255,255,255,0.5);
          margin-bottom: 4px;
        }

        .stat-bar {
          width: 100%;
          height: 6px;
          background: rgba(255,255,255,0.1);
          border-radius: 3px;
          overflow: hidden;
          margin-top: auto;
        }
        .stat-progress {
          height: 100%;
          background: #34d399; /* Green like battery */
          border-radius: 3px;
        }

        .actions-list {
          padding: 0 24px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          z-index: 1;
          position: relative;
        }

        .action-item {
          background: rgba(30, 34, 40, 0.6);
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 16px;
          padding: 16px;
          display: flex;
          align-items: center;
          gap: 16px;
          text-decoration: none;
          color: #fff;
          transition: background 0.2s;
        }
        .action-item:hover {
          background: rgba(30, 34, 40, 0.8);
        }
        .action-icon {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          background: rgba(15,165,248,0.1);
          color: #0fa5f8;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .action-text {
          font-size: 15px;
          font-weight: 500;
          flex: 1;
        }
        
        .fade-up {
          animation: fadeUp 0.4s ease-out forwards;
          opacity: 0;
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(15px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="blue-dot-dashboard">
        <div className="dashboard-glow" />

        <header className="header-section fade-up" style={{ animationDelay: '0s', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center', width: '100%' }}>
            {photoUrl ? (
              <img
                src={photoUrl.startsWith('http') ? photoUrl : `${SERVER_BASE_URL}${photoUrl}`}
                alt="Profile"
                style={{ width: '100px', height: '100px', borderRadius: '50%', border: '2px solid rgba(15,165,248,0.5)', objectFit: 'cover' }}
              />
            ) : (
              <div style={{ width: '100px', height: '100px', borderRadius: '50%', background: 'rgba(15,165,248,0.1)', border: '2px solid rgba(15,165,248,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0fa5f8', fontSize: '40px', fontWeight: 'bold' }}>
                {user?.username?.charAt(0).toUpperCase() || "U"}
              </div>
            )}
            <div className="greeting">
              <h1 style={{ textTransform: 'none', letterSpacing: 0 }}>{user?.name || user?.username || "مدير"}</h1>
            </div>
          </div>
        </header>

        {/* ── 🟢 كارت الزيارة الحالية — أهم معلومة في الشاشة ─────────────────── */}
        {activeVisit && (
          <Link
            href="/check-in"
            className="fade-up"
            style={{
              display: "block",
              margin: "0 24px 20px",
              padding: "18px 20px",
              background: activeVisit.visitType === "external_mission"
                ? "linear-gradient(135deg, rgba(139,92,246,0.18) 0%, rgba(30,34,40,0.9) 100%)"
                : activeVisit.status === 'checked_in'
                  ? "linear-gradient(135deg, rgba(52,211,153,0.15) 0%, rgba(30,34,40,0.9) 100%)"
                  : "rgba(30,34,40,0.8)",
              border: activeVisit.visitType === "external_mission"
                ? "1px solid rgba(139,92,246,0.4)"
                : "1px solid rgba(52,211,153,0.4)",
              borderRadius: 20,
              textDecoration: "none",
              color: "#fff",
              position: "relative",
              zIndex: 1,
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span
                className="relative flex h-3 w-3"
                style={{ flexShrink: 0 }}
              >
                <span
                  className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                  style={{ background: activeVisit.visitType === "external_mission" ? "#8b5cf6" : "#34d399" }}
                />
                <span
                  className="relative inline-flex rounded-full h-3 w-3"
                  style={{ background: activeVisit.visitType === "external_mission" ? "#8b5cf6" : "#34d399" }}
                />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>
                  {activeVisit.visitType === "external_mission"
                    ? "مأمورية خارجية جارية"
                    : "زيارتك الحالية — داخل النطاق"}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {activeVisit.visitType === "external_mission"
                    ? (activeVisit.notes ? activeVisit.notes.slice(0, 40) : "مأمورية خارجية")
                    : (activeVisit.branchName ?? "فرع غير محدد")}
                </div>
              </div>
              <div style={{ textAlign: "center", flexShrink: 0 }}>
                <div style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: activeVisit.visitType === "external_mission" ? "#8b5cf6" : "#34d399",
                }}>
                  {activeVisitDuration}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>منذ الدخول</div>
              </div>
            </div>
          </Link>
        )}


        {/* ── 📊 إحصائيات اليوم — من الداتا الحقيقية ────────────────────────── */}
        <div className="stats-grid fade-up" style={{ animationDelay: '0.2s' }}>
          <div className="stat-card">
            <div className="stat-header">
              <span>زيارات اليوم</span>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>place</span>
            </div>
            <div className="stat-value">
              {visitsToday} <span className="stat-unit">من {branches.length}</span>
            </div>
            <div className="stat-bar">
              <div className="stat-progress" style={{ width: `${progressPct}%` }} />
            </div>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
              فروعك المسندة النهاردة
            </span>
          </div>

          <div className="stat-card">
            <div className="stat-header">
              <span>المسافة</span>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>route</span>
            </div>
            <div className="stat-value">
              {distanceTodayKm.toFixed(1)} <span className="stat-unit">كم</span>
            </div>
            <div className="stat-bar">
              <div
                className="stat-progress"
                style={{
                  width: `${Math.min(100, Math.round((distanceTodayKm / 100) * 100))}%`,
                  background: '#0fa5f8',
                }}
              />
            </div>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>إجمالي تحركاتك اليوم</span>
          </div>
        </div>

        <div className="actions-list fade-up" style={{ animationDelay: '0.3s' }}>
          <Link href="/check-in" className="action-item">
            <div className="action-icon">
              <span className="material-symbols-outlined">location_on</span>
            </div>
            <span className="action-text">الفروع وتسجيل الحضور</span>
            <span className="material-symbols-outlined" style={{ color: 'rgba(255,255,255,0.3)' }}>chevron_left</span>
          </Link>

          <Link href="/history" className="action-item">
            <div className="action-icon">
              <span className="material-symbols-outlined">history</span>
            </div>
            <span className="action-text">سجل الزيارات</span>
            <span className="material-symbols-outlined" style={{ color: 'rgba(255,255,255,0.3)' }}>chevron_left</span>
          </Link>

          <Link href="/sync" className="action-item">
            <div className="action-icon" style={{ background: 'rgba(255,255,255,0.05)', color: '#fff' }}>
              <span className="material-symbols-outlined">sync</span>
            </div>
            <span className="action-text">مركز المزامنة</span>
            <span className="material-symbols-outlined" style={{ color: 'rgba(255,255,255,0.3)' }}>chevron_left</span>
          </Link>
        </div>
      </div>
    </>
  );
}
