import { useState } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { useLang } from "@/lib/i18n";
import { useAdminTheme } from "@/lib/adminTheme";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// ─── Design tokens — CSS vars scoped to .admin-root (see index.css) ──────────

// ─── Types ────────────────────────────────────────────────────────────────────
type CreateForm = {
  username: string;
  password: string;
  name: string;
  email: string;
  role: "user" | "admin";
  os: "android" | "ios";
};
type EditForm = CreateForm & { id: number };
const emptyCreate: CreateForm = {
  username: "",
  password: "",
  name: "",
  email: "",
  role: "user",
  os: "android",
};

// ─── Shared Field ─────────────────────────────────────────────────────────────
function Field({ label, icon, children }: { label: string; icon?: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        className="flex items-center gap-1.5 text-[11px] font-bold tracking-widest uppercase mb-2"
        style={{ color: "var(--adm-text-3)" }}
      >
        {icon && (
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 12, color: "var(--adm-text-3)" }}
          >
            {icon}
          </span>
        )}
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Shared Input ─────────────────────────────────────────────────────────────
function AdminInput({
  type = "text",
  value,
  onChange,
  placeholder,
  suffix,
}: {
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suffix?: React.ReactNode;
}) {
  return (
    <div className="relative">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-10 px-3.5 rounded-xl text-[13px] font-medium outline-none transition-all"
        style={{
          background: "var(--adm-bg)",
          border: "1px solid var(--adm-border)",
          color: "var(--adm-text-1)",
          paddingInlineEnd: suffix ? 36 : undefined,
        }}
        onFocus={(e) => {
          e.currentTarget.style.border = "1px solid var(--adm-accent)";
          e.currentTarget.style.background = "var(--adm-surface)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.border = "1px solid var(--adm-border)";
          e.currentTarget.style.background = "var(--adm-bg)";
        }}
      />
      {suffix && (
        <div className="absolute end-3 top-1/2 -translate-y-1/2">{suffix}</div>
      )}
    </div>
  );
}

// ─── Role Selector ────────────────────────────────────────────────────────────
function RoleSelector({
  value,
  onChange,
}: {
  value: "user" | "admin";
  onChange: (v: "user" | "admin") => void;
}) {
  const { t } = useLang();
  return (
    <div className="grid grid-cols-2 gap-2">
      {(
        [
          { role: "user", label: t("users.roleOptionManager"), icon: "manage_accounts" },
          { role: "admin", label: t("users.roleOptionAdmin"), icon: "shield" },
        ] as const
      ).map(({ role, label, icon }) => {
        const active = value === role;
        return (
          <button
            key={role}
            type="button"
            onClick={() => onChange(role)}
            className="flex items-center gap-2 p-3 rounded-xl border transition-all cursor-pointer"
            style={{
              background: active ? "var(--adm-accent)" : "var(--adm-bg)",
              borderColor: active ? "var(--adm-accent)" : "var(--adm-border)",
              color: active ? "var(--adm-accent-fg)" : "var(--adm-text-2)",
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{
                fontSize: 18,
                fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0",
              }}
            >
              {icon}
            </span>
            <span className="font-semibold text-[13px]">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function AdminUsers() {
  const { t, lang } = useLang();
  const { theme } = useAdminTheme();
  const { user: authUser } = useAuth();
  const isSuperAdmin = authUser?.role === "superadmin";
  const locale = lang === "ar" ? ar : undefined;
  const [createOpen, setCreateOpen] = useState(false);
  const [superEditOpen, setSuperEditOpen] = useState(false);
  const [superEditTarget, setSuperEditTarget] = useState<any | null>(null);
  const [superEditForm, setSuperEditForm] = useState<any | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyCreate);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [unbindTarget, setUnbindTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);

  const {
    data: users = [],
    isLoading,
    refetch,
  } = trpc.users.list.useQuery();

  const createMutation = trpc.users.create.useMutation({
    onSuccess: () => {
      toast.success(t("users.toastCreated"));
      refetch();
      setCreateOpen(false);
      setForm(emptyCreate);
    },
    onError: (e) => toast.error(e.message),
  });
  const updateMutation = trpc.users.update.useMutation({
    onSuccess: () => {
      toast.success(t("users.toastUpdated"));
      refetch();
      setEditOpen(false);
      setEditForm(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteMutation = trpc.users.delete.useMutation({
    onSuccess: () => {
      toast.success(t("users.toastDeleted"));
      refetch();
      setDeleteOpen(false);
      setDeleteTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  // 🔓 فك ربط الجهاز — يسمح للمستخدم بتسجيل الدخول من موبايل جديد
  const unbindMutation = trpc.users.unbindDevice.useMutation({
    onSuccess: () => {
      toast.success(t("users.toastUnbound"));
      refetch();
      setUnbindTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  // 🔓 فك ربط المتصفح — يسمح للمدير بتسجيل الدخول من متصفح آيفون جديد
  const unbindWebMutation = trpc.users.unbindWebDevice.useMutation({
    onSuccess: () => {
      toast.success("تم فك ربط المتصفح بنجاح — يمكن للمدير تسجيل الدخول من متصفح جديد");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  // ?? ???? ???????? ??? ??????? (admin ??)
  const checkinModeMutation = trpc.users.setCheckinMode.useMutation({
    onSuccess: () => {
      toast.success(t("users.checkinModeUpdated"));
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  // 🦸‍♂️ السوبر أدمن — تعديل شامل لأي مستخدم
  const superUpdateMutation = trpc.users.superadminUpdateUser.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث المستخدم (سوبر أدمن)");
      refetch();
      setSuperEditOpen(false);
      setSuperEditTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleCreate = () => {
    if (!form.username) {
      toast.error(t("users.toastUsernameRequired"));
      return;
    }
    if (form.password.length < 6) {
      toast.error(t("users.toastPasswordShort"));
      return;
    }
    createMutation.mutate({
      username: form.username,
      password: form.password,
      name: form.name || undefined,
      email: form.email || undefined,
      role: form.role,
      os: form.os,
    });
  };

  const handleEdit = (u: any) => {
    setEditForm({
      id: u.id,
      username: u.username,
      password: "",
      name: u.name ?? "",
      email: u.email ?? "",
      role: u.role,
      os: u.os ?? "android",
    });
    setShowEditPassword(false);
    setEditOpen(true);
  };

  const handleUpdate = () => {
    if (!editForm) return;
    if (!editForm.username) {
      toast.error(t("users.toastUsernameRequired"));
      return;
    }
    if (editForm.password && editForm.password.length < 6) {
      toast.error(t("users.toastPasswordShort"));
      return;
    }
    updateMutation.mutate({
      id: editForm.id,
      username: editForm.username,
      name: editForm.name || undefined,
      email: editForm.email || undefined,
      role: editForm.role,
      ...(editForm.password ? { password: editForm.password } : {}),
    });
  };

  const handleDeleteClick = (u: any) => {
    setDeleteTarget({ id: u.id, name: u.name ?? u.username });
    setDeleteOpen(true);
  };

  const allUsers = users as any[];
  const admins = allUsers.filter((u) => u.role === "admin");
  const managers = allUsers.filter((u) => u.role === "user");

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="p-5 md:p-7 space-y-6">

      {/* ── Page Header ─────────────────────────────────────────────────────── */}
      <div className="adm-page-header-inner">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: "var(--adm-text-1)", letterSpacing: "-0.02em" }}>
            {t("users.title")}
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: "var(--adm-text-2)" }}>
            {t("users.subtitle")}
          </p>
        </div>
        <button
          onClick={() => {
            setForm(emptyCreate);
            setShowPassword(false);
            setCreateOpen(true);
          }}
          className="h-9 px-4 flex items-center gap-1.5 rounded-xl text-[13px] font-bold transition-all hover:opacity-90 cursor-pointer"
          style={{ background: "var(--adm-accent)", color: "var(--adm-accent-fg)" }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
            person_add
          </span>
          {t("users.add")}
        </button>
      </div>

      {/* ── KPI Row ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        {[
          {
            label: t("users.kpiTotal"),
            value: isLoading ? "—" : allUsers.length,
            icon: "group",
            color: "var(--adm-text-1)",
            bg: "var(--adm-bg)",
          },
          {
            label: t("users.kpiAdmins"),
            value: isLoading ? "—" : admins.length,
            icon: "shield",
            color: "var(--adm-text-2)",
            bg: "var(--adm-bg)",
          },
          {
            label: t("users.kpiManagers"),
            value: isLoading ? "—" : managers.length,
            icon: "manage_accounts",
            color: "var(--adm-green)",
            bg: "var(--adm-green-soft)",
          },
        ].map(({ label, value, icon, color, bg }) => (
          <div
            key={label}
            className="flex items-center justify-between p-4"
            style={{
              background: "var(--adm-surface)",
              border: "1px solid var(--adm-border)",
              borderRadius: 16,
            }}
          >
            <div>
              <p
                className="text-[10px] font-bold tracking-widest uppercase mb-1"
                style={{ color: "var(--adm-text-3)" }}
              >
                {label}
              </p>
              <p className="text-[26px] font-bold leading-none" style={{ color }}>
                {value}
              </p>
            </div>
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: bg }}
            >
              <span
                className="material-symbols-outlined"
                style={{
                  fontSize: 18,
                  color,
                  fontVariationSettings: "'FILL' 1",
                }}
              >
                {icon}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Users Table ─────────────────────────────────────────────────────── */}
      <div
        style={{
          background: "var(--adm-surface)",
          border: "1px solid var(--adm-border)",
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <div
          className="px-5 py-3 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--adm-bg)" }}
        >
          <p
            className="text-[12px] font-bold tracking-widest uppercase"
            style={{ color: "var(--adm-text-3)" }}
          >
            {t("users.allAccounts")}
          </p>
          <span className="text-[12px] font-medium" style={{ color: "var(--adm-text-3)" }}>
            {t("users.count", { n: allUsers.length })}
          </span>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: "var(--adm-text-3)" }} />
          </div>
        ) : allUsers.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-3 text-center">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{ background: "var(--adm-bg)" }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 24, color: "var(--adm-text-3)" }}
              >
                person_off
              </span>
            </div>
            <p className="text-[14px] font-bold" style={{ color: "var(--adm-text-1)" }}>
              {t("users.noAccounts")}
            </p>
          </div>
        ) : (
          <div>
            {allUsers.map((u: any) => {
              const isAdminUser = u.role === "admin";
              return (
                <div
                  key={u.id}
                  className="flex flex-col md:flex-row md:items-center justify-between px-5 py-4 gap-3 transition-colors hover:bg-[var(--adm-chip)]"
                  style={{ borderBottom: "1px solid var(--adm-bg)" }}
                >
                  {/* Avatar + info */}
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div
                      className="w-20 h-20 rounded-full flex items-center justify-center font-bold text-[28px] flex-shrink-0"
                      style={{
                        background: isAdminUser ? "var(--adm-accent)" : "var(--adm-bg)",
                        color: isAdminUser ? "var(--adm-accent-fg)" : "var(--adm-text-2)",
                      }}
                    >
                      {(u.name ?? u.username).charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span
                          className="text-[13px] font-semibold"
                          style={{ color: "var(--adm-text-1)" }}
                        >
                          {u.name ?? u.username}
                        </span>
                        <span
                          className="text-[11px] font-mono px-2 py-0.5 rounded-full"
                          style={{ background: "var(--adm-bg)", color: "var(--adm-text-2)" }}
                        >
                          @{u.username}
                        </span>
                        <span
                          className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{
                            background: isAdminUser ? "var(--adm-bg)" : "var(--adm-green-soft)",
                            color: isAdminUser ? "var(--adm-text-1)" : "var(--adm-green)",
                          }}
                        >
                          {isAdminUser ? t("users.roleAdmin") : t("users.roleManager")}
                        </span>
                        {/* 🔒 حالة ربط الجهاز — للمديرين على الأندرويد فقط */}
                        {!isAdminUser && u.os !== "ios" && (
                          <span
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1"
                            style={{
                              background: u.isDeviceBound ? "var(--adm-blue-soft)" : "var(--adm-amber-soft)",
                              color: u.isDeviceBound ? "var(--adm-blue)" : "var(--adm-amber)",
                            }}
                            title={u.isDeviceBound ? t("users.deviceBoundTitle") : t("users.deviceUnboundTitle")}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 11 }}>
                              {u.isDeviceBound ? "smartphone" : "smartphone_question"}
                            </span>
                            {u.isDeviceBound ? t("users.deviceBound") : t("users.deviceUnbound")}
                          </span>
                        )}
                        {/* 🍎 بادج نظام التشغيل */}
                        {!isAdminUser && (
                          <span
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1"
                            style={{
                              background: u.os === "ios" ? "rgba(139,92,246,0.15)" : "rgba(34,197,94,0.12)",
                              color: u.os === "ios" ? "#a78bfa" : "#22c55e",
                            }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 11 }}>
                              {u.os === "ios" ? "phone_iphone" : "android"}
                            </span>
                            {u.os === "ios" ? "iOS" : "Android"}
                          </span>
                        )}
                        {/* 🌐 بادج ربط المتصفح (Web Fingerprint) — للمديرين على الآيفون فقط */}
                        {!isAdminUser && u.os === "ios" && (
                          <span
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 cursor-pointer"
                            style={{
                              background: u.isWebBound ? "rgba(16,185,129,0.15)" : "rgba(100,100,120,0.15)",
                              color: u.isWebBound ? "#10b981" : "rgba(255,255,255,0.35)",
                            }}
                            title={u.isWebBound ? "مربوط بمتصفح ويب — اضغط لفك الربط" : "لم يسجل دخول من متصفح بعد"}
                            onClick={() => {
                              if (u.isWebBound && confirm(`فك ربط متصفح الويب لـ "${u.name}"؟`)) {
                                unbindWebMutation.mutate({ id: u.id });
                              }
                            }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 11 }}>language</span>
                            {u.isWebBound ? "Safari مربوط" : "Safari حر"}
                          </span>
                        )}
                        {/* وضع تسجيل الدخول — يغير السلوك من تلقائي لى يدوي (أندرويد فقط) */}
                        {!isAdminUser && u.os !== "ios" && (
                          <select
                            value={u.checkinMode ?? "automatic"}
                            disabled={checkinModeMutation.isPending}
                            onChange={(e) => {
                              const mode = e.target.value === "manual" ? "manual" : "automatic";
                              if (mode === (u.checkinMode ?? "automatic")) return;
                              checkinModeMutation.mutate({ id: u.id, mode });
                            }}
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full outline-none cursor-pointer"
                            style={{
                              background: (u.checkinMode ?? "automatic") === "manual" ? "var(--adm-amber-soft)" : "var(--adm-blue-soft)",
                              color: (u.checkinMode ?? "automatic") === "manual" ? "var(--adm-amber)" : "var(--adm-blue)",
                              border: "none",
                            }}
                            title={t("users.checkinModeLabel")}
                          >
                            <option value="automatic">{t("users.checkinModeAutomatic")}</option>
                            <option value="manual">{t("users.checkinModeManual")}</option>
                          </select>
                        )}
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        {u.email && (
                          <span
                            className="text-[12px]"
                            style={{ color: "var(--adm-text-3)" }}
                          >
                            {u.email}
                          </span>
                        )}
                        {u.lastSignedIn && (
                          <span
                            className="text-[12px] font-mono"
                            style={{ color: "var(--adm-text-3)" }}
                          >
                            {t("users.lastLogin", {
                              date: format(new Date(u.lastSignedIn), "dd MMM yyyy", { locale }),
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {/* 🔓 فك ربط الجهاز — للمديرين المربوطين فقط */}
                    {!isAdminUser && u.isDeviceBound && (
                      <button
                        onClick={() =>
                          setUnbindTarget({ id: u.id, name: u.name ?? u.username })
                        }
                        title={t("users.unbindHint")}
                        className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors hover:bg-[var(--adm-blue-soft)] cursor-pointer"
                      >
                        <span
                          className="material-symbols-outlined"
                          style={{ fontSize: 16, color: "var(--adm-blue)" }}
                        >
                          link_off
                        </span>
                      </button>
                    )}
                    {/* 🦸 سوبر أدمن — زر تعديل شامل */}
                    {isSuperAdmin && (
                      <button
                        onClick={() => {
                          setSuperEditTarget(u);
                          setSuperEditForm({
                            id: u.id,
                            username: u.username,
                            name: u.name ?? "",
                            email: u.email ?? "",
                            role: u.role,
                            password: "",
                            checkinMode: u.checkinMode ?? "automatic",
                          });
                          setSuperEditOpen(true);
                        }}
                        className="h-8 px-3 rounded-xl flex items-center gap-1.5 transition-colors text-xs font-bold cursor-pointer"
                        style={{ background: "rgba(16,185,129,0.15)", color: "#10b981", border: "1px solid rgba(16,185,129,0.25)" }}
                        title="تعديل شامل (سوبر أدمن)"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 13 }}>manage_history</span>
                        سوبر تعديل
                      </button>
                    )}
                    <button
                      onClick={() => handleEdit(u)}
                      className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors hover:bg-[var(--adm-bg)] cursor-pointer"
                    >
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 16, color: "var(--adm-text-2)" }}
                      >
                        edit
                      </span>
                    </button>
                    <button
                      onClick={() => handleDeleteClick(u)}
                      className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors hover:bg-[var(--adm-red-soft)] cursor-pointer"
                    >
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 16, color: "var(--adm-red)" }}
                      >
                        delete
                      </span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 🦸 Superadmin Full Edit Dialog ──────────────────────────────────── */}
      {isSuperAdmin && superEditForm && (
        <Dialog open={superEditOpen} onOpenChange={(v) => { setSuperEditOpen(v); if (!v) setSuperEditTarget(null); }}>
          <DialogContent
            className={`p-0 overflow-hidden sm:rounded-2xl max-w-md admin-root ${theme === 'dark' ? 'dark' : ''}`}
            style={{ background: "#0a0a0f", border: "1px solid rgba(16,185,129,0.3)" }}
            dir="rtl"
          >
            <DialogHeader className="px-6 py-4" style={{ borderBottom: "1px solid rgba(16,185,129,0.15)" }}>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "rgba(16,185,129,0.2)" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#10b981", fontVariationSettings: "'FILL' 1" }}>manage_history</span>
                </div>
                <DialogTitle className="text-[15px] font-bold" style={{ color: "#10b981" }}>
                  تعديل شامل — سوبر أدمن
                  <span className="block text-xs font-normal mt-0.5" style={{ color: "rgba(16,185,129,0.6)" }}>
                    تعديل {superEditTarget?.name ?? superEditTarget?.username}
                  </span>
                </DialogTitle>
              </div>
            </DialogHeader>

            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Name */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest" style={{ color: "rgba(16,185,129,0.7)" }}>الاسم</label>
                <input type="text" value={superEditForm.name} onChange={(e) => setSuperEditForm((f: any) => ({ ...f, name: e.target.value }))}
                  className="w-full h-10 px-3.5 rounded-xl text-sm font-medium outline-none transition-all"
                  style={{ background: "#111827", border: "1px solid rgba(16,185,129,0.2)", color: "#e5e7eb" }} />
              </div>
              {/* Username */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest" style={{ color: "rgba(16,185,129,0.7)" }}>اسم المستخدم (Username)</label>
                <input type="text" value={superEditForm.username} onChange={(e) => setSuperEditForm((f: any) => ({ ...f, username: e.target.value }))}
                  className="w-full h-10 px-3.5 rounded-xl text-sm font-medium outline-none transition-all font-mono"
                  style={{ background: "#111827", border: "1px solid rgba(16,185,129,0.2)", color: "#e5e7eb" }} dir="ltr" />
              </div>
              {/* Email */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest" style={{ color: "rgba(16,185,129,0.7)" }}>البريد الإلكتروني</label>
                <input type="email" value={superEditForm.email} onChange={(e) => setSuperEditForm((f: any) => ({ ...f, email: e.target.value }))}
                  className="w-full h-10 px-3.5 rounded-xl text-sm font-medium outline-none transition-all font-mono"
                  style={{ background: "#111827", border: "1px solid rgba(16,185,129,0.2)", color: "#e5e7eb" }} dir="ltr" />
              </div>
              {/* Password */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest" style={{ color: "rgba(16,185,129,0.7)" }}>كلمة المرور الجديدة (اتركها فارغة للإبقاء)</label>
                <input type="password" value={superEditForm.password} onChange={(e) => setSuperEditForm((f: any) => ({ ...f, password: e.target.value }))}
                  className="w-full h-10 px-3.5 rounded-xl text-sm font-medium outline-none transition-all"
                  style={{ background: "#111827", border: "1px solid rgba(16,185,129,0.2)", color: "#e5e7eb" }} />
              </div>
              {/* Role */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest" style={{ color: "rgba(16,185,129,0.7)" }}>الدور (Role)</label>
                <select value={superEditForm.role} onChange={(e) => setSuperEditForm((f: any) => ({ ...f, role: e.target.value }))}
                  className="w-full h-10 px-3.5 rounded-xl text-sm font-medium outline-none"
                  style={{ background: "#111827", border: "1px solid rgba(16,185,129,0.2)", color: "#e5e7eb" }}>
                  <option value="user">مدير فرع (user)</option>
                  <option value="admin">أدمن (admin)</option>
                  <option value="superadmin">سوبر أدمن (superadmin)</option>
                </select>
              </div>
              {/* Checkin Mode */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest" style={{ color: "rgba(16,185,129,0.7)" }}>وضع تسجيل الدخول</label>
                <select value={superEditForm.checkinMode} onChange={(e) => setSuperEditForm((f: any) => ({ ...f, checkinMode: e.target.value }))}
                  className="w-full h-10 px-3.5 rounded-xl text-sm font-medium outline-none"
                  style={{ background: "#111827", border: "1px solid rgba(16,185,129,0.2)", color: "#e5e7eb" }}>
                  <option value="automatic">تلقائي (Automatic)</option>
                  <option value="manual">يدوي (Manual)</option>
                </select>
              </div>
              {/* Device bind control */}
              <div className="p-3 rounded-xl" style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.15)" }}>
                <p className="text-xs font-bold mb-2" style={{ color: "#ef4444" }}>⚠️ إجراءات خطرة</p>
                <div className="flex gap-2">
                  {superEditTarget?.isDeviceBound && (
                    <button onClick={() => {
                      if (confirm(`فك ربط جهاز موبايل "${superEditTarget.name}"؟`))
                        superUpdateMutation.mutate({ id: superEditForm.id, boundDeviceId: null });
                    }} className="text-xs px-3 py-1.5 rounded-lg font-bold" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
                      فك ربط الموبايل
                    </button>
                  )}
                  {superEditTarget?.isWebBound && (
                    <button onClick={() => {
                      if (confirm(`فك ربط متصفح ويب "${superEditTarget.name}"؟`))
                        superUpdateMutation.mutate({ id: superEditForm.id, boundWebFingerprint: null });
                    }} className="text-xs px-3 py-1.5 rounded-lg font-bold" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
                      فك ربط الويب
                    </button>
                  )}
                  {!superEditTarget?.isDeviceBound && !superEditTarget?.isWebBound && (
                    <span className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>لا يوجد ربط حالي</span>
                  )}
                </div>
              </div>
            </div>

            <DialogFooter className="px-6 py-4" style={{ borderTop: "1px solid rgba(16,185,129,0.15)" }}>
              <button onClick={() => setSuperEditOpen(false)}
                className="h-9 px-4 rounded-xl text-sm font-bold"
                style={{ background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.5)" }}>
                إلغاء
              </button>
              <button
                disabled={superUpdateMutation.isPending}
                onClick={() => superUpdateMutation.mutate({
                  id: superEditForm.id,
                  name: superEditForm.name || undefined,
                  username: superEditForm.username || undefined,
                  email: superEditForm.email || undefined,
                  role: superEditForm.role,
                  checkinMode: superEditForm.checkinMode,
                  ...(superEditForm.password ? { password: superEditForm.password } : {}),
                })}
                className="h-9 px-4 rounded-xl text-sm font-bold flex items-center gap-2 disabled:opacity-50"
                style={{ background: "rgba(16,185,129,0.25)", color: "#10b981", border: "1px solid rgba(16,185,129,0.3)" }}>
                {superUpdateMutation.isPending && <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />}
                حفظ التعديلات
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Create Dialog ────────────────────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          className={`p-0 overflow-hidden sm:rounded-2xl max-w-md admin-root ${theme === 'dark' ? 'dark' : ''}`}
          style={{ background: "var(--adm-surface)", border: "1px solid var(--adm-border)" }}
        >
          <DialogHeader
            className="px-6 py-4"
            style={{ borderBottom: "1px solid var(--adm-bg)" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: "var(--adm-accent)" }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 16, color: "var(--adm-accent-fg)", fontVariationSettings: "'FILL' 1" }}
                >
                  person_add
                </span>
              </div>
              <DialogTitle
                className="text-[15px] font-bold"
                style={{ color: "var(--adm-text-1)" }}
              >
                {t("users.createTitle")}
              </DialogTitle>
            </div>
          </DialogHeader>

          <div className="px-6 py-5 space-y-4">
            <Field label={t("users.fieldRole")} icon="badge">
              <RoleSelector
                value={form.role}
                onChange={(v) => setForm((f) => ({ ...f, role: v }))}
              />
            </Field>

            {/* نظام تشغيل الجهاز — يحدد المنصة المسموح بها ونوع الوصول */}
            {form.role === "user" && (
              <Field label="جهاز المدير" icon="devices">
                <div className="grid grid-cols-2 gap-2">
                  {(["android", "ios"] as const).map((osOption) => {
                    const active = form.os === osOption;
                    return (
                      <button
                        key={osOption}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, os: osOption }))}
                        className="flex items-center gap-2 p-3 rounded-xl border transition-all cursor-pointer"
                        style={{
                          background: active ? (osOption === "ios" ? "rgba(139,92,246,0.2)" : "rgba(34,197,94,0.15)") : "var(--adm-bg)",
                          borderColor: active ? (osOption === "ios" ? "#a78bfa" : "#22c55e") : "var(--adm-border)",
                          color: active ? (osOption === "ios" ? "#a78bfa" : "#22c55e") : "var(--adm-text-2)",
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}>
                          {osOption === "ios" ? "phone_iphone" : "android"}
                        </span>
                        <div className="text-right">
                          <div className="font-bold text-[13px]">{osOption === "ios" ? "آيفون (iOS)" : "أندرويد"}</div>
                          <div className="text-[10px] opacity-60">{osOption === "ios" ? "Safari فقط — يدوي" : "تطبيق فقط — تلقائي"}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label={t("users.fieldUsername")} icon="alternate_email">
                <AdminInput
                  value={form.username}
                  onChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      username: v.toLowerCase().replace(/\s/g, "."),
                    }))
                  }
                  placeholder="ahmed.ali"
                />
              </Field>
              <Field label={t("users.fieldFullName")} icon="person">
                <AdminInput
                  value={form.name}
                  onChange={(v) => setForm((f) => ({ ...f, name: v }))}
                  placeholder="أحمد علي"
                />
              </Field>
            </div>

            <Field label={t("users.fieldPassword")} icon="lock">
              <AdminInput
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(v) => setForm((f) => ({ ...f, password: v }))}
                placeholder={t("users.phPassword")}
                suffix={
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="cursor-pointer"
                  >
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 16, color: "var(--adm-text-3)" }}
                    >
                      {showPassword ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                }
              />
            </Field>

            <Field label={t("users.fieldEmail")} icon="mail">
              <AdminInput
                type="email"
                value={form.email}
                onChange={(v) => setForm((f) => ({ ...f, email: v }))}
                placeholder="ahmed@example.com"
              />
            </Field>

            {form.role === "user" && (
              <div
                className="flex items-start gap-2 p-3 rounded-xl"
                style={{ background: "var(--adm-green-soft)", border: "1px solid var(--adm-green-soft-border)" }}
              >
                <span
                  className="material-symbols-outlined flex-shrink-0 mt-0.5"
                  style={{ fontSize: 15, color: "var(--adm-green)" }}
                >
                  info
                </span>
                <p className="text-[12px] leading-relaxed" style={{ color: "var(--adm-text-1)" }}>
                  {t("users.hintAfterCreate")}{" "}
                  <strong>{t("users.hintAfterCreate2")}</strong>{" "}
                  {t("users.hintAfterCreate3")}
                </p>
              </div>
            )}
          </div>

          <DialogFooter
            className="px-6 py-4 flex items-center justify-end gap-2"
            style={{ borderTop: "1px solid var(--adm-bg)" }}
          >
            <button
              onClick={() => setCreateOpen(false)}
              className="h-9 px-4 rounded-xl text-[13px] font-semibold transition-colors hover:bg-[var(--adm-bg)] cursor-pointer"
              style={{ color: "var(--adm-text-2)" }}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending}
              className="h-9 px-5 rounded-xl text-[13px] font-bold flex items-center gap-2 transition-opacity hover:opacity-90 cursor-pointer disabled:opacity-50"
              style={{ background: "var(--adm-accent)", color: "var(--adm-accent-fg)" }}
            >
              {createMutation.isPending && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {t("users.create")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Dialog ──────────────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent
          className={`p-0 overflow-hidden sm:rounded-2xl max-w-md admin-root ${theme === 'dark' ? 'dark' : ''}`}
          style={{ background: "var(--adm-surface)", border: "1px solid var(--adm-border)" }}
        >
          <DialogHeader
            className="px-6 py-4"
            style={{ borderBottom: "1px solid var(--adm-bg)" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: "var(--adm-accent)" }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 16, color: "var(--adm-accent-fg)", fontVariationSettings: "'FILL' 1" }}
                >
                  edit
                </span>
              </div>
              <DialogTitle
                className="text-[15px] font-bold"
                style={{ color: "var(--adm-text-1)" }}
              >
                {t("users.editTitle")}
              </DialogTitle>
            </div>
          </DialogHeader>

          {editForm && (
            <div className="px-6 py-5 space-y-4">
              <Field label={t("users.fieldRole")} icon="badge">
                <RoleSelector
                  value={editForm.role}
                  onChange={(v) =>
                    setEditForm((f) => (f ? { ...f, role: v } : f))
                  }
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("users.fieldUsername")} icon="alternate_email">
                  <AdminInput
                    value={editForm.username}
                    onChange={(v) =>
                      setEditForm((f) =>
                        f
                          ? {
                              ...f,
                              username: v.toLowerCase().replace(/\s/g, "."),
                            }
                          : f
                      )
                    }
                  />
                </Field>
                <Field label={t("users.fieldFullName")} icon="person">
                  <AdminInput
                    value={editForm.name}
                    onChange={(v) =>
                      setEditForm((f) => (f ? { ...f, name: v } : f))
                    }
                  />
                </Field>
              </div>
              <Field label={t("users.fieldNewPassword")} icon="lock">
                <AdminInput
                  type={showEditPassword ? "text" : "password"}
                  value={editForm.password}
                  onChange={(v) =>
                    setEditForm((f) => (f ? { ...f, password: v } : f))
                  }
                  placeholder={t("users.phKeepPassword")}
                  suffix={
                    <button
                      type="button"
                      onClick={() => setShowEditPassword((s) => !s)}
                      className="cursor-pointer"
                    >
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 16, color: "var(--adm-text-3)" }}
                      >
                        {showEditPassword ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                  }
                />
              </Field>
              <Field label={t("users.fieldEmail")} icon="mail">
                <AdminInput
                  type="email"
                  value={editForm.email}
                  onChange={(v) =>
                    setEditForm((f) => (f ? { ...f, email: v } : f))
                  }
                />
              </Field>
            </div>
          )}

          <DialogFooter
            className="px-6 py-4 flex items-center justify-end gap-2"
            style={{ borderTop: "1px solid var(--adm-bg)" }}
          >
            <button
              onClick={() => setEditOpen(false)}
              className="h-9 px-4 rounded-xl text-[13px] font-semibold transition-colors hover:bg-[var(--adm-bg)] cursor-pointer"
              style={{ color: "var(--adm-text-2)" }}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleUpdate}
              disabled={updateMutation.isPending}
              className="h-9 px-5 rounded-xl text-[13px] font-bold flex items-center gap-2 transition-opacity hover:opacity-90 cursor-pointer disabled:opacity-50"
              style={{ background: "var(--adm-accent)", color: "var(--adm-accent-fg)" }}
            >
              {updateMutation.isPending && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {t("common.saveChanges")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirm ───────────────────────────────────────────────────── */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          className={`p-0 overflow-hidden sm:rounded-2xl max-w-sm admin-root ${theme === 'dark' ? 'dark' : ''}`}
          style={{ background: "var(--adm-surface)", border: "1px solid var(--adm-border)" }}
        >
          <DialogHeader
            className="px-6 py-4"
            style={{ borderBottom: "1px solid var(--adm-bg)" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: "var(--adm-red-soft)" }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 16,
                    color: "var(--adm-red)",
                    fontVariationSettings: "'FILL' 1",
                  }}
                >
                  person_remove
                </span>
              </div>
              <DialogTitle
                className="text-[15px] font-bold"
                style={{ color: "var(--adm-red)" }}
              >
                {t("users.deleteTitle")}
              </DialogTitle>
            </div>
          </DialogHeader>

          <div className="px-6 py-5 space-y-4">
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--adm-text-2)" }}>
              {t("users.deleteBody1")}{" "}
              <strong style={{ color: "var(--adm-text-1)" }}>{deleteTarget?.name}</strong>{" "}
              {t("users.deleteBody2")}
            </p>
          </div>

          <DialogFooter
            className="px-6 py-4 flex items-center justify-end gap-2"
            style={{ borderTop: "1px solid var(--adm-bg)" }}
          >
            <button
              onClick={() => setDeleteOpen(false)}
              className="h-9 px-4 rounded-xl text-[13px] font-semibold transition-colors hover:bg-[var(--adm-bg)] cursor-pointer"
              style={{ color: "var(--adm-text-2)" }}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() =>
                deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })
              }
              disabled={deleteMutation.isPending}
              className="h-9 px-5 rounded-xl text-[13px] font-bold flex items-center gap-2 transition-opacity hover:opacity-90 cursor-pointer disabled:opacity-50"
              style={{
                background: "var(--adm-red-soft)",
                border: "1px solid var(--adm-red-soft-border)",
                color: "var(--adm-red)",
              }}
            >
              {deleteMutation.isPending && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {t("users.deleteConfirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 🔓 Unbind Device Dialog ─────────────────────────────────────────── */}
      <Dialog open={!!unbindTarget} onOpenChange={(open) => !open && setUnbindTarget(null)}>
        <DialogContent
          className={`p-0 overflow-hidden sm:rounded-2xl max-w-md admin-root ${theme === 'dark' ? 'dark' : ''}`}
          style={{ background: "var(--adm-surface)", border: "1px solid var(--adm-border)" }}
        >
          <DialogHeader
            className="px-6 py-4"
            style={{ borderBottom: "1px solid var(--adm-bg)" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: "var(--adm-blue-soft)" }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 18, color: "var(--adm-blue)" }}
                >
                  link_off
                </span>
              </div>
              <DialogTitle
                className="text-[15px] font-bold"
                style={{ color: "var(--adm-text-1)" }}
              >
                {t("users.unbindTitle")}
              </DialogTitle>
            </div>
          </DialogHeader>

          <div className="px-6 py-5 space-y-4">
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--adm-text-2)" }}>
              {t("users.unbindBody1")}{" "}
              <strong style={{ color: "var(--adm-text-1)" }}>{unbindTarget?.name}</strong>.
              {" "}{t("users.unbindBody2")}
            </p>
          </div>

          <DialogFooter
            className="px-6 py-4 flex items-center justify-end gap-2"
            style={{ borderTop: "1px solid var(--adm-bg)" }}
          >
            <button
              onClick={() => setUnbindTarget(null)}
              className="h-9 px-4 rounded-xl text-[13px] font-semibold transition-colors hover:bg-[var(--adm-bg)] cursor-pointer"
              style={{ color: "var(--adm-text-2)" }}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() =>
                unbindTarget && unbindMutation.mutate({ id: unbindTarget.id })
              }
              disabled={unbindMutation.isPending}
              className="h-9 px-5 rounded-xl text-[13px] font-bold flex items-center gap-2 transition-opacity hover:opacity-90 cursor-pointer disabled:opacity-50"
              style={{
                background: "var(--adm-blue-soft)",
                border: "1px solid var(--adm-blue-soft-border)",
                color: "var(--adm-blue)",
              }}
            >
              {unbindMutation.isPending && (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              )}
              {t("users.unbindConfirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
