// Generated from openapi.json
const spec = {
  "openapi": "3.0.3",
  "info": {
    "title": "MatchIQ Backend API",
    "version": "1.23.0",
    "description": "REST API for MatchIQ CS2/Dota 2 betting analytics platform — bets, goals, strategies, bankroll, AI recommendations, Telegram bot integration."
  },
  "servers": [
    {
      "url": "https://cs-backend-production-f9e8.up.railway.app/api",
      "description": "Production (Railway)"
    },
    {
      "url": "http://localhost:3001/api",
      "description": "Local dev"
    }
  ],
  "security": [
    {
      "bearerAuth": []
    }
  ],
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT",
        "description": "JWT token from POST /auth/login"
      }
    },
    "schemas": {
      "Error": {
        "type": "object",
        "properties": {
          "error": {
            "type": "string",
            "example": "Invalid input"
          },
          "details": {
            "type": "array"
          }
        }
      },
      "LoginRequest": {
        "type": "object",
        "required": [
          "username",
          "password"
        ],
        "properties": {
          "username": {
            "type": "string",
            "example": "admin"
          },
          "password": {
            "type": "string",
            "example": "your-password"
          }
        }
      },
      "LoginResponse": {
        "type": "object",
        "properties": {
          "success": {
            "type": "boolean",
            "example": true
          },
          "isAdmin": {
            "type": "boolean",
            "example": true
          },
          "token": {
            "type": "string",
            "example": "eyJhbGciOi..."
          },
          "refreshToken": {
            "type": "string",
            "example": "eyJhbGciOi..."
          },
          "user": {
            "type": "object",
            "properties": {
              "username": {
                "type": "string",
                "example": "admin"
              },
              "role": {
                "type": "string",
                "example": "admin"
              },
              "telegram": {
                "type": "string",
                "example": ""
              }
            }
          }
        }
      },
      "RegisterRequest": {
        "type": "object",
        "required": [
          "username"
        ],
        "properties": {
          "username": {
            "type": "string",
            "example": "newuser"
          },
          "password": {
            "type": "string",
            "description": "Auto-generated if empty"
          },
          "telegram": {
            "type": "string",
            "example": "@nickname"
          },
          "priceMonth": {
            "type": "string",
            "example": "9.99"
          },
          "endDate": {
            "type": "string",
            "example": "2026-12-31"
          },
          "role": {
            "type": "string",
            "enum": [
              "admin",
              "user"
            ],
            "example": "user"
          }
        }
      },
      "User": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "example": 1
          },
          "username": {
            "type": "string",
            "example": "admin"
          },
          "role": {
            "type": "string",
            "enum": [
              "admin",
              "user"
            ],
            "example": "admin"
          },
          "telegram": {
            "type": "string",
            "example": "@nickname"
          },
          "startDate": {
            "type": "string",
            "example": "2026-01-01"
          },
          "endDate": {
            "type": "string",
            "example": "2026-12-31"
          }
        }
      },
      "BetRequest": {
        "type": "object",
        "required": [
          "match",
          "odds",
          "amount"
        ],
        "properties": {
          "match": {
            "type": "string",
            "example": "NAVI vs FaZe",
            "maxLength": 500
          },
          "team1": {
            "type": "string",
            "example": "NAVI",
            "maxLength": 200
          },
          "team2": {
            "type": "string",
            "example": "FaZe",
            "maxLength": 200
          },
          "betType": {
            "type": "string",
            "example": "Ординар",
            "maxLength": 100
          },
          "odds": {
            "type": "number",
            "example": 1.85,
            "minimum": 0,
            "maximum": 1000
          },
          "amount": {
            "type": "number",
            "example": 100,
            "minimum": 0
          },
          "stake": {
            "type": "number",
            "example": 5
          },
          "date": {
            "type": "string",
            "example": "2026-06-30"
          },
          "result": {
            "type": "string",
            "enum": [
              "Win",
              "Loss",
              "Pending"
            ],
            "example": "Pending"
          },
          "profit": {
            "type": "number",
            "example": 85
          },
          "strategy": {
            "type": "string",
            "example": "Kelly",
            "maxLength": 200
          },
          "format": {
            "type": "string",
            "example": "Bo3",
            "maxLength": 20
          },
          "game": {
            "type": "string",
            "example": "CS2",
            "maxLength": 20
          },
          "currency": {
            "type": "string",
            "example": "USD",
            "maxLength": 10
          },
          "originalAmount": {
            "type": "number",
            "example": 100
          },
          "exchangeRate": {
            "type": "number",
            "example": 1
          },
          "originalProfit": {
            "type": "number",
            "example": 85
          },
          "roi": {
            "type": "number",
            "example": 85
          },
          "goalId": {
            "type": "string",
            "example": "uuid-or-empty"
          },
          "selection": {
            "type": "string",
            "example": "NAVI win",
            "maxLength": 200
          },
          "matchUrl": {
            "type": "string",
            "example": "https://hltv.org/match/123",
            "maxLength": 500
          },
          "winProbability": {
            "type": "number",
            "example": 60,
            "minimum": 0,
            "maximum": 100
          },
          "risk": {
            "type": "string",
            "example": "medium",
            "maxLength": 50
          },
          "notes": {
            "type": "string",
            "example": "Confident bet, NAVI on streak"
          },
          "riskyTeams": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "example": [
              "Team Spirit"
            ]
          },
          "tournament": {
            "type": "string",
            "example": "IEM Cologne 2026",
            "maxLength": 200
          },
          "logoTeam1": {
            "type": "string",
            "example": "https://cdn.example.com/navi.png"
          },
          "logoTeam2": {
            "type": "string",
            "example": "https://cdn.example.com/faze.png"
          },
          "expressLogos": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "logoTeam1": {
                  "type": "string"
                },
                "logoTeam2": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "BetResponse": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid",
            "example": "550e8400-e29b-..."
          },
          "userId": {
            "type": "integer",
            "example": 1
          },
          "match": {
            "type": "string",
            "example": "NAVI vs FaZe"
          },
          "team1": {
            "type": "string",
            "example": "NAVI"
          },
          "team2": {
            "type": "string",
            "example": "FaZe"
          },
          "betType": {
            "type": "string",
            "example": "Ординар"
          },
          "odds": {
            "type": "string",
            "example": "1.850"
          },
          "amount": {
            "type": "string",
            "example": "100.00"
          },
          "date": {
            "type": "string",
            "example": "2026-06-30"
          },
          "result": {
            "type": "string",
            "enum": [
              "Win",
              "Loss",
              "Pending"
            ],
            "example": "Pending"
          },
          "profit": {
            "type": "string",
            "example": "85.00"
          },
          "strategy": {
            "type": "string",
            "example": "Kelly"
          },
          "format": {
            "type": "string",
            "example": "Bo3"
          },
          "game": {
            "type": "string",
            "example": "CS2"
          },
          "currency": {
            "type": "string",
            "example": "USD"
          },
          "roi": {
            "type": "string",
            "example": "85.00"
          },
          "createdAt": {
            "type": "string",
            "example": "2026-06-30T12:00:00.000Z"
          }
        }
      },
      "BetUpdate": {
        "type": "object",
        "properties": {
          "result": {
            "type": "string",
            "enum": [
              "Win",
              "Loss",
              "Pending"
            ],
            "example": "Win"
          },
          "profit": {
            "type": "number",
            "example": 85
          },
          "notes": {
            "type": "string",
            "example": "Updated after match"
          },
          "roi": {
            "type": "number",
            "example": 85
          },
          "odds": {
            "type": "number",
            "example": 1.85
          },
          "match": {
            "type": "string",
            "example": "NAVI vs FaZe"
          },
          "team1": {
            "type": "string",
            "example": "NAVI"
          },
          "team2": {
            "type": "string",
            "example": "FaZe"
          }
        }
      },
      "PaginatedBets": {
        "type": "object",
        "properties": {
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/BetResponse"
            }
          },
          "meta": {
            "type": "object",
            "properties": {
              "page": {
                "type": "integer",
                "example": 1
              },
              "limit": {
                "type": "integer",
                "example": 50
              },
              "total": {
                "type": "integer",
                "example": 150
              },
              "totalPages": {
                "type": "integer",
                "example": 3
              }
            }
          }
        }
      },
      "BetStats": {
        "type": "object",
        "properties": {
          "totalBets": {
            "type": "integer",
            "example": 150
          },
          "winRate": {
            "type": "number",
            "example": 62.33
          },
          "totalProfit": {
            "type": "number",
            "example": 1250.5
          },
          "averageROI": {
            "type": "number",
            "example": 18.5
          },
          "profitByMonth": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "month": {
                  "type": "string",
                  "example": "2026-06"
                },
                "profit": {
                  "type": "number",
                  "example": 320.75
                }
              }
            }
          },
          "profitByStrategy": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "strategy": {
                  "type": "string",
                  "example": "Kelly"
                },
                "profit": {
                  "type": "number",
                  "example": 800.25
                }
              }
            }
          }
        }
      },
      "GoalRequest": {
        "type": "object",
        "required": [
          "type",
          "target"
        ],
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "amount",
              "ladder",
              "roi",
              "winrate"
            ],
            "example": "amount"
          },
          "name": {
            "type": "string",
            "example": "Bankroll to $5000"
          },
          "target": {
            "type": "number",
            "example": 5000
          },
          "current": {
            "type": "number",
            "example": 2500
          },
          "deadline": {
            "type": "string",
            "example": "2026-12-31"
          },
          "config": {
            "type": "object"
          }
        }
      },
      "GoalResponse": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "userId": {
            "type": "integer",
            "example": 1
          },
          "type": {
            "type": "string",
            "example": "amount"
          },
          "name": {
            "type": "string",
            "example": "Bankroll to $5000"
          },
          "target": {
            "type": "string",
            "example": "5000.00"
          },
          "current": {
            "type": "string",
            "example": "2500.00"
          },
          "deadline": {
            "type": "string",
            "example": "2026-12-31"
          },
          "isCompleted": {
            "type": "boolean",
            "example": false
          }
        }
      },
      "StrategyRequest": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "example": "Kelly Fractional",
            "maxLength": 200
          },
          "isPrimary": {
            "type": "boolean",
            "example": true
          },
          "config": {
            "type": "object",
            "example": {
              "fraction": 0.25,
              "minOdds": 1.3,
              "maxOdds": 5,
              "maxStakePercent": 5
            }
          }
        }
      },
      "StrategyResponse": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "userId": {
            "type": "integer",
            "example": 1
          },
          "name": {
            "type": "string",
            "example": "Kelly Fractional"
          },
          "isPrimary": {
            "type": "boolean",
            "example": true
          },
          "config": {
            "type": "object"
          }
        }
      },
      "BankrollResponse": {
        "type": "object",
        "properties": {
          "initialBank": {
            "type": "number",
            "example": 1000
          },
          "manualAdjustments": {
            "type": "number",
            "example": 200
          },
          "currentBank": {
            "type": "number",
            "example": 2450.5
          },
          "totalProfit": {
            "type": "number",
            "example": 1250.5
          },
          "roi": {
            "type": "number",
            "example": 125.05
          }
        }
      },
      "BankrollSetRequest": {
        "type": "object",
        "required": [
          "initialBank"
        ],
        "properties": {
          "initialBank": {
            "type": "number",
            "example": 1000,
            "minimum": 0
          }
        }
      },
      "BankrollAdjustRequest": {
        "type": "object",
        "required": [
          "amount"
        ],
        "properties": {
          "amount": {
            "type": "number",
            "example": 200
          }
        }
      },
      "RiskyTeamRequest": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "example": "Team Spirit",
            "maxLength": 200
          },
          "game": {
            "type": "string",
            "example": "CS2"
          },
          "status": {
            "type": "string",
            "example": "underperforming"
          },
          "notes": {
            "type": "string",
            "example": "Lost 5 matches in a row"
          }
        }
      },
      "TelegramGroupRequest": {
        "type": "object",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "example": "CS2 Tips Pro",
            "maxLength": 200
          },
          "link": {
            "type": "string",
            "example": "https://t.me/cs2tips",
            "maxLength": 500
          }
        }
      },
      "AIRecommendRequest": {
        "type": "object",
        "required": [
          "team1",
          "team2"
        ],
        "properties": {
          "team1": {
            "type": "string",
            "example": "NAVI"
          },
          "team2": {
            "type": "string",
            "example": "FaZe"
          },
          "format": {
            "type": "string",
            "example": "Bo3"
          },
          "tier": {
            "type": "string",
            "example": "TIER1"
          },
          "odds": {
            "type": "object",
            "properties": {
              "team1": {
                "type": "number",
                "example": 1.85
              },
              "team2": {
                "type": "number",
                "example": 2.1
              }
            }
          }
        }
      },
      "AIRecommendationResponse": {
        "type": "object",
        "properties": {
          "prediction": {
            "type": "string",
            "example": "NAVI"
          },
          "confidence": {
            "type": "integer",
            "example": 72
          },
          "reasoning": {
            "type": "string",
            "example": "NAVI has better recent form..."
          },
          "suggestedBet": {
            "type": "string",
            "example": "NAVI to win @ 1.85"
          },
          "riskLevel": {
            "type": "string",
            "enum": [
              "low",
              "medium",
              "high"
            ],
            "example": "medium"
          }
        }
      },
      "AIAdviceRequest": {
        "type": "object",
        "required": [
          "state",
          "percentOfPeak",
          "currentBank",
          "allTimeHigh",
          "bets",
          "profit"
        ],
        "properties": {
          "state": {
            "type": "string",
            "enum": [
              "growing",
              "stable",
              "dipping",
              "falling"
            ],
            "example": "growing"
          },
          "percentOfPeak": {
            "type": "number",
            "example": 95
          },
          "currentBank": {
            "type": "number",
            "example": 2450.5
          },
          "allTimeHigh": {
            "type": "number",
            "example": 2600
          },
          "bets": {
            "type": "integer",
            "example": 150
          },
          "profit": {
            "type": "number",
            "example": 1250.5
          }
        }
      },
      "HealthResponse": {
        "type": "object",
        "properties": {
          "status": {
            "type": "string",
            "example": "ok"
          },
          "database": {
            "type": "string",
            "enum": [
              "connected",
              "disconnected"
            ],
            "example": "connected"
          },
          "uptime": {
            "type": "integer",
            "example": 3600
          },
          "timestamp": {
            "type": "string",
            "example": "2026-06-30T12:00:00.000Z"
          }
        }
      }
    }
  },
  "tags": [
    {
      "name": "System",
      "description": "Health check & docs"
    },
    {
      "name": "Auth",
      "description": "Login, register, user management"
    },
    {
      "name": "Bets",
      "description": "CRUD + stats for bets"
    },
    {
      "name": "Goals",
      "description": "User goals"
    },
    {
      "name": "Strategies",
      "description": "Betting strategies"
    },
    {
      "name": "Bankroll",
      "description": "Bankroll management"
    },
    {
      "name": "Risky Teams",
      "description": "Risky teams blacklist"
    },
    {
      "name": "Telegram Groups",
      "description": "Telegram group subscriptions"
    },
    {
      "name": "Telegram",
      "description": "Bot webhook"
    },
    {
      "name": "AI",
      "description": "DeepSeek AI recommendations"
    }
  ],
  "paths": {
    "/health": {
      "get": {
        "tags": [
          "System"
        ],
        "summary": "Health check",
        "security": [],
        "responses": {
          "200": {
            "description": "Server & DB status",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/HealthResponse"
                }
              }
            }
          }
        }
      }
    },
    "/docs.json": {
      "get": {
        "tags": [
          "System"
        ],
        "summary": "OpenAPI spec",
        "security": [],
        "responses": {
          "200": {
            "description": "OpenAPI 3.0 JSON"
          }
        }
      }
    },
    "/docs": {
      "get": {
        "tags": [
          "System"
        ],
        "summary": "Swagger UI",
        "description": "Interactive API docs. In production, requires ?key=ADMIN_PASSWORD.",
        "security": [],
        "parameters": [
          {
            "name": "key",
            "in": "query",
            "schema": {
              "type": "string"
            },
            "description": "Admin password (production only)"
          }
        ],
        "responses": {
          "200": {
            "description": "Swagger UI HTML"
          },
          "403": {
            "description": "Access denied"
          }
        }
      }
    },
    "/auth/login": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Login",
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/LoginRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "JWT token",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LoginResponse"
                }
              }
            }
          },
          "401": {
            "description": "Invalid credentials"
          },
          "403": {
            "description": "Subscription expired"
          }
        }
      }
    },
    "/auth/register": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Register user (admin)",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/RegisterRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "User created"
          },
          "409": {
            "description": "Username exists"
          }
        }
      }
    },
    "/auth/me": {
      "get": {
        "tags": [
          "Auth"
        ],
        "summary": "Current user profile",
        "responses": {
          "200": {
            "description": "User data",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/User"
                }
              }
            }
          }
        }
      }
    },
    "/auth/users": {
      "get": {
        "tags": [
          "Auth"
        ],
        "summary": "List all users (admin)",
        "responses": {
          "200": {
            "description": "All users",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/User"
                  }
                }
              }
            }
          }
        }
      }
    },
    "/auth/users/{id}": {
      "put": {
        "tags": [
          "Auth"
        ],
        "summary": "Update user (admin)",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "username": {
                    "type": "string",
                    "example": "updateduser"
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "admin",
                      "user"
                    ]
                  },
                  "endDate": {
                    "type": "string",
                    "example": "2027-06-30"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated"
          },
          "400": {
            "description": "Invalid ID"
          }
        }
      },
      "delete": {
        "tags": [
          "Auth"
        ],
        "summary": "Delete user (admin)",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Deleted"
          }
        }
      }
    },
    "/bets": {
      "get": {
        "tags": [
          "Bets"
        ],
        "summary": "List bets",
        "description": "Paginated, sorted by date desc.",
        "parameters": [
          {
            "name": "page",
            "in": "query",
            "schema": {
              "type": "integer",
              "default": 1,
              "minimum": 1
            }
          },
          {
            "name": "limit",
            "in": "query",
            "schema": {
              "type": "integer",
              "default": 50,
              "minimum": 1,
              "maximum": 100
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Paginated bets",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PaginatedBets"
                }
              }
            }
          }
        }
      },
      "post": {
        "tags": [
          "Bets"
        ],
        "summary": "Create bet",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/BetRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BetResponse"
                }
              }
            }
          },
          "400": {
            "description": "Validation error",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        }
      }
    },
    "/bets/stats": {
      "get": {
        "tags": [
          "Bets"
        ],
        "summary": "Bet statistics",
        "description": "SQL-aggregated — win rate, ROI, profit by month & strategy. O(1) memory.",
        "responses": {
          "200": {
            "description": "Stats",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BetStats"
                }
              }
            }
          }
        }
      }
    },
    "/bets/{id}": {
      "put": {
        "tags": [
          "Bets"
        ],
        "summary": "Update bet",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          }
        ],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/BetRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated"
          },
          "404": {
            "description": "Not found"
          }
        }
      },
      "patch": {
        "tags": [
          "Bets"
        ],
        "summary": "Partial update bet",
        "description": "Only provided fields are updated.",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          }
        ],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/BetUpdate"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated"
          },
          "404": {
            "description": "Not found"
          }
        }
      },
      "delete": {
        "tags": [
          "Bets"
        ],
        "summary": "Delete bet",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Deleted"
          },
          "404": {
            "description": "Not found"
          }
        }
      }
    },
    "/goals": {
      "get": {
        "tags": [
          "Goals"
        ],
        "summary": "List goals",
        "responses": {
          "200": {
            "description": "User goals",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/GoalResponse"
                  }
                }
              }
            }
          }
        }
      },
      "post": {
        "tags": [
          "Goals"
        ],
        "summary": "Create goal",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/GoalRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/GoalResponse"
                }
              }
            }
          }
        }
      }
    },
    "/goals/{id}": {
      "put": {
        "tags": [
          "Goals"
        ],
        "summary": "Update goal",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Updated"
          },
          "404": {
            "description": "Not found"
          }
        }
      },
      "delete": {
        "tags": [
          "Goals"
        ],
        "summary": "Delete goal",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Deleted"
          },
          "404": {
            "description": "Not found"
          }
        }
      }
    },
    "/strategies": {
      "get": {
        "tags": [
          "Strategies"
        ],
        "summary": "List strategies",
        "responses": {
          "200": {
            "description": "User strategies",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "$ref": "#/components/schemas/StrategyResponse"
                  }
                }
              }
            }
          }
        }
      },
      "post": {
        "tags": [
          "Strategies"
        ],
        "summary": "Create strategy",
        "description": "If isPrimary=true, other strategies are unset.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/StrategyRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/StrategyResponse"
                }
              }
            }
          }
        }
      }
    },
    "/strategies/{id}": {
      "put": {
        "tags": [
          "Strategies"
        ],
        "summary": "Update strategy",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Updated"
          },
          "404": {
            "description": "Not found"
          }
        }
      },
      "delete": {
        "tags": [
          "Strategies"
        ],
        "summary": "Delete strategy",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          },
          {
            "name": "name",
            "in": "query",
            "schema": {
              "type": "string"
            },
            "description": "Fallback: delete by name"
          }
        ],
        "responses": {
          "200": {
            "description": "Deleted"
          },
          "404": {
            "description": "Not found"
          }
        }
      }
    },
    "/bankroll": {
      "get": {
        "tags": [
          "Bankroll"
        ],
        "summary": "Get bankroll",
        "responses": {
          "200": {
            "description": "Bankroll data",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BankrollResponse"
                }
              }
            }
          }
        }
      },
      "post": {
        "tags": [
          "Bankroll"
        ],
        "summary": "Set initial bankroll (upsert)",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/BankrollSetRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated"
          },
          "201": {
            "description": "Created"
          }
        }
      }
    },
    "/bankroll/adjust": {
      "post": {
        "tags": [
          "Bankroll"
        ],
        "summary": "Adjust bankroll",
        "description": "Positive = deposit, negative = withdrawal.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/BankrollAdjustRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Adjusted"
          },
          "400": {
            "description": "Bankroll not initialized"
          }
        }
      }
    },
    "/risky-teams": {
      "get": {
        "tags": [
          "Risky Teams"
        ],
        "summary": "List risky teams",
        "responses": {
          "200": {
            "description": "Array of teams",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "integer"
                      },
                      "name": {
                        "type": "string"
                      },
                      "game": {
                        "type": "string"
                      },
                      "status": {
                        "type": "string"
                      },
                      "notes": {
                        "type": "string"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "post": {
        "tags": [
          "Risky Teams"
        ],
        "summary": "Add risky team (admin)",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/RiskyTeamRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Added"
          },
          "409": {
            "description": "Already exists"
          }
        }
      }
    },
    "/risky-teams/{id}": {
      "delete": {
        "tags": [
          "Risky Teams"
        ],
        "summary": "Remove risky team (admin)",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Deleted"
          }
        }
      }
    },
    "/telegram-groups": {
      "get": {
        "tags": [
          "Telegram Groups"
        ],
        "summary": "List Telegram groups",
        "responses": {
          "200": {
            "description": "Array of groups",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "format": "uuid"
                      },
                      "name": {
                        "type": "string"
                      },
                      "link": {
                        "type": "string"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "post": {
        "tags": [
          "Telegram Groups"
        ],
        "summary": "Add Telegram group",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/TelegramGroupRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created"
          }
        }
      }
    },
    "/telegram-groups/{id}": {
      "delete": {
        "tags": [
          "Telegram Groups"
        ],
        "summary": "Remove Telegram group",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Deleted"
          },
          "404": {
            "description": "Not found"
          }
        }
      }
    },
    "/telegram/webhook": {
      "post": {
        "tags": [
          "Telegram"
        ],
        "summary": "Telegram Bot webhook",
        "description": "Receives Telegram updates. Parses bet messages. No auth required.",
        "security": [],
        "responses": {
          "200": {
            "description": "Webhook processed"
          },
          "503": {
            "description": "Bot not configured"
          }
        }
      }
    },
    "/ai/recommend": {
      "post": {
        "tags": [
          "AI"
        ],
        "summary": "AI match recommendation",
        "description": "DeepSeek-powered CS2 match analysis.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/AIRecommendRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Recommendation",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AIRecommendationResponse"
                }
              }
            }
          },
          "502": {
            "description": "AI error"
          },
          "503": {
            "description": "AI not configured"
          }
        }
      }
    },
    "/ai/advice": {
      "post": {
        "tags": [
          "AI"
        ],
        "summary": "Bankroll advice",
        "description": "Contextual advice based on bankroll state.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/AIAdviceRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Advice text",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "advice": {
                      "type": "string",
                      "example": "..."
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;
export default spec;
