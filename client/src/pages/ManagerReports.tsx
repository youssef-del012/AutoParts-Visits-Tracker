import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { format, subMonths, addMonths, setDate } from "date-fns";
import { ar } from "date-fns/locale";
import { useAuth } from "@/_core/hooks/useAuth";
import * as XLSX from "xlsx";

function durationMin(checkIn: any, checkOut: any): number {
  if (!checkOut) return 0;
  return Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 60000);
}
function fmtDuration(min: number): string {
  if (min === 0) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} س ${m} د` : `${m} دقيقة`;
}

function exportToExcel(visits: any[], managerName: string, startDate: string, endDate: string) {
  const wb = XLSX.utils.book_new();
  const exportDate = format(new Date(), "yyyy-MM-dd HH:mm a", { locale: ar });
  const rows: any[][] = [
    ["تقرير الزيارات الشهري"],
    [],
    ["تاريخ الاستخراج:", exportDate],
    ["الفترة:", `من ${startDate || "—"} إلى ${endDate || "—"}`],
    ["المدير:", managerName],
    ["إجمالي الزيارات:", visits.length],
    [],
    ["التاريخ","اليوم","الفرع","كود","دخول","خروج","المدة","الحالة","المسافة","ملاحظات"],
  ];
  const sorted = [...visits].sort((a,b)=>new Date(a.checkInAt).getTime()-new Date(b.checkInAt).getTime());
  let lastDate = "";
  sorted.forEach(v => {
    const vDate = format(new Date(v.checkInAt),"yyyy-MM-dd");
    const dur = durationMin(v.checkInAt, v.checkOutAt);
    if (lastDate !== "" && lastDate !== vDate) rows.push([]);
    lastDate = vDate;
    rows.push([
      vDate,
      format(new Date(v.checkInAt),"EEEE",{locale:ar}),
      v.branchName ?? "مأمورية خارجية",
      v.branchCode ?? "—",
      format(new Date(v.checkInAt),"hh:mm a"),
      v.checkOutAt ? format(new Date(v.checkOutAt),"hh:mm a") : "لم يغادر",
      v.checkOutAt ? fmtDuration(dur) : "—",
      v.status === "checked_in" ? "جارية" : "مكتملة",
      v.distanceToPrevBranchKm != null ? parseFloat(v.distanceToPrevBranchKm).toFixed(1) + " كم" : "—",
      v.notes ?? "—",
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{wch:14},{wch:12},{wch:28},{wch:12},{wch:12},{wch:12},{wch:15},{wch:12},{wch:12},{wch:35}];
  XLSX.utils.book_append_sheet(wb, ws, "سجل الزيارات");
  XLSX.writeFile(wb, `تقرير_الزيارات_${startDate}_${endDate}.xlsx`);
}

export default function ManagerReports() {
  const { user } = useAuth();
  const now = new Date();
  const currentDay = now.getDate();
  const defaultStart = currentDay < 20
    ? format(setDate(subMonths(now,1),20),"yyyy-MM-dd")
    : format(setDate(now,20),"yyyy-MM-dd");
  const defaultEnd = currentDay < 20
    ? format(setDate(now,20),"yyyy-MM-dd")
    : format(setDate(addMonths(now,1),20),"yyyy-MM-dd");

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [exporting, setExporting] = useState(false);

  const { data, isLoading } = trpc.visit.myReport.useQuery({
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    limit: 500,
    offset: 0,
  });

  const visits = useMemo(() => (data?.items ?? []) as any[], [data]);
  const total = data?.total ?? 0;

  const totalMin = visits.filter(v=>v.checkOutAt).reduce((acc,v)=>acc+durationMin(v.checkInAt,v.checkOutAt),0);
  const totalDistanceKm = visits.reduce(
    (acc, v) => acc + (v.distanceToPrevBranchKm != null ? parseFloat(v.distanceToPrevBranchKm) : 0),
    0
  );

  const dayMap = new Map<string, any[]>();
  visits.forEach(v => {
    const d = format(new Date(v.checkInAt),"yyyy-MM-dd");
    if (!dayMap.has(d)) dayMap.set(d,[]);
    dayMap.get(d)!.push(v);
  });
  const days = Array.from(dayMap.entries())
    .sort((a,b)=>b[0].localeCompare(a[0]))
    .map(([date,dayVisits])=>({ date, visits: dayVisits.sort((a,b)=>new Date(a.checkInAt).getTime()-new Date(b.checkInAt).getTime()) }));

  const handleExport = () => {
    if (!visits.length) return;
    setExporting(true);
    try { exportToExcel(visits, user?.name ?? user?.username ?? "المدير", startDate, endDate); }
    finally { setTimeout(() => setExporting(false), 500); }
  };

  return (
    <>
      <style>{`
        .mgr-reports {
          min-height:100svh; background:#111417; color:#fff;
          font-family:'Cairo','Inter',sans-serif;
          padding:20px;
          padding-top:calc(20px + env(safe-area-inset-top,0px));
          padding-bottom:110px;
        }
        .mgr-header { margin-bottom:20px; }
        .mgr-header h1 { font-size:24px; font-weight:700; margin:16px 0 4px; }
        .mgr-header p { font-size:12px; color:rgba(255,255,255,0.45); margin:0; }
        .filter-card {
          background:rgba(30,34,40,0.7); border:1px solid rgba(255,255,255,0.07);
          border-radius:18px; padding:18px; margin-bottom:16px;
          display:flex; flex-direction:column; gap:12px;
        }
        .filter-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .filter-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:rgba(255,255,255,0.4); margin-bottom:5px; }
        .filter-input { width:100%; height:44px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:12px; color:#fff; font-size:13px; padding:0 12px; outline:none; box-sizing:border-box; }
        .filter-input:focus { border-color:#0fa5f8; }
        .export-btn { width:100%; height:48px; background:linear-gradient(135deg,#0fa5f8,#0d8ed6); border:none; border-radius:14px; color:#fff; font-size:14px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; transition:opacity 0.2s; font-family:'Cairo',sans-serif; }
        .export-btn:disabled { opacity:0.45; cursor:default; }
        .stats-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px; }
        .stat-card { background:rgba(30,34,40,0.6); border:1px solid rgba(255,255,255,0.06); border-radius:16px; padding:16px; }
        .stat-value { font-size:22px; font-weight:700; line-height:1; margin:6px 0 4px; }
        .stat-label { font-size:10px; color:rgba(255,255,255,0.45); font-weight:600; }
        .day-group { background:rgba(30,34,40,0.5); border:1px solid rgba(255,255,255,0.06); border-radius:18px; overflow:hidden; margin-bottom:10px; }
        .day-header { display:flex; align-items:center; gap:14px; padding:14px 16px; background:rgba(255,255,255,0.02); border-bottom:1px solid rgba(255,255,255,0.05); }
        .day-badge { width:44px; height:44px; border-radius:12px; background:rgba(15,165,248,0.12); border:1px solid rgba(15,165,248,0.25); display:flex; flex-direction:column; align-items:center; justify-content:center; flex-shrink:0; }
        .day-num { font-size:18px; font-weight:700; color:#0fa5f8; line-height:1; }
        .day-name-small { font-size:9px; color:rgba(15,165,248,0.7); font-weight:600; }
        .day-info h4 { font-size:13px; font-weight:700; margin:0 0 2px; }
        .day-info p { font-size:11px; color:rgba(255,255,255,0.4); margin:0; }
        .visit-row { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.04); }
        .visit-row:last-child { border-bottom:none; }
        .visit-icon { width:36px; height:36px; border-radius:10px; background:rgba(15,165,248,0.08); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .visit-det { flex:1; min-width:0; }
        .visit-det h5 { font-size:13px; font-weight:700; margin:0 0 2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .visit-det p { font-size:11px; color:rgba(255,255,255,0.4); margin:0; }
        .visit-stat { text-align:left; flex-shrink:0; }
        .visit-time-txt { font-size:12px; font-weight:700; display:block; margin-bottom:3px; }
        .vtag { font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px; display:inline-block; margin-top:3px; }
      `}</style>

      <div className="mgr-reports">
        <div className="mgr-header">
          <span className="material-symbols-outlined" style={{fontSize:28,color:"#0fa5f8"}}>bar_chart</span>
          <h1>تقاريري</h1>
          <p>سجل زياراتك — اسحب تقريرك الشهري بفلتر التاريخ</p>
        </div>

        <div className="filter-card">
          <div className="filter-row">
            <div>
              <div className="filter-label">من تاريخ</div>
              <input type="date" className="filter-input" value={startDate} onChange={e=>setStartDate(e.target.value)} />
            </div>
            <div>
              <div className="filter-label">إلى تاريخ</div>
              <input type="date" className="filter-input" value={endDate} onChange={e=>setEndDate(e.target.value)} />
            </div>
          </div>
          <button className="export-btn" onClick={handleExport} disabled={exporting||visits.length===0||isLoading}>
            {exporting ? "⟳ جاري التصدير..." : "📊 تصدير Excel"}
          </button>
        </div>

        <div className="stats-grid">
          {[
            {icon:"location_on",label:"إجمالي الزيارات",value:isLoading?"...":total,color:"#0fa5f8"},
            {icon:"calendar_month",label:"أيام العمل",value:isLoading?"...":days.length,color:"#34d399"},
            {icon:"schedule",label:"مجموع الوقت",value:isLoading?"...":fmtDuration(totalMin),color:"#f59e0b"},
            {icon:"directions_car",label:"إجمالي المسافة",value:isLoading?"...":totalDistanceKm>0?totalDistanceKm.toFixed(1)+" كم":"—",color:"#a78bfa"},
          ].map(s=>(
            <div key={s.label} className="stat-card">
              <span className="material-symbols-outlined" style={{fontSize:22,color:s.color,fontVariationSettings:"'FILL' 1"}}>{s.icon}</span>
              <div className="stat-value" style={{color:s.color}}>{s.value}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div style={{textAlign:"center",marginTop:60,color:"rgba(255,255,255,0.35)"}}>
            <span className="material-symbols-outlined" style={{fontSize:40,animation:"spin 1s linear infinite"}}>autorenew</span>
            <p style={{fontSize:12,marginTop:10}}>جاري التحميل...</p>
          </div>
        ) : days.length===0 ? (
          <div style={{textAlign:"center",marginTop:50,color:"rgba(255,255,255,0.35)"}}>
            <span className="material-symbols-outlined" style={{fontSize:44}}>bar_chart</span>
            <p style={{fontSize:13,marginTop:8}}>لا توجد زيارات في هذه الفترة</p>
          </div>
        ) : days.map(({date,visits:dayVisits})=>{
          const totalDayMin = dayVisits.reduce((acc,v)=>acc+durationMin(v.checkInAt,v.checkOutAt),0);
          const dayNum = format(new Date(date),"d");
          const dayNameStr = format(new Date(date),"EEE",{locale:ar});
          return (
            <div key={date} className="day-group">
              <div className="day-header">
                <div className="day-badge">
                  <span className="day-num">{dayNum}</span>
                  <span className="day-name-small">{dayNameStr}</span>
                </div>
                <div className="day-info">
                  <h4>{format(new Date(date),"EEEE، d MMMM yyyy",{locale:ar})}</h4>
                  <p>{dayVisits.length} زيارة • {fmtDuration(totalDayMin)}</p>
                </div>
              </div>
              {dayVisits.map((v:any)=>{
                const ci = new Date(v.checkInAt);
                const co = v.checkOutAt ? new Date(v.checkOutAt) : null;
                const dur = durationMin(v.checkInAt,v.checkOutAt);
                const isActive = v.status==="checked_in";
                return (
                  <div key={v.id} className="visit-row">
                    <div className="visit-icon">
                      <span className="material-symbols-outlined" style={{fontSize:18,color:"#0fa5f8",fontVariationSettings:"'FILL' 1"}}>
                        {v.visitType==="external_mission"?"directions_car":"store"}
                      </span>
                    </div>
                    <div className="visit-det">
                      <h5>{v.branchName ?? "مأمورية خارجية"}</h5>
                      <p>
                        {format(ci,"hh:mm a")}
                        {co && ` ← ${format(co,"hh:mm a")}`}
                        {dur>0 && ` • ${fmtDuration(dur)}`}
                        {v.distanceToPrevBranchKm != null && ` • ${parseFloat(v.distanceToPrevBranchKm).toFixed(1)} كم`}
                      </p>
                      {v.noteType==="short_visit" && <span className="vtag" style={{background:"rgba(245,158,11,0.12)",color:"#f59e0b"}}>زيارة قصيرة</span>}
                      {v.visitType==="external_mission" && <span className="vtag" style={{background:"rgba(139,92,246,0.12)",color:"#8b5cf6",marginRight:4}}>مأمورية</span>}
                    </div>
                    <div className="visit-stat">
                      <span className="visit-time-txt">{format(ci,"hh:mm")}</span>
                      <span className="vtag" style={{background:isActive?"rgba(245,158,11,0.12)":"rgba(52,211,153,0.12)",color:isActive?"#f59e0b":"#34d399"}}>
                        {isActive?"جارية":"تمت"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}
