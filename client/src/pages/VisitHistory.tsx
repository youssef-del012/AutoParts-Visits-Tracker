import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";

const PAGE_SIZE = 50;

type TabKey = "all" | "active" | "done";

export default function VisitHistory() {
  const { user } = useAuth();
  // صورة المدير بتتخزن في جدول managers مش users
  const { data: managerProfile } = trpc.manager.getCurrentManager.useQuery();
  const phone = managerProfile?.phone ?? null;

  const [tab, setTab] = useState<TabKey>("all");
  const [offset, setOffset] = useState(0);

  const { data: visitsData, isLoading } = trpc.visit.myHistory.useQuery({
    limit: PAGE_SIZE,
    offset,
  }, { staleTime: 30_000 });
  const total = visitsData?.total ?? 0;
  // ✅ عدّادات التبويبات جاية من السيرفر (conditional counts) — مش من الصفحات المحمّلة بس
  const activeCount = visitsData?.activeCount ?? 0;
  const doneCount = visitsData?.doneCount ?? 0;

  // نراكم الصفحات بدل ما نستبدلها — عشان "تحميل المزيد" يضيف صفوف مش يمسحها
  const [allVisits, setAllVisits] = useState<any[]>([]);
  useEffect(() => {
    const fresh = (visitsData?.items ?? []) as any[];
    if (fresh.length === 0) return;
    if (offset === 0) {
      setAllVisits(fresh);
      return;
    }
    setAllVisits((prev) => {
      const seen = new Set(prev.map((v) => v.id));
      return [...prev, ...fresh.filter((v) => !seen.has(v.id))];
    });
  }, [visitsData, offset]);

  const hasMore = allVisits.length < total;

  // ── فلترة حسب التبويب (شغالة فعلاً) ─────────────────────────────────────────
  const visits =
    tab === "active"
      ? allVisits.filter((v) => v.status === "checked_in")
      : tab === "done"
        ? allVisits.filter((v) => v.status === "checked_out")
        : allVisits;

  return (
    <>
      <style>{`
        .blue-dot-history {
          min-height: 100svh;
          background-color: #111417;
          color: #ffffff;
          font-family: 'Cairo', 'Inter', sans-serif;
          padding: 20px;
          padding-top: calc(20px + env(safe-area-inset-top, 0px));
          padding-bottom: 100px;
        }

        .header-section h1 {
          font-size: 24px; font-weight: 700; margin: 20px 0 4px;
        }
        .header-section p { font-size: 12px; color: rgba(255,255,255,0.5); margin: 0; }

        .wallet-card {
          background: linear-gradient(135deg, rgba(15,165,248,0.2) 0%, rgba(30,34,40,0.8) 100%);
          border: 1px solid rgba(15,165,248,0.2);
          border-radius: 20px;
          padding: 24px;
          margin-top: 20px;
          margin-bottom: 20px;
          position: relative;
          overflow: hidden;
        }
        .card-user-info h3 { font-size: 15px; font-weight: 700; margin: 12px 0 2px; }
        .card-user-info p { font-size: 11px; color: rgba(255,255,255,0.5); margin: 0; }
        .card-stats { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 16px; }
        .card-stats h4 { font-size: 11px; color: rgba(255,255,255,0.6); margin: 0 0 4px; font-weight: 500; }
        .card-stats .value { font-size: 24px; font-weight: 700; }

        /* ── التبويبات الشغالة ── */
        .tabs { display: flex; background: rgba(30,34,40,0.6); border-radius: 12px; padding: 4px; margin-bottom: 16px; }
        .tab {
          flex: 1; text-align: center; padding: 10px 0;
          font-size: 13px; font-weight: 700; border-radius: 8px;
          cursor: pointer; color: rgba(255,255,255,0.5);
          transition: all 0.2s; border: none; background: transparent;
        }
        .tab.active { background: #0fa5f8; color: #fff; }

        .history-item {
          display: flex; align-items: center; gap: 12px;
          background: rgba(30,34,40,0.5);
          border: 1px solid rgba(255,255,255,0.04);
          border-radius: 16px;
          padding: 14px;
          margin-bottom: 10px;
        }
        .visit-photo-thumb {
          width: 48px; height: 48px;
          border-radius: 12px;
          object-fit: cover;
          border: 1px solid rgba(15,165,248,0.35);
          cursor: pointer;
          flex-shrink: 0;
          background: rgba(15,165,248,0.08);
        }
        .no-photo-icon {
          width: 48px; height: 48px; border-radius: 12px;
          background: rgba(255,255,255,0.05);
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .item-details { flex: 1; min-width: 0; }
        .item-details h4 { font-size: 14px; font-weight: 700; margin: 0 0 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .item-details p { font-size: 11px; color: rgba(255,255,255,0.45); margin: 0; }
        .item-status { text-align: left; flex-shrink: 0; }
        .item-status .time { font-size: 12px; font-weight: 700; margin-bottom: 4px; display: block; }
        .item-status .tag { font-size: 10px; padding: 3px 9px; border-radius: 6px; font-weight: 700; }

        .load-more-btn {
          width: 100%;
          padding: 13px;
          border-radius: 14px;
          border: 1px solid rgba(15,165,248,0.35);
          background: rgba(15,165,248,0.08);
          color: #0fa5f8;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          margin-top: 6px;
        }


      `}</style>

      <div className="blue-dot-history">
        <div className="header-section">
          <h1>سجل الزيارات</h1>
          <p>كل تحركاتك المسجلة في الفروع</p>
        </div>

        {/* ── كارت الملخص ── */}
        <div className="wallet-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#0fa5f8' }}>badge</span>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(15,165,248,0.1)', border: '1px solid rgba(15,165,248,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0fa5f8', fontWeight: 'bold', fontSize: 22 }}>
              {(user?.name || user?.username || "م").charAt(0)}
            </div>
          </div>
          <div className="card-user-info">
            <h3>{user?.name || user?.username || "مدير"}</h3>
            {phone && <p>{phone}</p>}
          </div>
          <div className="card-stats">
            <div>
              <h4>إجمالي الزيارات</h4>
              <div className="value">{total} <span style={{ fontSize: 14, fontWeight: 500 }}>زيارة</span></div>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              {format(new Date(), "d MMMM yyyy", { locale: ar })}
            </div>
          </div>
        </div>

        {/* ── التبويبات الشغالة فعلاً ── */}
        <div className="tabs">
          <button className={`tab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>
            الكل ({total})
          </button>
          <button className={`tab ${tab === "active" ? "active" : ""}`} onClick={() => setTab("active")}>
            جارية ({activeCount})
          </button>
          <button className={`tab ${tab === "done" ? "active" : ""}`} onClick={() => setTab("done")}>
            منتهية ({doneCount})
          </button>
        </div>

        {/* ── القائمة ── */}
        {isLoading && offset === 0 ? (
          <div style={{ textAlign: "center", marginTop: 60 }}>
            <Loader2 className="w-7 h-7 animate-spin text-[#0fa5f8] mx-auto" />
          </div>
        ) : visits.length === 0 ? (
          <div style={{ textAlign: "center", marginTop: 50, color: "rgba(255,255,255,0.35)" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 44 }}>event_note</span>
            <p style={{ fontSize: 13, marginTop: 8 }}>
              {tab === "active" ? "مفيش زيارات جارية دلوقتي" : tab === "done" ? "مفيش زيارات منتهية" : "لسه مفيش سجل — ابدأ أول زيارة!"}
            </p>
          </div>
        ) : (
          <>
            {visits.map((visit: any) => {
              const checkInTime = new Date(visit.checkInAt);
              const checkOutTime = visit.checkOutAt ? new Date(visit.checkOutAt) : null;
              const durationMin = checkOutTime
                ? Math.round((checkOutTime.getTime() - checkInTime.getTime()) / 60000)
                : null;
              return (
                <div key={visit.id} className="history-item">
                  <div className="no-photo-icon">
                    <span
                      className="material-symbols-outlined"
                      style={{
                        fontSize: 22,
                        color: visit.visitType === "external_mission"
                          ? "rgba(139,92,246,0.7)"
                          : "rgba(255,255,255,0.25)",
                      }}
                    >
                      {visit.visitType === "external_mission" ? "explore" : "store"}
                    </span>
                  </div>
                  <div className="item-details">
                    <h4>{visit.branchName ?? "مأمورية خارجية"}</h4>
                    <p>
                      {format(checkInTime, "EEEE d MMMM", { locale: ar })}
                      {durationMin !== null && ` • ${durationMin >= 60 ? `${Math.floor(durationMin / 60)} س ${durationMin % 60} د` : `${durationMin} دقيقة`}`}
                      {visit.distanceToPrevBranchKm != null && ` • ${parseFloat(visit.distanceToPrevBranchKm).toFixed(1)} كم`}
                    </p>
                    <div>
                      {visit.visitType === "external_mission" && (
                        <span className="tag" style={{ background: "rgba(139,92,246,0.12)", color: "#8b5cf6", marginTop: 4, display: "inline-block", marginLeft: 6 }}>مأمورية خارجية</span>
                      )}
                      {visit.noteType === "short_visit" && (
                        <span className="tag" style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b", marginTop: 4, display: "inline-block", marginLeft: 6 }}>زيارة قصيرة</span>
                      )}
                    </div>
                    {visit.notes && (
                      <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.05)', padding: '8px 10px', borderRadius: 8, borderLeft: '3px solid #0fa5f8', whiteSpace: 'pre-wrap' }}>
                        {visit.notes}
                      </div>
                    )}
                  </div>
                  <div className="item-status">
                    <span className="time">{format(checkInTime, "hh:mm a")}</span>
                    <span
                      className="tag"
                      style={{
                        background: visit.status === "checked_in" ? "rgba(245,158,11,0.12)" : "rgba(52,211,153,0.12)",
                        color: visit.status === "checked_in" ? "#f59e0b" : "#34d399",
                      }}
                    >
                      {visit.status === "checked_in" ? "جارية الآن" : "تمت"}
                    </span>
                  </div>
                </div>
              );
            })}

            {hasMore && (
              <button
                className="load-more-btn"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={isLoading}
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : `تحميل المزيد (${total - allVisits.length} متبقية)`}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
