import 'dotenv/config';import pg from 'pg';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {Hono} from 'hono';
import {pool} from './src/db/client';import routes from './src/routes/adminPayments';
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname))throw new Error('Local database required');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
try {
 await client.query('SET search_path=pg_temp');
 await client.query("CREATE TEMP TABLE users(id int PRIMARY KEY,username varchar(100),end_date date,updated_at timestamptz)");
 await client.query("INSERT INTO users VALUES (6,'fixture_user','2026-10-29',now())");
 await client.query(readFileSync('src/db/migrations/0013_admin_payments.sql','utf8').replace('CREATE TABLE IF NOT EXISTS admin_payments','CREATE TEMP TABLE admin_payments'));
 await client.query("CREATE TEMP TABLE admin_audit_log(id serial,actor_id int,actor_name text,action text,target text,details jsonb,status text)");
 // Only this isolated test process uses this connection; all tables and sequences are temporary.
 pool.connect=(async()=>({query:client.query.bind(client),release(){}})) as never;
 pool.query=client.query.bind(client) as never;
 const app=new Hono();app.use('*',async(c,next)=>{const role=c.req.header('x-test-role');if(role)c.set('user',{userId:1,username:'fixture_admin',role} as never);await next()});app.route('/',routes);
 const data={requestId:'44aa44aa-1111-4111-8111-111111111111',amount:'250.50',paidOn:'2026-10-28',periodStart:'2026-10-29',periodEnd:'2026-11-27',note:'fixture',extendSubscription:true};
 const send=(path:string,body:unknown,role='admin')=>app.request(path,{method:'POST',headers:{'Content-Type':'application/json','x-test-role':role},body:JSON.stringify(body)});
 assert.equal((await send('/admin/users/6/payments',data,'user')).status,403);
 assert.equal((await app.request('/admin/users/6/payments')).status,401);
 const created=await send('/admin/users/6/payments',data);assert.equal(created.status,201);const {id}=await created.json() as {id:string};
 assert.equal((await client.query("SELECT end_date::text FROM users WHERE id=6")).rows[0].end_date,'2026-11-27');
 assert.equal((await send('/admin/users/6/payments',data)).status,200);
 assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM admin_payments')).rows[0].count,1);
 assert.equal((await send('/admin/users/6/payments',{...data,amount:'251'})).status,409);
 const list=await app.request('/admin/users/6/payments',{headers:{'x-test-role':'admin'}});assert.equal(list.status,200);assert.equal((await list.json() as {payments:unknown[]}).payments.length,1);
 assert.equal((await send(`/admin/payments/${id}/cancel`,{reason:'wrong entry'})).status,200);
 assert.equal((await send(`/admin/payments/${id}/cancel`,{reason:'again'})).status,200);
 assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM admin_audit_log")).rows[0].count,2);
 assert.equal((await client.query("SELECT COALESCE(SUM(amount),0)::text AS amount FROM admin_payments WHERE status='recorded'")).rows[0].amount,'0');
 assert.equal((await client.query("SELECT end_date::text FROM users WHERE id=6")).rows[0].end_date,'2026-11-27');
 await client.query("ALTER TABLE admin_audit_log ADD CONSTRAINT force_failure CHECK(action <> 'POST') NOT VALID");
 const failure=await send('/admin/users/6/payments',{...data,requestId:'44aa44aa-2222-4222-8222-222222222222',periodEnd:'2026-12-31'});assert.equal(failure.status,500);
 assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM admin_payments')).rows[0].count,1);
 assert.equal((await client.query("SELECT end_date::text FROM users WHERE id=6")).rows[0].end_date,'2026-11-27');
 await client.query('DELETE FROM users WHERE id=6');assert.equal((await client.query('SELECT username,user_id FROM admin_payments')).rows[0].username,'fixture_user');
 console.log('Payments: auth, create, extension, retry deduplication, conflict, list, cancellation, audit rollback, deletion preservation passed. Temporary tables only.');
}finally{await client.end();await pool.end()}
