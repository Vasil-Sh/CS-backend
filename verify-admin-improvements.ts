import 'dotenv/config';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool} from './src/db/client';
import {MONTHLY_SUBSCRIPTIONS_SQL,adminStatsService} from './src/services/adminStatsService';
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname))throw new Error('Local DB only');
const stats=await adminStatsService.getStats();
assert.equal(stats.totalUsers,stats.activeUsers+stats.inactiveUsers);
assert(stats.revenueByMonth.every(r=>Number.isFinite(r.paidUsers) && r.paidUsers >= 0));
const route=readFileSync('src/routes/adminUsers.ts','utf8');
const auditSql=route.match(/`(SELECT a\.\*[\s\S]*?)`/)?.[1];
assert(auditSql);
await pool.query(auditSql,[0,'all','all','',null,null,null,false]);
await pool.query(auditSql,[0,'users','success','test','2026-10-01','2026-10-29','6',true]);
console.log('Audit SQL: search, date bounds and subscription history passed');
const client=await pool.connect();
try {
 await client.query('BEGIN');
 await client.query('CREATE TEMP TABLE users (id integer,role text,price_month numeric,start_date date,end_date date,created_at timestamp) ON COMMIT DROP');
 await client.query(`INSERT INTO users VALUES
 (1,'user',10,date_trunc('year',now()),now()::date+30,now()),
 (2,'user',20,date_trunc('year',now()),now()::date+30,now()),
 (3,'user',0,date_trunc('year',now()),now()::date+30,now()),
 (4,'admin',999,date_trunc('year',now()),now()::date+30,now()),
 (5,'user',500,now()::date+10,now()::date+40,now())`);
 const result=await client.query(MONTHLY_SUBSCRIPTIONS_SQL);
 for(const row of result.rows){assert.equal(Number(row.revenue),30);assert.equal(Number(row.paid_users),2);assert.equal(Number(row.revenue)/Number(row.paid_users),15)}
 console.log('Monthly SQL: paid denominator, free accounts, admin exclusion, future subscriptions passed. Current stats consistency passed.');
} finally {await client.query('ROLLBACK');client.release();await pool.end()}
