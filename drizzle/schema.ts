import { decimal, int, index, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: varchar("passwordHash", { length: 255 }).notNull(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  role: mysqlEnum("role", ["user", "admin", "superadmin"]).default("user").notNull(),

  // ── نظام التشغيل الخاص بالمدير ──────────────────────────────────────────────
  // android = يعمل فقط من التطبيق النيتف (لا ويب)
  // ios     = يعمل من المتصفح (Safari) — تسجيل يدوي دائماً بدون geofence تلقائي
  os: mysqlEnum("os", ["android", "ios"]).default("android").notNull(),

  // وضع تسجيل الحضور: automatic = الجيوفنس يدخل ويخرج تلقائياً
  // manual = المدير يضغط يدوياً على دخول/خروج
  checkinMode: mysqlEnum("checkinMode", ["automatic", "manual"]).default("automatic").notNull(),

  // ── ربط الجهاز (Device Binding) ────────────────────────────────────────────
  // بصمة الموبايل المسموح له فقط بالدخول — تُربط تلقائياً بأول تسجيل دخول
  // من التطبيق، والأدمن يقدر يفكها من لوحة التحكم لو المستخدم غيّر جهازه
  boundDeviceId: varchar("boundDeviceId", { length: 128 }),
  deviceBoundAt: timestamp("deviceBoundAt"),

  // ── ربط المتصفح (Web Fingerprint Binding) ──────────────────────────────────
  // بصمة المتصفح/الجهاز المسموح له بالدخول من الويب (Safari/Chrome على الآيفون)
  // تُربط تلقائياً بأول تسجيل دخول من المتصفح
  // الأدمن يقدر يفكها لو المدير بدّل موبايل آيفون
  boundWebFingerprint: varchar("boundWebFingerprint", { length: 256 }),
  webFingerprintAt: timestamp("webFingerprintAt"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ── Branches ────────────────────────────────────────────────────────────────
export const branches = mysqlTable("branches", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  address: text("address"),
  latitude: text("latitude").notNull(),
  longitude: text("longitude").notNull(),
  geofenceRadiusMeters: int("geofenceRadiusMeters").default(200).notNull(),
  isActive: mysqlEnum("isActive", ["yes", "no"]).default("yes").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Branch = typeof branches.$inferSelect;
export type InsertBranch = typeof branches.$inferInsert;

// ── Managers ────────────────────────────────────────────────────────────────
export const managers = mysqlTable("managers", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  employeeCode: varchar("employeeCode", { length: 64 }),
  phone: varchar("phone", { length: 32 }),
  photoUrl: varchar("photoUrl", { length: 512 }),
  isActive: mysqlEnum("isActive", ["yes", "no"]).default("yes").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Manager = typeof managers.$inferSelect;
export type InsertManager = typeof managers.$inferInsert;

// ── Manager ↔ Branch assignments ────────────────────────────────────────────
export const managerBranches = mysqlTable("managerBranches", {
  id: int("id").autoincrement().primaryKey(),
  managerId: int("managerId").notNull(),
  branchId: int("branchId").notNull(),
  // ⭐ الفرع الأساسي: "yes" = فرع مسؤولية مباشرة، "no" = فرع مسموح به فقط
  isPrimary: mysqlEnum("isPrimary", ["yes", "no"]).default("no").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_managerBranches_manager").on(table.managerId),
]);

export type ManagerBranch = typeof managerBranches.$inferSelect;

// ── Visits ──────────────────────────────────────────────────────────────────
export const visits = mysqlTable("visits", {
  id: int("id").autoincrement().primaryKey(),
  managerId: int("managerId").notNull(),
  // branchId قابل للـ null عشان المأموريات الخارجية (زيارات العملاء خارج الفروع)
  branchId: int("branchId"),
  // نوع الزيارة: branch = زيارة فرع عادية، external_mission = مأمورية خارجية
  visitType: mysqlEnum("visitType", ["branch", "external_mission"]).default("branch").notNull(),
  // noteType: short_visit = سبب الزيارة القصيرة، non_primary = سبب زيارة فرع غير أساسي
  noteType: mysqlEnum("noteType", ["general", "short_visit", "non_primary", "external_mission"]).default("general").notNull(),
  // ── نطاق المأمورية الخارجية التلقائي (جيوفنس) ──────────────────────────────
  // مركز المأمورية ونصف قطرها بالمتر — يُخزن عند checkIn لمأمورية external_mission فقط
  // ويُستخدم للخروج التلقائي لما المدير يخرج من نطاق المأمورية
  missionLatitude: text("missionLatitude"),
  missionLongitude: text("missionLongitude"),
  missionRadiusMeters: int("missionRadiusMeters").default(200),
  // ── أقرب فرع للمأمورية الخارجية — يُخزن عند checkIn لمأمورية external_mission فقط ──
  // ليعرف الأدمن أقرب فرع للإحداثيات المسجلة ومدى بعدها عنه
  nearestBranchId: int("nearestBranchId"),
  nearestBranchName: varchar("nearestBranchName", { length: 255 }),
  nearestBranchDistanceKm: decimal("nearestBranchDistanceKm", { precision: 8, scale: 2 }),
  checkInAt: timestamp("checkInAt").defaultNow().notNull(),
  checkOutAt: timestamp("checkOutAt"),
  latitudeIn: text("latitudeIn").notNull(),
  longitudeIn: text("longitudeIn").notNull(),
  accuracyIn: text("accuracyIn"),
  photoUrl: text("photoUrl"),
  notes: text("notes"),
  status: mysqlEnum("status", ["checked_in", "checked_out"]).default("checked_in").notNull(),
  isMocked: mysqlEnum("isMocked", ["yes", "no"]).default("no").notNull(),
  distanceToPrevBranchKm: decimal("distanceToPrevBranchKm", { precision: 8, scale: 2 }), // المسافة بالكيلومتر من الفرع السابق — decimal عشان يحفظ الكسور (7.5 كم مثلاً)

  // ── نظام كشف التلاعب المتقدم ──────────────────────────────────────────────
  // suspicionScore: مجموع نقاط الشك (0 = نظيف، كل طبقة بتضيف نقاط)
  // 0–24   → نظيف
  // 25–49  → مريب — يستحق مراجعة
  // 50–74  → مشبوه جداً
  // 75+    → وهمي على الأرجح
  suspicionScore: int("suspicionScore").default(0).notNull(),

  // mockReasons: JSON array بأسباب الشك — بيساعد الأدمن يفهم ليه اتعلمت مشبوهة
  // مثال: ["DEVELOPER_OPTIONS_ON", "ACCURACY_PERFECT_INTEGER", "SENSOR_STATIONARY"]
  mockReasons: text("mockReasons"),

  // ── اعتماد المأموريات الخارجية — المأمورية الجديدة تتسجل "pending" ويُراجعها الأدمن ──
  // default "approved" عشان الصفوف القديمة وزيارات الفروع تبقى معتمدة تلقائياً
  approvalStatus: mysqlEnum("approvalStatus", ["pending", "approved", "rejected"]).default("approved"),
  reviewedAt: timestamp("reviewedAt"),
  reviewedByUserId: int("reviewedByUserId"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  // فهرس التاريخ الرئيسي — كل استعلامات السجل والتقارير بتمشي عليه
  index("idx_visits_manager_checkin").on(table.managerId, table.checkInAt),
  // بحث الزيارة المفتوحة (checked_in) لكل مدير
  index("idx_visits_manager_status").on(table.managerId, table.status),
  // فهرس الترتيب الزمني العام — recentVisits/adminList/stats بترتب وتفلتر بـ checkInAt لوحده
  index("idx_visits_checkin_at").on(table.checkInAt),
]);

export type Visit = typeof visits.$inferSelect;
export type InsertVisit = typeof visits.$inferInsert;

// ── Location Logs (Background/Offline Tracking) ─────────────────────────────
export const locationLogs = mysqlTable("locationLogs", {
  id: int("id").autoincrement().primaryKey(),
  managerId: int("managerId").notNull(),
  latitude: text("latitude").notNull(),
  longitude: text("longitude").notNull(),
  accuracy: text("accuracy"),
  timestamp: timestamp("timestamp").notNull(), // The actual time the location was recorded on device
  syncedAt: timestamp("syncedAt").defaultNow().notNull(), // When it was sent to server
}, (table) => [
  // التتبع اللحظي + مسار اليوم كله بيقرأوا من الفهرس ده
  index("idx_locationLogs_manager_timestamp").on(table.managerId, table.timestamp),
]);

export type LocationLog = typeof locationLogs.$inferSelect;
export type InsertLocationLog = typeof locationLogs.$inferInsert;
