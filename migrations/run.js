#!/usr/bin/env node
// Runs migration SQL against Supabase PostgreSQL directly
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];

const sql = fs.readFileSync(path.join(__dirname, '001_sports_tables.sql'), 'utf8');

// Connection configs to try (Supabase pooler with JWT auth)
const configs = [
  {
    label: 'Pooler (eu-central-1, transaction mode)',
    host: `aws-0-eu-central-1.pooler.supabase.com`,
    port: 6543,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password: SERVICE_KEY,
    ssl: { rejectUnauthorized: false },
  },
  {
    label: 'Pooler (eu-central-1, session mode)',
    host: `aws-0-eu-central-1.pooler.supabase.com`,
    port: 5432,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password: SERVICE_KEY,
    ssl: { rejectUnauthorized: false },
  },
  {
    label: 'Pooler (us-east-1, transaction mode)',
    host: `aws-0-us-east-1.pooler.supabase.com`,
    port: 6543,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password: SERVICE_KEY,
    ssl: { rejectUnauthorized: false },
  },
  {
    label: 'Pooler (us-west-1, transaction mode)',
    host: `aws-0-us-west-1.pooler.supabase.com`,
    port: 6543,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password: SERVICE_KEY,
    ssl: { rejectUnauthorized: false },
  },
  {
    label: 'Direct DB connection',
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: SERVICE_KEY,
    ssl: { rejectUnauthorized: false },
  },
];

async function tryConnect(config) {
  const client = new Client(config);
  client.on('error', () => {}); // suppress unhandled
  await client.connect();
  return client;
}

async function run() {
  let client = null;

  for (const config of configs) {
    try {
      process.stdout.write(`Trying ${config.label}... `);
      client = await tryConnect(config);
      console.log('Connected!');
      break;
    } catch (err) {
      console.log(`Failed (${err.message.substring(0, 60)})`);
      client = null;
    }
  }

  if (!client) {
    console.error('\nCould not connect to database with any method.');
    console.error('Please run the migration SQL manually in the Supabase SQL Editor:');
    console.error(`  https://supabase.com/dashboard/project/${projectRef}/sql/new`);
    process.exit(1);
  }

  try {
    console.log('\nRunning migration...');
    await client.query(sql);
    console.log('Migration completed successfully!');

    // Verify tables were created
    const result = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('sports', 'leagues', 'teams', 'players', 'matches', 'standings')
      ORDER BY table_name
    `);
    console.log(`\nVerified tables: ${result.rows.map(r => r.table_name).join(', ')}`);
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
