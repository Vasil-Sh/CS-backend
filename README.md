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
| Кешування | **In-memory** (TTL, Redis-ready) |
| Rate limiting | **100 req/min per IP** |
| CI/CD | **GitHub Actions** + **Railway** |
| Документація | **OpenAPI 3.0** (`/api/docs.json`) |

## API

| Метод | Шлях | Доступ | Опис |
|-------|------|--------|------|
| `GET` | `/api/health` | Публічний | Health check + БД статус |
| `GET` | `/api/docs.json` | Публічний | OpenAPI 3.0 схема |
| `POST` | `/api/auth/login` | Публічний | Логін → JWT + httpOnly cookie |
| `POST` | `/api/auth/refresh` | Публічний | Оновити access-токен |
| `POST` | `/api/auth/register` | Admin | Створити користувача |
| `PUT` | `/api/auth/users/:id` | Admin | Оновити юзера |
| `DELETE` | `/api/auth/users/:id` | Admin | Видалити юзера |
| `GET` | `/api/auth/me` | User | Поточний профіль |
| `GET` | `/api/auth/users` | Admin | Список усіх юзерів |
| `GET/POST` | `/api/bets` | User | CRUD ставок |
| `PUT/PATCH/DELETE` | `/api/bets/:id` | User | Оновити/частково/видалити |
| `GET` | `/api/bets/stats` | User | Агрегована статистика |
| `GET/POST` | `/api/goals` | User | CRUD цілей |
| `PUT/DELETE` | `/api/goals/:id` | User | Оновити/видалити ціль |
| `GET/POST` | `/api/bankroll` | User | Банкрол |
| `POST` | `/api/bankroll/adjust` | User | Корекція банкролу |
| `GET/POST` | `/api/strategies` | User | CRUD стратегій |
| `PUT/DELETE` | `/api/strategies/:id` | User | Оновити/видалити стратегію |
| `POST` | `/api/ai/recommend` | User | AI рекомендація (DeepSeek) |
| `POST` | `/api/ai/advice` | User | AI порада по банку |
| `POST` | `/api/telegram/webhook` | Публічний | Telegram Bot вебхук |
| `GET/POST/DELETE` | `/api/telegram-groups` | User | Telegram групи (CRUD) |
| `GET/POST` | `/api/risky-teams` | User | CRUD ризикованих команд |
| `DELETE` | `/api/risky-teams/:id` | User | Видалити команду |

## Production Features

- ✅ **Rate limiting** — 100 req/min per IP, health + login exempt
- ✅ **httpOnly cookie** — JWT у HttpOnly/Secure cookie (XSS-захист)
- ✅ **In-memory cache** — 15s для /bets, 30s для /stats
- ✅ **DB health check** — `/api/health` перевіряє PostgreSQL
- ✅ **Structured logging** — JSON логи з IP, стектрейсом, тривалістю
- ✅ **Safe migrations** — `pnpm db:migrate` з трекінгом у `drizzle_migrations`
- ✅ **GitHub Actions CI** — typecheck + тести з PostgreSQL при push/PR
- ✅ **OpenAPI docs** — `/api/docs.json` (Swagger 3.0)
- ✅ **PATCH support** — часткове оновлення ставок
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

## Змінні оточення

| Змінна | Опис | Default |
|--------|------|---------|
| `PORT` | Порт сервера | `3001` |
| `NODE_ENV` | Режим (`development`/`production`) | `production` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_SECRET` | Секрет для JWT access-токенів | — |
| `JWT_EXPIRES_IN` | Термін дії access-токена | `15m` |
| `JWT_REFRESH_SECRET` | Секрет для refresh-токенів | — |
| `JWT_REFRESH_EXPIRES_IN` | Термін дії refresh-токена | `30d` |
| `ADMIN_PASSWORD` | Пароль для `pnpm db:seed` | `admin123` |
| `DEEPSEEK_API_KEY` | API-ключ DeepSeek | — |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота | — |
| `TELEGRAM_ADMIN_CHAT_ID` | Chat ID адміна | — |
| `CS_API_URL` | URL API матчів | — |

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
│   └── validation.ts     # Zod-схеми
├── routes/
│   ├── auth.ts           # /api/auth/*
│   ├── bets.ts           # /api/bets/* (з PATCH)
│   ├── goals.ts          # /api/goals/*
│   ├── bankroll.ts       # /api/bankroll/*
│   ├── strategies.ts     # /api/strategies/*
│   ├── ai.ts             # /api/ai/*
│   ├── telegram.ts       # /api/telegram/webhook
│   ├── telegramGroups.ts # /api/telegram-groups/*
│   └── riskyTeams.ts     # /api/risky-teams/*
├── services/
│   ├── deepseek.ts       # DeepSeek API клієнт
│   └── telegramBot.ts    # Telegram Bot парсер
└── utils/
    ├── jwt.ts            # signToken / verifyToken / refresh
    └── cache.ts          # In-memory cache (Redis-ready)
```
