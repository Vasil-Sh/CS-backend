# MatchIQ Backend

API-сервер для [MatchIQ](https://github.com/Vasil-Sh/CS) — платформи аналітики CS2/Dota 2 беттінгу.

## Стек

| Шар | Технологія |
|-----|-----------|
| Runtime | **Node.js** + **TypeScript** |
| Framework | **Hono** (легкий, швидкий) |
| БД | **PostgreSQL** (Docker) |
| ORM | **Drizzle ORM** |
| Auth | **bcrypt** + **JWT** |
| Валідація | **Zod** |
| AI | **DeepSeek API** (проксі) |
| Деплой | **Railway** |

## API

| Метод | Шлях | Доступ | Опис |
|-------|------|--------|------|
| `GET` | `/api/health` | Публічний | Health check |
| `POST` | `/api/auth/login` | Публічний | Логін → JWT |
| `POST` | `/api/auth/register` | Admin | Створення користувача |
| `GET` | `/api/auth/me` | User | Поточний профіль |
| `GET` | `/api/auth/users` | Admin | Список усіх юзерів |
| `DELETE` | `/api/auth/users/:id` | Admin | Видалити юзера |
| `GET/POST` | `/api/bets` | User | CRUD ставок |
| `PUT/DELETE` | `/api/bets/:id` | User | Оновити/видалити ставку |
| `GET` | `/api/bets/stats` | User | Статистика ставок |
| `GET/POST` | `/api/goals` | User | CRUD цілей |
| `PUT/DELETE` | `/api/goals/:id` | User | Оновити/видалити ціль |
| `GET/POST` | `/api/bankroll` | User | Банкрол |
| `POST` | `/api/bankroll/adjust` | User | Корекція банкролу |
| `GET/POST` | `/api/strategies` | User | CRUD стратегій |
| `PUT/DELETE` | `/api/strategies/:id` | User | Оновити/видалити стратегію |
| `POST` | `/api/ai/recommend` | User | AI рекомендація (DeepSeek) |
| `POST` | `/api/ai/advice` | User | AI порада по банку |
| `POST` | `/api/telegram/webhook` | Публічний | Telegram Bot вебхук |
| `GET/POST` | `/api/risky-teams` | Admin | CRUD ризикованих команд |
| `DELETE` | `/api/risky-teams/:id` | Admin | Видалити команду |

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

| Змінна | Опис |
|--------|------|
| `PORT` | Порт сервера (default: `3001`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Секрет для JWT-токенів |
| `JWT_EXPIRES_IN` | Термін дії токена (default: `7d`) |
| `DEEPSEEK_API_KEY` | API-ключ DeepSeek для AI-рекомендацій |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота |
| `TELEGRAM_ADMIN_CHAT_ID` | Chat ID адміна для сповіщень |
| `CS_API_URL` | URL API матчів CS2/Dota 2 |

## Структура

```
src/
├── index.ts              # Entry point
├── db/
│   ├── client.ts         # PostgreSQL connection
│   ├── schema.ts         # Drizzle ORM схема (6 таблиць)
│   ├── migrate.ts        # Міграції
│   ├── seed.ts           # Створення адмін-юзера
│   └── migrateUsers.ts   # Імпорт з Google Sheets
├── middleware/
│   ├── auth.ts           # JWT-верифікація
│   └── validation.ts     # Zod-схеми
├── routes/
│   ├── auth.ts           # /api/auth/*
│   ├── bets.ts           # /api/bets/*
│   ├── goals.ts          # /api/goals/*
│   ├── bankroll.ts       # /api/bankroll/*
│   ├── strategies.ts     # /api/strategies/*
│   ├── ai.ts             # /api/ai/*
│   ├── telegram.ts       # /api/telegram/*
│   └── riskyTeams.ts     # /api/risky-teams/*
├── services/
│   ├── deepseek.ts       # DeepSeek API клієнт
│   └── telegramBot.ts    # Telegram Bot парсер
└── utils/
    └── jwt.ts            # signToken / verifyToken
```
