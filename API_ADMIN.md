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

### `POST /auth/logout-all` (auth)
→ `{ success: true, revoked: number }`.

### `POST /auth/change-password` (auth)
Тіло: `{ currentPassword: string, newPassword: string }` → `{ success: true }`.

### `GET /auth/me` (auth)
→ `{ id, username, role, isOwner, telegram, plan, trialEndDate, ageConfirmed, startDate, endDate }`.

### `GET /auth/users` (admin)
Список користувачів: `[{ id, username, role, isOwner, telegram, priceMonth, plan, trialEndDate, ageConfirmed, startDate, endDate, createdAt }]`.

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
Зведення зі ставками: `[{ id, username, role, telegram, priceMonth, plan, planLabel, trialEndDate, ageConfirmed, startDate, endDate, createdAt, betCount, wins, losses, pending, totalStaked, totalProfit, winRate, roi, initialBank, manualAdjustments, currentBank, lossStreak, lastBetDate, lastBetAt, extensions, lastPaymentDate, games: [...] }]`.

### `GET /admin/users/:id/card` (admin)
Картка користувача зі статистикою і нотаткою.

### `GET /admin/users/:id/bets` (admin)
Список ставок користувача.

### `PUT /admin/users/:id` (admin)
Оновлення користувача. Приймає зокрема `plan` (`trial|basic|pro`), `trialEndDate`, `ageConfirmed`, `birthDate`, `priceMonth`, `startDate`, `endDate`, `telegram`, `role`, `isOwner`.

### `DELETE /admin/users/:id` (admin)
Видалення користувача (з перевіркою owner-правил).

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
Тіло `{ periodDays: number, reason?: string }` → `{ id }` (201).

### `GET /admin/self-limitations` (admin)
Query `status`. → `{ requests: [{ id, userId, username, periodDays, reason, status, createdAt, decidedAt, decidedBy }] }`.

### `PATCH /admin/self-limitations/:id` (admin)
Тіло `{ status: 'applied'|'denied' }` → `{ success: true }`. `applied` створює tilt_block.

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
Query: `page`, `category` (`all|users|banners`), `status` (`all|success|failed|pending`), `q`, `from`, `to`, `userId`, `history` (`subscription`).
