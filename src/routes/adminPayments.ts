import {Hono} from 'hono';
import {pool} from '../db/client';
import {requireAuth,requireAdmin} from '../middleware/auth';
import {parsePayment,extendedEnd} from '../services/paymentRules';
import {telegramBotService} from '../services/telegramBot';
import {recordAudit} from '../services/auditLog';
import {adminUsersService} from '../services/adminUsersService';
import {receiptCaption,isPng,telegramErrorMessage,RECEIPT_MAX_BYTES} from '../services/receipts';
const routes=new Hono();
const columns=`id::text,user_id AS "userId",username,amount::text,currency,paid_on::text AS "paidOn",period_start::text AS "periodStart",period_end::text AS "periodEnd",note,extend_subscription AS "extendSubscription",created_by_name AS "createdBy",created_at AS "createdAt",status,cancelled_by_name AS "cancelledBy",cancelled_at AS "cancelledAt",cancel_reason AS "cancelReason",payment_method AS "paymentMethod",refunded_amount::text AS "refundedAmount",refund_reason AS "refundReason",refunded_at AS "refundedAt",refunded_by AS "refundedBy",promo_code AS "promoCode"`;

// GET /admin/payments — platform-wide payments with optional status/month filters
routes.get('/admin/payments',requireAuth,requireAdmin,async c=>{
 const status=c.req.query('status')||'';
 const month=c.req.query('month')||'';
 if(status && !['recorded','cancelled','refunded'].includes(status))return c.json({error:'Invalid status'},400);
 if(month && !/^\d{4}-\d{2}$/.test(month))return c.json({error:'Invalid month (YYYY-MM)'},400);
 const page=Math.max(1,Math.min(100000,Math.floor(Number(c.req.query('page'))||1)));
 const where:string[]=[];const params:any[]=[];
 if(status){params.push(status);where.push(`status=$${params.length}`)}
 if(month){params.push(month);where.push(`to_char(paid_on,'YYYY-MM')=$${params.length}`)}
 const w=where.length?`WHERE ${where.join(' AND ')}`:'';
 const result=await pool.query(`SELECT ${columns} FROM admin_payments ${w} ORDER BY paid_on DESC,id DESC LIMIT 21 OFFSET $${params.length+1}`,[...params,(page-1)*20]);
 const summary=await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='recorded'),0)::text AS recorded, COALESCE(SUM(refunded_amount),0)::text AS refunded, COUNT(*)::int AS total FROM admin_payments ${w}`,[...params]);
 return c.json({payments:result.rows.slice(0,20),hasMore:result.rows.length>20,summary:summary.rows[0]});
});

// POST /admin/payments/:id/refund — refund a recorded payment
routes.post('/admin/payments/:id/refund',requireAuth,requireAdmin,async c=>{
 const id=c.req.param('id')||'';const body=await c.req.json().catch(()=>null);
 if(!/^\d+$/.test(id)||!body||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>500)return c.json({error:'Вкажіть причину повернення (до 500 символів)'},400);
 const amount=body.amount===undefined||body.amount===null?null:Number(body.amount);
 if(amount!==null && (!Number.isFinite(amount)||amount<=0))return c.json({error:'Некоректна сума повернення'},400);
 const client=await pool.connect();try{await client.query('BEGIN');
  const result=await client.query('SELECT * FROM admin_payments WHERE id::text=$1 FOR UPDATE',[id]);const payment=result.rows[0];
  if(!payment){await client.query('ROLLBACK');return c.json({error:'Оплату не знайдено'},404)}
  if(payment.status==='refunded'){await client.query('ROLLBACK');return c.json({success:true})}
  const actor=c.get('user');const refund=amount??Number(payment.amount);
  if(refund>Number(payment.amount)){await client.query('ROLLBACK');return c.json({error:'Сума повернення більша за оплату'},400)}
  await client.query("UPDATE admin_payments SET status='refunded',refunded_amount=$2,refund_reason=$3,refunded_at=now(),refunded_by=$4 WHERE id::text=$1",[id,refund,body.reason.trim(),actor.username]);
  await client.query(`INSERT INTO admin_audit_log(actor_id,actor_name,action,target,details,status) VALUES($1,$2,'POST',$3,$4,'success')`,[actor.userId,actor.username,`/admin/payments/${id}/refund`,JSON.stringify({targetUsername:payment.username,_targetUserId:String(payment.user_id||''),paymentId:id,amount:payment.amount,refundedAmount:refund,refundReason:body.reason.trim()})]);
  // A refund cancels the subscription now: access closes today.
  if(payment.user_id){await client.query(`UPDATE users SET subscription_cancelled_at=now(),subscription_cancel_mode='now',subscription_cancel_reason=$2,end_date=LEAST(end_date,((now() AT TIME ZONE 'Europe/Kyiv')::date - 1)),pro_until=NULL,plan=COALESCE(pro_base_plan,plan),pro_base_plan=NULL WHERE id=$1 AND role<>'admin'`,[payment.user_id,'Повернення: '+body.reason.trim()])}
  await client.query('COMMIT');adminUsersService.invalidateOverview();return c.json({success:true,refundedAmount:refund});
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
});
// POST /admin/payments/:id/receipt/send — send a PNG receipt to the user's Telegram (multipart field "photo")
routes.post('/admin/payments/:id/receipt/send',requireAuth,requireAdmin,async c=>{
 const id=c.req.param('id')||'';if(!/^\d+$/.test(id))return c.json({error:'Invalid payment'},400);
 let form:Record<string,unknown>;
 try{form=await c.req.parseBody()}catch{return c.json({error:'Надішліть чек як multipart/form-data з полем photo'},400)}
 const photo=form.photo;
 if(!photo||typeof photo==='string'||typeof (photo as File).arrayBuffer!=='function')return c.json({error:'Додайте зображення чека (PNG) у поле photo'},400);
 const file=photo as File;
 if(file.size===0||file.size>RECEIPT_MAX_BYTES)return c.json({error:'Чек має бути PNG до 2 МБ'},400);
 const buffer=Buffer.from(await file.arrayBuffer());
 if(!isPng(buffer))return c.json({error:'Чек має бути PNG до 2 МБ'},400);
 const result=await pool.query(`SELECT p.id::text,p.amount::text,p.paid_on::text AS "paidOn",p.period_start::text AS "periodStart",p.period_end::text AS "periodEnd",p.status,p.user_id AS "userId",p.username,u.telegram_chat_id AS "chatId" FROM admin_payments p LEFT JOIN users u ON u.id=p.user_id WHERE p.id::text=$1`,[id]);
 const payment=result.rows[0];
 if(!payment)return c.json({error:'Оплату не знайдено'},404);
 if(payment.status!=='recorded')return c.json({error:'Скасовану або повернену оплату не надсилаємо'},409);
 if(!payment.chatId)return c.json({error:'Користувач ще не запустив бота — попросіть натиснути /start'},409);
 if(!telegramBotService.isConfigured())return c.json({error:'Telegram-бот не налаштований на сервері'},503);
 try{await telegramBotService.sendPhoto(payment.chatId,buffer,receiptCaption(payment))}
 catch(error){const t=telegramErrorMessage((error as Error).message);return c.json({error:t.message},t.status)}
 const actor=c.get('user');const sentAt=new Date().toISOString();
 await recordAudit(actor,'POST',`/admin/payments/${id}/receipt/send`,{fields:{targetUsername:payment.username,_targetUserId:String(payment.userId||''),paymentId:id,amount:payment.amount,sentAt}});
 return c.json({success:true,sentAt});
});
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
  const result=await client.query(`INSERT INTO admin_payments(request_id,user_id,username,amount,paid_on,period_start,period_end,note,extend_subscription,created_by,created_by_name,payment_method,promo_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id::text`,[input.requestId,id,user.rows[0].username,input.amount,input.paidOn,input.periodStart,input.periodEnd,input.note,input.extendSubscription,actor.userId,actor.username,input.paymentMethod,input.promoCode]);
  const before=user.rows[0].endDate;const after=input.extendSubscription?extendedEnd(before,input.periodEnd):before;
  if(after!==before)await client.query('UPDATE users SET end_date=$2,subscription_cancelled_at=NULL,subscription_cancel_mode=NULL,subscription_cancel_reason=NULL,updated_at=now() WHERE id::text=$1',[id,after]);
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
