# MatchIQ Backend

API-сервер для [MatchIQ](https://github.com/Vasil-Sh/CS) — платформи аналітики CS2/Dota 2 беттінгу.

## Стек

| Шар | Технологія |
|-----|-----------|
| Runtime | **Node.js 22** + **TypeScript** |
| Framework | **Hono 4** |
| БД | **PostgreSQL 16** |
| ORM | **Drizzle ORM** |
| Auth | **bcrypt** + **JWT** (access + refresh) |
| Валідація | **Zod** |
| Кешування | **In-memory** + **File cache** (SWR — stale-while-revalidate) |
| Rate limiting | **100 req/min per IP** + **5 req/30s для парсера** |
| Circuit breaker | **3 failures → 5 min блок** |
| CI/CD | **GitHub Actions** (daily scraper test) + **Railway** |
| Тести | **Vitest** — 135 unit + інтеграційних (17 файлів) |
| Документація | **OpenAPI 3.0** + **Swagger UI** (`/api/docs`) |
| Версіонування | **API /v1** (з backward compat `/api/*`) |
| AI | **DeepSeek Chat** + **Google Gemini Flash** (free fallback) |
| Парсер | **tips.gg Dota 2** — 19 матчів/день + коефіцієнти |

## Швидкий старт

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:push
pnpm db:seed
pnpm dev
```

Сервер на `http://localhost:3001`, Swagger UI на `http://localhost:3001/api/docs`.

## API

### 🔓 Публічні (без авторизації)
| Метод | Шлях | Опис |
|-------|------|------|
| `GET` | `/api/health` | Health check + статус БД |
| `GET` | `/api/docs.json` | OpenAPI 3.0 JSON-спекуляція |
| `GET` | `/api/docs?key=<ADMIN_PASSWORD>` | **Swagger UI** (у production захищений паролем) |
| `POST` | `/api/auth/login` | Логін → JWT + httpOnly cookie |
| `POST` | `/api/telegram/webhook` | Telegram Bot вебхук |

### 🔐 Потрібен JWT (кнопка Authorize 🔒 у Swagger)
| Метод | Шлях | Опис |
|-------|------|------|
| `POST` | `/auth/register` | Admin: створити користувача |
| `PUT/DELETE` | `/auth/users/:id` | Admin: змінити/видалити юзера |
| `GET` | `/auth/me` | Поточний профіль |
| `GET` | `/auth/users` | Admin: список усіх юзерів |
| `GET/POST` | `/bets?page=1&limit=50` | Пагінований список / створити ставку |
| `PUT/PATCH/DELETE` | `/bets/:id` | Оновити / частково (PATCH) / видалити |
| `GET` | `/bets/stats` | SQL-агрегована статистика (ROI, по місяцях, по стратегіях) |
| `GET/POST` | `/goals` | CRUD цілей |
| `PUT/DELETE` | `/goals/:id` | Оновити/видалити ціль |
| `GET/POST` | `/bankroll` | Банкрол |
| `POST` | `/bankroll/adjust` | Корекція банкролу (±) |
| `GET/POST` | `/strategies` | CRUD стратегій (Kelly, fractional тощо) |
| `PUT/DELETE` | `/strategies/:id` | Оновити/видалити стратегію |
| `POST` | `/ai/recommend` | DeepSeek AI / Gemini Flash — рекомендація по матчу |
| `POST` | `/ai/advice` | Порада по стану банкролу |
| `GET` | `/v1/dota2-matches` | Dota 2 матчі з tips.gg (JSON-LD парсинг) |
| `GET` | `/v1/dota2-matches/live-scores` | Тільки рахунки/статуси Dota 2 матчів |
| `GET` | `/v1/dota2-matches/health` | Health check структури HTML tips.gg |
| `GET` | `/v1/dota2-matches/logo/*` | Проксі логотипів команд через бекенд |
| `GET/POST/DELETE` | `/telegram-groups` | Telegram-групи (CRUD) |
| `GET/POST` | `/risky-teams` | Ризиковані команди |
| `DELETE` | `/risky-teams/:id` | Admin: видалити команду зі списку |
| `POST` | `/admin/reset` | Видалити всі дані користувача (ставки, цілі, стратегії тощо) |

> Всі ендпоінти також доступні з префіксом `/api/v1/*` (наприклад, `/api/v1/bets`). Старі шляхи `/api/*` продовжують працювати для зворотної сумісності.

## Архітектура (v1.24.0)

```
src/
├── routes/      # Тонкий HTTP-шар (тільки валідація + виклик сервісу)
├── services/    # Бізнес-логіка (10 сервісів)
│   ├── authService.ts
│   ├── betService.ts
│   ├── goalService.ts
│   ├── strategyService.ts
│   ├── bankrollBackendService.ts
│   ├── telegramGroupService.ts
│   ├── deepseek.ts              # DeepSeek + Gemini Flash AI
│   ├── tipsggScraper.ts         # tips.gg Dota 2 парсер (curl + JSON-LD)
│   ├── circuitBreaker.ts        # Circuit breaker (3 failures → 5 min)
│   └── telegramBot.ts
├── middleware/   # auth, rateLimiter, securityHeaders, bodyLimit, validation, numericNormalizer
├── db/           # Drizzle ORM schema + PostgreSQL client
├── utils/        # JWT, cache, response helpers, env validation
├── .github/workflows/ # CI/CD: daily scraper test
└── test/         # Test helpers
```

## Безпека (v1.24.x)

- ✅ **API v1 версіонування** — `/api/v1/*` з backward compat
- ✅ **Services layer** — бізнес-логіка винесена з routes (тестовано окремо)
- ✅ **Stale-while-revalidate** — кеш віддається миттєво, оновлення у фоні
- ✅ **Graceful degradation** — прострочений кеш (до 24h) при падінні tips.gg
- ✅ **Circuit breaker** — 3 помилки → 5 хв блокування tips.gg
- ✅ **135 тестів** — unit (middleware, utils, services) + інтеграційні (routes)
- ✅ **Body size limit** — 1MB max (захист від DDOS)
- ✅ **Security headers** — CSP, HSTS, X-Content-Type, X-Frame-Options, Permissions-Policy
- ✅ **Swagger protection** — `/api/docs` захищений `?key=<ADMIN_PASSWORD>` у production
- ✅ **env fail-safe** — усі змінні optional, не крашать сервер при відсутності
- ✅ **Rate limiting** — 100 req/min per IP (глобально) + 5 req/30s (парсер)
- ✅ **httpOnly cookie** — JWT у HttpOnly/Secure cookie (XSS-захист)
- ✅ **File cache** — `.cache/dota2_matches.json` виживає рестарт
- ✅ **DB health check** — `/api/health` перевіряє PostgreSQL через shared pool
- ✅ **Scraper health check** — `/api/v1/dota2-matches/health` валідує структуру HTML
- ✅ **Live scores endpoint** — точкове оновлення рахунків без повного скрапінгу
- ✅ **Structured JSON-логування** — IP, стектрейс, тривалість, метрики парсингу
- ✅ **Graceful shutdown** — SIGTERM/SIGINT → чистий вихід
- ✅ **Safe migrations** — `pnpm db:migrate` з трекінгом у `drizzle_migrations`
- ✅ **Pagination** — `GET /bets?page=1&limit=50` з `meta.totalPages`
- ✅ **SQL aggregation** — `/bets/stats` обчислюється на рівні БД (не в пам'яті)
- ✅ **Dynamic field mapper** — PUT/PATCH без 30+ if-чеків
- ✅ **Refresh tokens** — 15m access + 30d refresh
- ✅ **Per-user data isolation** — risky teams, telegram groups, goals, strategies

## Локальний запуск

```bash
# 1. Встановити залежності
pnpm install

# 2. Створити .env
cp .env.example .env

# 3. Підняти PostgreSQL
docker compose up -d

# 4. Накатити схему БД
pnpm db:push

# 5. Створити адміна
pnpm db:seed

# 6. Імпортувати юзерів з Google Sheets (опціонально)
pnpm db:import-users

# 7. Запустити сервер
pnpm dev
```

Сервер на `http://localhost:3001`.

## Змінні оточення (усі optional, є fallback)

| Змінна | Опис | Default |
|--------|------|---------|
| `PORT` | Порт | `3001` |
| `NODE_ENV` | `development`/`production` | `production` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_SECRET` | Секрет для JWT | fallback: `dev-secret-…` |
| `JWT_EXPIRES_IN` | Access token TTL | `15m` |
| `JWT_REFRESH_SECRET` | Refresh token secret | fallback |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | `30d` |
| `ADMIN_PASSWORD` | Пароль для Swagger UI (`?key=…`) | — |
| `DEEPSEEK_API_KEY` | DeepSeek AI key (optional, uses Gemini if missing) | — |
| `GEMINI_API_KEY` | Google Gemini Flash (free fallback) | — |
| `TELEGRAM_BOT_TOKEN` | Telegram бот | — |
| `TELEGRAM_ADMIN_CHAT_ID` | Admin chat ID | — |
| `CS_API_URL` | CS2 match API | `https://api.cstest.pp.ua` |

## Swagger UI

Вбудований Swagger UI (`/api/docs`) з повною OpenAPI 3.0 схемою (24 endpoints, приклади запитів, схеми даних).

### Production:
```
https://cs-backend-production-f9e8.up.railway.app/api/docs?key=<ADMIN_PASSWORD>
```

### Dev:
```
http://localhost:3001/api/docs
```

### Оновлення OpenAPI схеми:
```bash
node scripts/gen-openapi.cjs   # згенерувати openapi.generated.ts
node scripts/embed-spec.cjs    # вшити спеку в код
```

## Деплой (Railway)

Автоматичний деплой з гілки `main`. Перевірка:
```
https://cs-backend-production-f9e8.up.railway.app/api/health
```

## Тести

```bash
pnpm test          # запустити всі тести (135, 17 файлів)
pnpm test:watch    # watch-режим
```

## Структура

```
src/
├── index.ts              # Entry point + middleware setup
├── openapi.json          # OpenAPI 3.0 специфікація
├── db/
│   ├── client.ts         # PostgreSQL connection
│   ├── schema.ts         # Drizzle ORM схема (7 таблиць)
│   ├── seed.ts           # Створення адмін-юзера
│   ├── runMigrations.ts  # Безпечний мігратор
│   └── migrateUsers.ts   # Імпорт з Google Sheets
├── middleware/
│   ├── auth.ts           # JWT (Bearer + httpOnly cookie)
│   ├── logger.ts         # Структуроване логування
│   ├── rateLimiter.ts    # Rate limiting (100 req/min)
│   ├── securityHeaders.ts # Helmet-like security headers
│   ├── bodyLimit.ts      # 1MB body size limit
│   ├── numericNormalizer.ts # Postgres NUMERIC → JS number
│   └── validation.ts     # Zod-схеми
├── routes/
│   ├── admin.ts          # /api/admin/reset
│   ├── ai.ts             # /api/ai/* (DeepSeek + Gemini)
│   ├── auth.ts           # /api/auth/*
│   ├── bankroll.ts       # /api/bankroll/*
│   ├── bets.ts           # /api/bets/* (з PATCH)
│   ├── dota2Matches.ts   # /api/v1/dota2-matches/* (парсер + live scores + health + logo proxy)
│   ├── goals.ts          # /api/goals/*
│   ├── riskyTeams.ts     # /api/risky-teams/*
│   ├── strategies.ts     # /api/strategies/*
│   ├── telegram.ts       # /api/telegram/webhook
│   └── telegramGroups.ts # /api/telegram-groups/*
├── services/
│   ├── authService.ts         # Логін, реєстрація, CRUD юзерів
│   ├── bankrollBackendService.ts # Банкрол (get/set/adjust/stats)
│   ├── betService.ts          # Ставки (CRUD + stats + cache)
│   ├── deepseek.ts            # DeepSeek AI клієнт
│   ├── goalService.ts         # Цілі (CRUD)
│   ├── strategyService.ts     # Стратегії (CRUD + primary)
│   ├── telegramBot.ts         # Telegram Bot парсер
│   └── telegramGroupService.ts # Telegram групи (CRUD)
├── test/
│   └── helpers.ts       # Test utilities + mock helpers
└── utils/
    ├── jwt.ts            # signToken / verifyToken / refresh
    ├── cache.ts          # In-memory cache (Redis-ready)
    ├── response.ts       # ok(), err(), paginated() helpers
    └── env.ts            # Zod env validation
