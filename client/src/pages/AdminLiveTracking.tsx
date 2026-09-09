import { trpc } from "@/lib/trpc";
import { MapView, MapMarker, MapPolyline } from "@/components/Map";
import { useState, useEffect, useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { ar } from "date-fns/locale";
import type { MapCenter } from "@/components/Map";
import { useLang } from "@/lib/i18n";
import { getDistanceMeters } from "../../../shared/utils";

// ── ثوابت عنقود التوقفات (Stops) — نقاط متتالية أقرب من 50م ومدة ≥ 5 دقايق = توقف ──
const STOP_CLUSTER_RADIUS_M = 50;
const STOP_MIN_DURATION_MIN = 5;

export default function AdminLiveTracking() {
  const { t, lang } = useLang();
  const locale = lang === "ar" ? ar : undefined;
  const [mode, setMode]             = useState<"live" | "history">("live");
  const [historyDate, setHistoryDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [selectedManager, setSelectedManager] = useState<number | null>(null);
  const [flyTo, setFlyTo]           = useState<MapCenter | null>(null);

  const { data: managers = [], isLoading } = trpc.manager.getLiveLocations.useQuery(
    undefined,
    { refetchInterval: mode === "live" ? 10000 : false }
  );

  const { data: routeHistory = [], isLoading: historyLoading } =
    trpc.manager.getRouteHistory.useQuery(
      { managerId: selectedManager!, date: historyDate },
      { enabled: mode === "history" && selectedManager !== null }
    );

  useEffect(() => {
    if (mode === "history" && routeHistory.length > 0)
      setFlyTo({ lat: parseFloat(routeHistory[0].latitude), lng: parseFloat(routeHistory[0].longitude) });
  }, [routeHistory, mode]);

  // ── إحصاءات المسار (history mode): نقاط + مسافة + توقفات + مدة ─────────────
  const routeStats = useMemo(() => {
    const pts = routeHistory.map((p) => ({
      lat: parseFloat(p.latitude),
      lng: parseFloat(p.longitude),
      ts: new Date(p.timestamp).getTime(),
    }));
    // المسافة الكلية: مجموع المسافات بين النقاط المتتالية
    let totalMeters = 0;
    for (let i = 1; i < pts.length; i++) {
      totalMeters += getDistanceMeters(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    }
    // عنقود التوقفات: نقاط متتالية كلها بأقل من 50م من أول نقطة في العنقود؛
    // لو مدة العنقود (أول نقطة ← آخر نقطة) ≥ 5 دقايق يعتبر توقف والرحلة تنقسم عنده
    const stops: { lat: number; lng: number; minutes: number }[] = [];
    let i = 0;
    while (i < pts.length) {
      let j = i + 1;
      while (j < pts.length && getDistanceMeters(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) < STOP_CLUSTER_RADIUS_M) j++;
      const minutes = (pts[j - 1].ts - pts[i].ts) / 60000;
      if (j - 1 > i && minutes >= STOP_MIN_DURATION_MIN) {
        stops.push({ lat: pts[i].lat, lng: pts[i].lng, minutes: Math.round(minutes) });
      }
      i = j;
    }
    const durationMin = pts.length > 1 ? (pts[pts.length - 1].ts - pts[0].ts) / 60000 : 0;
    return { pts, totalKm: totalMeters / 1000, stops, durationMin };
  }, [routeHistory]);

  const hUnit = t("time.hourShort");
  const mUnit = t("time.minShort");
  const fmtRouteDuration = (min: number): string => {
    const m = Math.max(0, Math.round(min));
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}${hUnit} ${m % 60}${mUnit}` : `${m}${mUnit}`;
  };

  const withLoc    = managers.filter((m) => m.location !== null);
  const withoutLoc = managers.filter((m) => m.location === null);
  // ?????? ?????? manual ?? ?????? locationLogs — ???? ????? ??? ?????? ?????
  const noLocationLabel = (m: any) =>
    m.checkinMode === "manual" ? t("live.manualFallbackNote") : t("live.noLocationData");

  // ── shared styles ──
  const chip = (active: boolean): React.CSSProperties => ({
    padding: "5px 14px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    transition: "all .15s",
    background: active ? "var(--adm-accent)" : "transparent",
    color: active ? "var(--adm-accent-fg)" : "var(--adm-text-2)",
    border: "none",
  });

  if (isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-spin w-6 h-6 border-2 border-[var(--adm-border)] border-t-[var(--adm-text-1)] rounded-full" />
      </div>
    );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="adm-page-header-inner mx-5 mt-5 shrink-0">
        <div>
          <h1 className="text-[22px] font-bold text-[var(--adm-text-1)] tracking-tight" style={{ letterSpacing: "-0.02em" }}>{t("live.title")}</h1>
          <p className="text-[13px] text-[var(--adm-text-3)] mt-0.5 font-medium">
            {t("live.activeOffline", { a: withLoc.length, b: withoutLoc.length })}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div
            className="flex items-center p-1"
            style={{ background: "var(--adm-bg)", borderRadius: 12 }}
          >
            <button style={chip(mode === "live")} onClick={() => setMode("live")}>{t("live.modeLive")}</button>
            <button style={chip(mode === "history")} onClick={() => setMode("history")}>{t("live.modeHistory")}</button>
          </div>

          {mode === "history" && (
            <input
              type="date"
              value={historyDate}
              onChange={(e) => setHistoryDate(e.target.value)}
              className="h-8 px-3 text-[12px] font-medium text-[var(--adm-text-1)] outline-none transition-colors"
              style={{
                background: "var(--adm-surface)",
                border: "1px solid var(--adm-border)",
                borderRadius: 10,
              }}
            />
          )}

          {mode === "live" && (
            <div
              className="flex items-center gap-1.5 px-3 py-1.5"
              style={{
                background: "var(--adm-green-soft)",
                border: "1px solid var(--adm-green-soft-border)",
                borderRadius: 10,
              }}
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--adm-online)] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--adm-online)]" />
              </span>
              <span className="text-[11px] font-bold text-[var(--adm-green)]">{t("live.badge")}</span>
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 p-5 overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-full">

          {/* Map */}
          <div
            className="lg:col-span-3 overflow-hidden relative"
            style={{ borderRadius: 16, border: "1px solid var(--adm-border)", minHeight: 480 }}
          >
            <MapView
              initialZoom={6}
              initialCenter={{ lat: 30.0444, lng: 31.2357 }}
              flyTo={flyTo}
              flyToZoom={16}
              className="h-full w-full"
            >
              {mode === "live"
                ? withLoc.map((m) => (
                    <MapMarker
                      key={m.id}
                      lat={parseFloat(m.location!.latitude)}
                      lng={parseFloat(m.location!.longitude)}
                      label={m.userName || t("live.unnamedManager")}
                      color={selectedManager === m.id ? "#00E5FF" : "#22C55E"}
                      popupContent={`${m.userName} — ${formatDistanceToNow(
                        new Date(m.location!.timestamp),
                        { addSuffix: true, locale }
                      )}`}
                      onClick={() => {
                        setSelectedManager(m.id);
                        setFlyTo({
                          lat: parseFloat(m.location!.latitude),
                          lng: parseFloat(m.location!.longitude),
                        });
                      }}
                    />
                  ))
                : selectedManager && routeHistory.length > 0 && (
                    <>
                      {/* المسار الكامل — زي ما هو */}
                      <MapPolyline
                        positions={routeStats.pts.map(
                          (p) => [p.lat, p.lng] as [number, number]
                        )}
                        color="#FFB020"
                        weight={4}
                      />
                      {/* نقطة البداية (أخضر) ونقطة النهاية (أحمر) */}
                      {routeStats.pts.length > 0 && (
                        <MapMarker
                          lat={routeStats.pts[0].lat}
                          lng={routeStats.pts[0].lng}
                          color="#22C55E"
                          label={t("live.startPoint")}
                        />
                      )}
                      {routeStats.pts.length > 1 && (
                        <MapMarker
                          lat={routeStats.pts[routeStats.pts.length - 1].lat}
                          lng={routeStats.pts[routeStats.pts.length - 1].lng}
                          color="#EF4444"
                          label={t("live.endPoint")}
                        />
                      )}
                      {/* ماركرات التوقفات (برتقالي) */}
                      {routeStats.stops.map((s, idx) => (
                        <MapMarker
                          key={`stop-${idx}`}
                          lat={s.lat}
                          lng={s.lng}
                          color="#FFB020"
                          label={t("live.stoppedFor", { n: s.minutes })}
                          popupContent={t("live.stoppedFor", { n: s.minutes })}
                        />
                      ))}
                    </>
                  )}
            </MapView>

            {/* Empty overlays */}
            {mode === "live" && withLoc.length === 0 && (
              <Overlay icon="location_off" title={t("live.noActiveLocations")} sub={t("live.waitingForManagers")} />
            )}
            {mode === "history" && !selectedManager && (
              <Overlay icon="touch_app" title={t("live.selectManager")} sub={t("live.chooseFromList")} />
            )}
            {mode === "history" && selectedManager && historyLoading && (
              <div className="absolute inset-0 z-[1100] flex items-center justify-center bg-[var(--adm-surface)]/80 backdrop-blur-sm">
                <div className="animate-spin w-7 h-7 border-2 border-[var(--adm-border)] border-t-[var(--adm-text-1)] rounded-full" />
              </div>
            )}
            {mode === "history" && selectedManager && !historyLoading && routeHistory.length === 0 && (
              <Overlay icon="wrong_location" title={t("live.noRoute")} sub={t("live.noRouteSub")} />
            )}

            {/* ── شريط ملخص المسار (history mode): مسافة + توقفات + مدة + نقاط ── */}
            {mode === "history" && routeHistory.length > 0 && (
              <div
                className="absolute top-2.5 left-1/2 -translate-x-1/2 z-[1050] flex flex-wrap justify-center gap-1.5 px-2 max-w-[96%]"
              >
                {[
                  { icon: "route", label: t("live.totalDistance"), value: `${routeStats.totalKm.toFixed(1)} ${t("reports.km")}` },
                  { icon: "pause_circle", label: t("live.stopsCount"), value: String(routeStats.stops.length) },
                  { icon: "schedule", label: t("live.duration"), value: fmtRouteDuration(routeStats.durationMin) },
                  { icon: "timeline", label: t("live.pointsCount"), value: String(routeStats.pts.length) },
                ].map((c) => (
                  <span
                    key={c.label}
                    className="flex items-center gap-1.5 px-3 py-1.5 whitespace-nowrap"
                    style={{
                      background: "var(--adm-surface)",
                      border: "1px solid var(--adm-border)",
                      borderRadius: 999,
                      boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                    }}
                  >
                    <span className="material-symbols-outlined text-[14px] text-[var(--adm-text-3)]">{c.icon}</span>
                    <span className="text-[11px] font-semibold text-[var(--adm-text-3)]">{c.label}</span>
                    <span className="text-[11px] font-bold font-mono text-[var(--adm-text-1)]">{c.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div
            className="flex flex-col overflow-hidden"
            style={{
              background: "var(--adm-surface)",
              border: "1px solid var(--adm-border)",
              borderRadius: 16,
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3 shrink-0"
              style={{ borderBottom: "1px solid var(--adm-bg)" }}
            >
              <p className="text-[13px] font-bold text-[var(--adm-text-1)]">{t("live.managers")}</p>
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                style={{ background: "var(--adm-bg)", color: "var(--adm-text-2)" }}
              >
                {managers.length}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-2" style={{ scrollbarWidth: "none" }}>
              {managers.length === 0 ? (
                <p className="text-[11px] text-[var(--adm-text-3)] text-center py-10">{t("live.noManagers")}</p>
              ) : (
                managers.map((m) => {
                  const hasLoc   = m.location !== null;
                  const selected = selectedManager === m.id;
                  return (
                    <div
                      key={m.id}
                      onClick={() => {
                        if (!hasLoc) return;
                        setSelectedManager(m.id);
                        setFlyTo({
                          lat: parseFloat(m.location!.latitude),
                          lng: parseFloat(m.location!.longitude),
                        });
                      }}
                      className="p-3 mb-0.5 rounded-xl transition-all"
                      style={{
                        cursor: hasLoc ? "pointer" : "default",
                        opacity: hasLoc ? 1 : 0.5,
                        background: selected ? "var(--adm-bg)" : "transparent",
                        border: `1px solid ${selected ? "var(--adm-border)" : "transparent"}`,
                        borderRadius: 12,
                      }}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{
                            background: hasLoc ? "var(--adm-online)" : "var(--adm-text-3)",
                            boxShadow: hasLoc ? "0 0 5px rgba(34,197,94,0.6)" : "none",
                          }}
                        />
                        <span className="text-[12px] font-bold text-[var(--adm-text-1)] truncate">
                          {m.userName || t("live.unnamedManager")}
                        </span>
                      </div>
                      <p className="text-[10px] text-[var(--adm-text-3)] ps-3.5">
                        {hasLoc
                          ? formatDistanceToNow(new Date(m.location!.timestamp), {
                              addSuffix: true,
                              locale,
                            })
                          : noLocationLabel(m)}
                      </p>
                    </div>
                  );
                })
              )}
            </div>

            <div
              className="px-4 py-3 shrink-0"
              style={{ borderTop: "1px solid var(--adm-bg)" }}
            >
              <p className="text-[10px] text-[var(--adm-text-3)] leading-4">
                {t("live.disclaimer")}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Overlay helper ───────────────────────────────────────────────────────────
function Overlay({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div className="absolute inset-0 z-[1100] flex flex-col items-center justify-center bg-[var(--adm-surface)]/80 backdrop-blur-sm">
      <span
        className="material-symbols-outlined text-[var(--adm-border)] mb-3"
        style={{ fontSize: 44, fontVariationSettings: "'FILL' 1" }}
      >
        {icon}
      </span>
      <p className="text-[13px] font-bold text-[var(--adm-text-2)]">{title}</p>
      <p className="text-[11px] text-[var(--adm-text-3)] mt-1">{sub}</p>
    </div>
  );
}
