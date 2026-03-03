/**
 * Database Migration Script
 * Drops old tables and creates new normalized schema
 * WARNING: This will delete all existing data!
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const DB_NAME = process.env.DB_NAME;

async function columnExists(table, column) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, table, column]
  );
  return (rows[0]?.c || 0) > 0;
}

async function ensureColumn(table, column, alterSql) {
  try {
    const exists = await columnExists(table, column);
    if (exists) return false;
    await db.query(alterSql);
    console.log(`✅ Patched ${table}: added column ${column}`);
    return true;
  } catch (e) {
    console.warn(`⚠️  Could not patch ${table}.${column}:`, e.message);
    return false;
  }
}

async function migrate() {
  try {
    console.log('🔄 Starting database migration...\n');

    // Read schema file
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaRaw = fs.readFileSync(schemaPath, 'utf8');

    // Remove full-line SQL comments that start with --
    // Important: do NOT drop statements that merely *contain* inline -- comments.
    const schema = schemaRaw.replace(/^\s*--.*$/gm, '').trim();

    // Split by semicolon and execute each statement
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    console.log(`📝 Found ${statements.length} SQL statements to execute\n`);

    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.length > 10) { // Skip very short statements
        try {
          await db.query(statement);
          console.log(`✅ Executed statement ${i + 1}/${statements.length}`);
        } catch (err) {
          // Ignore "table already exists" errors
          if (!err.message.includes('already exists')) {
            console.error(`❌ Error in statement ${i + 1}:`, err.message);
          }
        }
      }
    }

    // Post-migration patch: allow same category name across different types
    // (e.g., "General" for both posts and notices)
    try {
      await db.query('ALTER TABLE categories DROP INDEX name');
    } catch (e) {
      // ignore if index doesn't exist / already dropped
    }
    try {
      await db.query('ALTER TABLE categories ADD UNIQUE KEY unique_name_type (name, type)');
    } catch (e) {
      // ignore if already exists
    }

    // Patch legacy tables to match the normalized schema (no data inserted)
    // users
    await ensureColumn(
      'users',
      'status',
      "ALTER TABLE users ADD COLUMN status ENUM('active','inactive','suspended') DEFAULT 'active'"
    );
    await ensureColumn(
      'users',
      'last_login',
      'ALTER TABLE users ADD COLUMN last_login TIMESTAMP NULL'
    );

    // posts
    await ensureColumn(
      'posts',
      'category_id',
      'ALTER TABLE posts ADD COLUMN category_id INT NULL'
    );
    await ensureColumn(
      'posts',
      'view_count',
      'ALTER TABLE posts ADD COLUMN view_count INT DEFAULT 0'
    );
    await ensureColumn(
      'posts',
      'updated_at',
      'ALTER TABLE posts ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    );

    // notices
    await ensureColumn(
      'notices',
      'category_id',
      'ALTER TABLE notices ADD COLUMN category_id INT NULL'
    );
    await ensureColumn(
      'notices',
      'target_audience',
      "ALTER TABLE notices ADD COLUMN target_audience ENUM('all','students','faculty','staff') DEFAULT 'all'"
    );
    await ensureColumn(
      'notices',
      'is_pinned',
      'ALTER TABLE notices ADD COLUMN is_pinned TINYINT(1) DEFAULT 0'
    );
    await ensureColumn(
      'notices',
      'view_count',
      'ALTER TABLE notices ADD COLUMN view_count INT DEFAULT 0'
    );
    await ensureColumn(
      'notices',
      'expires_at',
      'ALTER TABLE notices ADD COLUMN expires_at DATETIME NULL'
    );
    await ensureColumn(
      'notices',
      'updated_at',
      'ALTER TABLE notices ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    );

    // resources (so API can read new fields even if you haven't populated buildings yet)
    await ensureColumn(
      'resources',
      'building_id',
      'ALTER TABLE resources ADD COLUMN building_id INT NULL'
    );
    await ensureColumn(
      'resources',
      'floor_number',
      'ALTER TABLE resources ADD COLUMN floor_number VARCHAR(50) NULL'
    );
    await ensureColumn(
      'resources',
      'capacity',
      'ALTER TABLE resources ADD COLUMN capacity INT NULL'
    );
    await ensureColumn(
      'resources',
      'equipment',
      'ALTER TABLE resources ADD COLUMN equipment TEXT NULL'
    );
    await ensureColumn(
      'resources',
      'updated_at',
      'ALTER TABLE resources ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    );

    console.log('\n Schema migration completed!\n');
    console.log(' Database migration complete!\n');
    console.log(' Summary:');
    console.log(' - Schema created/updated');
    console.log(' - No sample data inserted (tables are empty on purpose)');
    console.log(' - Ready for you to insert real data via the app UI.\n');

    process.exit(0);
  } catch (err) {
    console.error(' Migration failed:', err);
    process.exit(1);
  }
}

migrate();
