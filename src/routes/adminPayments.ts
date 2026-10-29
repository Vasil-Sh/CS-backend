import {Hono} from 'hono';
import {pool} from '../db/client';
import {requireAuth,requireAdmin} from '../middleware/auth';
import {parsePayment,extendedEnd} from '../services/paymentRules';
const routes=new Hono();
const columns=`id::text,user_id AS "userId",username,amount::text,currency,paid_on::text AS "paidOn",period_start::text AS "periodStart",period_end::text AS "periodEnd",note,extend_subscription AS "extendSubscription",created_by_name AS "createdBy",created_at AS "createdAt",status,cancelled_by_name AS "cancelledBy",cancelled_at AS "cancelledAt",cancel_reason AS "cancelReason"`;
routes.get('/admin/users/:id/payments',requireAuth,requireAdmin,async c=>{
 const id=c.req.param('id')||'';if(!/^\d+$/.test(id))return c.json({error:'Invalid user'},400);
 const page=Math.max(1,Math.min(100000,Math.floor(Number(c.req.query('page'))||1)));
 const result=await pool.query(`SELECT ${columns} FROM admin_payments WHERE user_id::text=$1 ORDER BY paid_on DESC,id DESC LIMIT 21 OFFSET $2`,[id,(page-1)*20]);
 const summary=await pool.query(`SELECT COALESCE(SUM(amount),0)::text AS total, COUNT(*)::int AS count FROM admin_payments WHERE user_id::text=$1 AND status='recorded'`,[id]);
 const latest=await pool.query(`SELECT ${columns} FROM admin_payments WHERE user_id::text=$1 AND status='recorded' ORDER BY paid_on DESC,id DESC LIMIT 1`,[id]);
 return c.json({payments:result.rows.slice(0,20),hasMore:result.rows.length>20,summary:{...summary.rows[0],latest:latest.rows[0]||null}});
});
routes.post('/admin/users/:id/payments',requireAuth,requireAdmin,async c=>{
 const id=c.req.param('id')||'';if(!/^\d+$/.test(id))return c.json({error:'Invalid user'},400);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const input=parsePayment(await c.req.json().catch(()=>null),today);if(!input)return c.json({error:'Перевірте суму, дату оплати та період підписки. Майбутня дата оплати не допускається.'},400);
 const client=await pool.connect();
 try{await client.query('BEGIN');
  const user=await client.query('SELECT username,end_date::text AS "endDate" FROM users WHERE id::text=$1 FOR UPDATE',[id]);
  if(!user.rows.length){await client.query('ROLLBACK');return c.json({error:'Користувача не знайдено'},404)}
  const duplicate=await client.query('SELECT * FROM admin_payments WHERE request_id=$1',[input.requestId]);
  if(duplicate.rows.length){const d=duplicate.rows[0];const same=String(d.user_id)===id && Number(d.amount)===Number(input.amount) && d.note===input.note && d.extend_subscription===input.extendSubscription;
   const dates=await client.query('SELECT paid_on::text,period_start::text,period_end::text FROM admin_payments WHERE request_id=$1',[input.requestId]);const v=dates.rows[0];
   await client.query('ROLLBACK');if(!same || v.paid_on!==input.paidOn || v.period_start!==input.periodStart || v.period_end!==input.periodEnd)return c.json({error:'Запит уже використано для іншої оплати. Оновіть форму.'},409);
   return c.json({id:String(d.id),duplicate:true});}
  const actor=c.get('user');
  const result=await client.query(`INSERT INTO admin_payments(request_id,user_id,username,amount,paid_on,period_start,period_end,note,extend_subscription,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::text`,[input.requestId,id,user.rows[0].username,input.amount,input.paidOn,input.periodStart,input.periodEnd,input.note,input.extendSubscription,actor.userId,actor.username]);
  const before=user.rows[0].endDate;const after=input.extendSubscription?extendedEnd(before,input.periodEnd):before;
  if(after!==before)await client.query('UPDATE users SET end_date=$2,updated_at=now() WHERE id::text=$1',[id,after]);
  await client.query(`INSERT INTO admin_audit_log(actor_id,actor_name,action,target,details,status) VALUES($1,$2,'POST',$3,$4,'success')`,[actor.userId,actor.username,`/admin/users/${id}/payments`,JSON.stringify({targetUsername:user.rows[0].username,_targetUserId:id,paymentId:result.rows[0].id,amount:input.amount,currency:'UAH',paidOn:input.paidOn,periodStart:input.periodStart,periodEnd:input.periodEnd,extendSubscription:input.extendSubscription,...(after!==before?{_changes:{endDate:{before,after}}}:{})})]);
  await client.query('COMMIT');return c.json({id:result.rows[0].id},201);
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
});
routes.post('/admin/payments/:id/cancel',requireAuth,requireAdmin,async c=>{
 const id=c.req.param('id')||'';const body=await c.req.json().catch(()=>null);
 if(!/^\d+$/.test(id)||!body||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500)return c.json({error:'Вкажіть причину скасування (до 500 символів)'},400);
 const client=await pool.connect();try{await client.query('BEGIN');
  const result=await client.query('SELECT * FROM admin_payments WHERE id::text=$1 FOR UPDATE',[id]);const payment=result.rows[0];
  if(!payment){await client.query('ROLLBACK');return c.json({error:'Оплату не знайдено'},404)}
  if(payment.status==='cancelled'){await client.query('ROLLBACK');return c.json({success:true})}
  const actor=c.get('user');await client.query("UPDATE admin_payments SET status='cancelled',cancelled_by_name=$2,cancelled_at=now(),cancel_reason=$3 WHERE id::text=$1",[id,actor.username,body.reason.trim()]);
  await client.query(`INSERT INTO admin_audit_log(actor_id,actor_name,action,target,details,status) VALUES($1,$2,'POST',$3,$4,'success')`,[actor.userId,actor.username,`/admin/payments/${id}/cancel`,JSON.stringify({targetUsername:payment.username,_targetUserId:String(payment.user_id||''),paymentId:id,amount:payment.amount,cancelReason:body.reason.trim()})]);
  await client.query('COMMIT');return c.json({success:true});
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
});
export default routes;
