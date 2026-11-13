# API_ADMIN.md — адміністративні ендпоінти

Довідник для адмінки MatchIQ. Усі шляхи доступні під `/api/v1` і `/api` (дублюються), авторизація — `Authorization: Bearer <token>` (JWT) або httpOnly cookie. Ендпоінти з `requireAdmin` доступні лише ролі `admin`.

Базовий URL (dev): `http://localhost:3001/api`.

---

## Автентифікація та сесії

### `POST /auth/login`
Тіло: `{ username: string, password: string }`.

Відповідь (200): `{ success: true, isAdmin: boolean, token: string, refreshToken: string, user: { id, username, role, telegram?, isOwner? } }`.

Помилки:
- `401` `{ success: false, error, attemptsLeft: number }` — невірний логін/пароль.
- `429` `{ success: false, error, attemptsLeft: 0, retryAfter: number }` — блокування на 5 хв після 5 невдалих спроб (retryAfter у секундах).

### `POST /auth/refresh`
Тіло: `{ refreshToken: string }` → `{ token, refreshToken }`.

### `POST /auth/logout`
Без тіла. Відкликає поточний access-токен.

### `GET /auth/sessions` (auth)
→ `{ sessions: [{ id, refreshJti, ip, userAgent, createdAt, lastSeenAt, current }] }`.

### `DELETE /auth/sessions/:id` (auth)
Завершити одну зі своїх сесій → `{ success: true }`; `404`, якщо сесію не знайдено.

### `POST /auth/logout-all` (auth)
Тіло (необовʼязково): `{ refreshToken }` поточного пристрою.
Усі токени, видані до цього моменту, перестають працювати (час зберігається в `users.sessions_revoked_at`, міграція `0023`).
→ `{ success: true, revoked: number, revokedAt: ISO, token, refreshToken }` — нова пара токенів для пристрою, з якого натиснули, щоб він лишився в системі.

Інші пристрої на наступному запиті (або при оновленні токена) отримують `401 { error: "Session revoked", code: "SESSIONS_REVOKED", revokedAt }` — адмінка показує «Вас вийшло з усіх пристроїв (… HH:MM)».
Одна завершена сесія (`DELETE /auth/sessions/:id`) дає `401 { code: "SESSION_REVOKED" }` при оновленні токена.

### `POST /auth/change-password` (auth)
Тіло: `{ currentPassword: string, newPassword: string }` → `{ success: true }`.

### `GET /auth/me` (auth)
→ `{ id, username, role, isOwner, telegram, plan, trialEndDate, ageConfirmed, startDate, endDate }`.

### `GET /auth/users` (admin)
Список користувачів: `[{ id, username, role, isOwner, telegram, priceMonth, plan, trialEndDate, ageConfirmed, startDate, endDate, createdAt }]`.

### `POST /auth/register` (admin)
Створення користувача. Тіло: `{ username, telegram, role, priceMonth, startDate, endDate }` → `{ username, password }` (згенерований пароль показується один раз). Пишеться в аудит.

### `PUT /auth/users/:id` (admin)
Оновлення користувача. Приймає зокрема `plan` (`trial|basic|pro`), `trialEndDate`, `ageConfirmed`, `birthDate`, `priceMonth`, `startDate`, `endDate`, `telegram`, `role`, `isOwner`. Пишеться в аудит (до/після).

### `DELETE /auth/users/:id` (admin)
Видалення користувача (з перевіркою owner-правил). Пишеться в аудит.

### `POST /auth/users/:id/reset-password` (admin)
→ `{ password }` — новий тимчасовий пароль. Пишеться в аудит.

---

## Дашборд

### `GET /admin/stats` (admin)
Приклад відповіді (скорочено):

```json
{
  "paymentsByMonth": [{ "month": "2026-11", "amount": 1200, "count": 2 }],
  "totalUsers": 10, "activeUsers": 7, "adminUsers": 1, "inactiveUsers": 2,
  "newThisMonth": 3, "mrr": 900,
  "revenueByMonth": [{ "month": "2026-11", "revenue": 900, "paidUsers": 2 }],
  "registrationsByMonth": [{ "month": "2026-11", "count": 3 }],
  "recentRegistrations": [{ "username": "user1", "date": "2026-11-13", "price": 300 }],
  "planDistribution": [{ "plan": "pro", "label": "Pro", "count": 1, "price": 600 }],
  "conversion": { "trial": 5, "paid": 2, "last30": { "trialEnded": 3, "converted": 1 } },
  "cancellations": { "total": 1, "byMonth": [{ "month": "2026-11", "count": 1 }] },
  "refunds": { "total": 300, "month": 300, "byMonth": [{ "month": "2026-11", "amount": 300, "count": 1 }] },
  "recentPayments": [{ "id": "1", "username": "user1", "amount": 300, "paidOn": "2026-11-13", "status": "recorded", "extendSubscription": false, "promoCode": "", "plan": "basic" }],
  "retention": { "retained": 2, "churned": 1, "byMonth": [{ "month": "2026-11", "ended": 1, "renewed": 0 }] },
  "selfLimitation": { "new": 1, "latest": [{ "id": "1", "username": "user1", "periodDays": 7, "status": "new", "createdAt": "..." }] },
  "aiUsage": { "calls": 5, "costUsd": 0.01, "tokens": 1000, "usdToUah": 41.5, "today": { "calls": 1, "costUsd": 0 }, "byMonth": [{ "month": "2026-11", "costUsd": 0.01, "calls": 5 }] },
  "parserFailures24h": 0,
  "openSupportTickets": 0,
  "unverifiedAge": 2,
  "ageUnverified": [{ "username": "user2" }]
}
```

Поля, додані в цій ітерації:
- `conversion.last30` — пробний → платний за 30 днів.
- `retention.byMonth` — помісячно (останні 6 міс): `ended` / `renewed`.
- `selfLimitation` — нові/останні запити на самообмеження (з `self_limitation_requests`).
- `aiUsage.byMonth[].calls` і `aiUsage.usdToUah`.
- `recentPayments[].promoCode` і `recentPayments[].plan`.
- `unverifiedAge` (по `age_confirmed=false`) і `ageUnverified` (перші 3 логіни).

### `GET /admin/insights` (admin)
→ `{ aiUsage: [{ provider, calls, promptTokens, completionTokens, costUsd }], parserFailures: [{ source, count, lastFailure }], supportTickets: { open }, ageVerification: { unverifiedAge } }`.

### `GET /admin/parsers` (admin)
→ `{ parsers: [{ name, open, failures, failures24h, lastFailure }] }`.

### `POST /admin/parsers/:name/rerun` (admin)
Скидає circuit breaker парсера → `{ success: true }`.

---

## Користувачі

### `GET /admin/users` (admin)
Зведення зі ставками: `{ users: [{ id, username, role, telegram, priceMonth, plan, planLabel, trialEndDate, ageConfirmed, startDate, endDate, createdAt, betCount, wins, losses, pending, totalStaked, totalProfit, winRate, roi, initialBank, manualAdjustments, currentBank, lossStreak, lastBetDate, lastBetAt, extensions, lastPaymentDate, games: [...], isOwner, birthDate, paidTotal, paidCount, lastPaymentAmount, cancelledAt, refundedAmount, selfLimitedUntil, aiToday, proUntil, proBasePlan, subscriptionCancelledAt, subscriptionCancelMode }] }`.

`cancelledAt` — заповнено, якщо остання оплата скасована або повернена (тоді `refundedAmount` — сума повернення). `selfLimitedUntil` — до коли діє самообмеження. `aiToday` — скільки AI-аналізів користувач зробив сьогодні (за Києвом).

### `GET /admin/users/:id/card` (admin)
Картка користувача зі статистикою і нотаткою.

### `GET /admin/users/:id/bets` (admin)
Список ставок користувача.

Редагування й видалення користувачів — через `PUT /auth/users/:id` і `DELETE /auth/users/:id` (розділ «Автентифікація»).

### `PUT /admin/users/:id/note` (admin)
Нотатка (з версією для оптимістичного блокування).

---

## Оплати

### `GET /admin/payments` (admin)
Загальний список оплат. Query: `status` (`recorded|cancelled|refunded`), `month` (`YYYY-MM`), `page`.
→ `{ payments: [...], hasMore: boolean, summary: { recorded, refunded, total } }`.

### `POST /admin/users/:id/payments` (admin)
Запис оплати. Тіло: `{ requestId, amount, paidOn, periodStart, periodEnd, note, extendSubscription, paymentMethod?, promoCode? }`.

### `GET /admin/users/:id/payments` (admin)
Оплати одного користувача.

### `POST /admin/payments/:id/cancel` (admin)
Тіло `{ reason }` → `{ success: true }`.

### `POST /admin/payments/:id/refund` (admin)
Тіло `{ reason, amount? }` → `{ success: true, refundedAmount }`.

### `POST /admin/users/:id/grant-pro` (admin)
Тіло `{ days: 1–365, reason }` → `{ success, proUntil, basePlan, endDate }`. Pro діє від сьогодні (або від кінця вже виданого Pro) на N днів, потім план автоматично повертається до попереднього (перевірка раз на 30 хв). Кінець оплаченої підписки зсувається на ті самі N днів. Без оплати, з записом в аудит. Адміністраторам — `409`.

### `POST /admin/users/:id/subscription/cancel` (admin)
Тіло `{ mode: "end"|"now", reason? }` → `{ success, mode, endDate }`. `end` — доступ до кінця оплаченого періоду, далі без продовження; `now` — доступ закривається сьогодні (останній день — вчора). Нова оплата з продовженням знімає скасування. Аудит.

`POST /admin/payments/:id/refund` тепер також скасовує підписку одразу (доступ закривається сьогодні); сума повернення не може перевищувати оплату.

### `POST /admin/payments/:id/receipt/send` (admin)
Надсилає чек користувачу в Telegram. `multipart/form-data`, поле `photo` — PNG до 2 МБ (картинку чека формує адмінка).
Підпис під фото: сума, дата оплати й період підписки.

Відповідь (200): `{ success: true, sentAt: ISO }`. Запис в аудит: `target = /admin/payments/:id/receipt/send`, `details: { targetUsername, _targetUserId, paymentId, amount, sentAt }`.

Помилки:
- `400` — немає поля `photo`, файл не PNG або більший за 2 МБ.
- `404` — оплату не знайдено.
- `409` — оплату скасовано/повернено; користувач ще не натиснув `/start` у боті (немає `telegram_chat_id`); користувач заблокував бота або чат не знайдено.
- `502` — інша помилка Telegram API (текст помилки в `error`).
- `503` — на сервері не задано `TELEGRAM_BOT_TOKEN`.

`telegram_chat_id` зберігається автоматично, коли користувач надсилає боту `/start` (вебхук `POST /telegram/webhook`).

---

## Промокоди

### `GET /admin/promo-codes` (admin)
→ `{ promoCodes: [{ id, code, discountPercent, plan, startsOn, endsOn, usageLimit, usedCount, active, createdAt }] }`.

### `POST /admin/promo-codes` (admin)
Тіло `{ code, discountPercent, plan, startsOn?, endsOn?, usageLimit? }` → `{ id }` (201).

### `PUT /admin/promo-codes/:id` (admin)
Часткове оновлення.

### `DELETE /admin/promo-codes/:id` (admin)

### `POST /admin/promo-codes/validate` (admin)
Тіло `{ code }` → `{ valid: true, promoCode }` або помилка 400/404.

---

## Самообмеження

### `POST /self-limitation` (auth)
Тіло `{ periodDays: number, reason?: string }` → `{ id, until }` (201). Застосовується одразу: статус `applied`, створюється блок до `until`; зняти раніше не може ні адмін, ні овнер, ні сам користувач (`DELETE /tilt-blocks/:id` → 403). Активна підписка зсувається на час блоку. Під час блоку вхід повертає `403 { code: "SELF_LIMITED", until }`, а `POST /admin/users/:id/payments` — `409`.

### `GET /admin/self-limitations` (admin)
Query `status`. → `{ requests: [{ id, userId, username, periodDays, reason, status, createdAt, decidedAt, decidedBy, until, plan, telegram }] }` — `until` для застосованих.

### `PATCH /admin/self-limitations/:id` (admin)
Тіло `{ status: 'applied'|'denied' }` → `{ success: true }`. Лише для старих запитів зі статусом `new` (нові застосовуються одразу).

---

## Реклама (букмекери, покази/кліки)

### `GET /admin/bookmakers` (admin)
### `POST /admin/bookmakers` (admin)
### `PUT /admin/bookmakers/:id` (admin)
### `DELETE /admin/bookmakers/:id` (admin)

### `POST /ad-events` (без авторизації, з боку застосунку)
Тіло `{ kind: 'impression'|'click', placement: string, entityId?: string }` → `{ ok: true }`.

### `GET /admin/ad-stats` (admin)
→ `{ stats: [{ placement, impressions, clicks }] }`.

---

## Підтримка

### `POST /support` (auth)
Тіло `{ subject, message }` → `{ id }` (201).

### `GET /admin/support-tickets` (admin)
Query `status`. → `{ tickets: [...] }`.

### `PATCH /admin/support-tickets/:id` (admin)
Тіло `{ status: 'resolved'|'closed' }`.

### `GET /admin/telegram-groups` (admin)
Модерація Telegram-груп, які додали користувачі. Query: `status` (`pending|approved|rejected|all`, за замовч. `all`), `q` (назва, посилання або логін), `page` (по 20).

→ `{ groups: [{ id, name, link, game, hasChannel, comment, userId, addedBy, addedByPlan, moderationStatus, reviewedBy, reviewedAt, rejectReason, createdAt }], hasMore: boolean, counts: { pending, approved, rejected, all } }`. Спершу йдуть `pending`, далі за датою додавання.

Нові групи створюються зі статусом `pending`; групи, що існували до міграції `0022`, — `approved`. Статус бачить лише адмінка — у застосунку користувач і далі бачить свої групи як раніше.

### `POST /admin/telegram-groups/:id/approve` (admin)
→ `{ success: true, moderationStatus: "approved" }`. Пише `reviewed_by`, `reviewed_at`, очищає `reject_reason`, запис в аудит.

### `POST /admin/telegram-groups/:id/reject` (admin)
Тіло `{ reason }` (обовʼязково, до 500 символів) → `{ success: true, moderationStatus: "rejected" }`. Запис в аудит з причиною.

Помилки обох: `400` (некоректний id / немає причини), `404` (групу не знайдено).

### `GET /admin/support-templates` (admin)
### `POST /admin/support-templates` (admin)
### `DELETE /admin/support-templates/:id` (admin)

---

## Налаштування

### `GET /admin/settings` (admin)
→ `{ settings: {...} }`.

### `PUT /admin/settings` (admin)
Приймає (усі опціональні): `defaultMonthlyPrice`, `subscriptionDays`, `bannerSpecText`, `basicPrice`, `proPrice`, `basicFeatures`, `proFeatures`, `trialEnabled`, `trialDays`, `trialPlan`, `aiDailyLimit`, `warningThreshold`, `receiptFields`, `disclaimerText`, `aiUsdUah`, `churnInactiveDays`, `churnLossStreak`.

Валідація: `churnInactiveDays` — ціле 1–365; `churnLossStreak` — ціле 1–50. Зміни пишуться в аудит-лог (без секретів).

---

## Журнал дій

### `GET /admin/audit` (admin)
Query: `page`, `category` (`all|users|banners`), `status` (`all|success|failed|pending`), `q`, `from`, `to`, `userId`, `history` (`subscription`), `actor` (точний логін того, хто виконав дію — для «Мої дії в журналі»).

→ `{ entries: [...], hasMore: boolean, total: number }` — `total` — скільки всього записів підходить під фільтри (по 25 на сторінку).

### `GET /admin/audit/export` (admin)
CSV з тими самими фільтрами, що й `GET /admin/audit` (формули в клітинках нейтралізуються).

### `DELETE /admin/audit/cleanup` (admin)
Query `days` (1–3650, за замовч. 180) — видаляє записи старші за N днів → `{ removed: number }`. Саме очищення теж записується в журнал.

---

## Службові

### `POST /admin/reset` (auth)
Попри назву, скидає дані **поточного** користувача (ставки, банк, групи тощо) → `{ success: true, counts }`. Не адміністративна дія над іншими.

