/**
 * apply-indexes.mjs
 * ══════════════════════════════════════════════════════════
 * بينشئ الـ indexes المطلوبة للسرعة بشكل آمن (idempotent):
 * بيفحص information_schema الأول — لو موجود مش هيلمسه.
 *
 * الاستخدام:
 *   node scripts/apply-indexes.mjs
 */

import "dotenv/config";
import mysql from "mysql2/promise";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL مفقود — حطه في .env");
  process.exit(1);
}

// نفس الـ indexes المعرفة في drizzle/schema.ts
const INDEXES = [
  { table: "visits", name: "idx_visits_manager_checkin", columns: "(managerId, checkInAt)" },
  { table: "visits", name: "idx_visits_manager_status", columns: "(managerId, status)" },
  { table: "visits", name: "idx_visits_checkin_at", columns: "(checkInAt)" },
  { table: "locationLogs", name: "idx_locationLogs_manager_timestamp", columns: "(managerId, timestamp)" },
  { table: "managerBranches", name: "idx_managerBranches_manager", columns: "(managerId)" },
];

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  console.log("✅ اتصلنا بالداتابيز\n");

  let created = 0;
  let skipped = 0;

  for (const idx of INDEXES) {
    try {
      const [existing] = await conn.query(
        `SELECT COUNT(*) AS c FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [idx.table, idx.name]
      );

      if (existing[0].c > 0) {
        console.log(`  ⏭️  ${idx.name} موجود بالفعل — تم تخطيه`);
        skipped++;
        continue;
      }

      console.log(`  ⏳ جاري إنشاء ${idx.name} على ${idx.table}...`);
      await conn.query(`ALTER TABLE \`${idx.table}\` ADD INDEX \`${idx.name}\` ${idx.columns}`);
      console.log(`  ✅ اتعمل ${idx.name}`);
      created++;
    } catch (err) {
      console.error(`  ❌ ${idx.name}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  await conn.end();
  console.log(`\n🎉 خلصنا: ${created} اتضافوا، ${skipped} كانوا موجودين`);
}

main().catch((err) => {
  console.error("❌ فشل:", err.message);
  process.exit(1);
});
