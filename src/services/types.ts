// ═══════════════════════════════════════════
// Shared types for services
// ═══════════════════════════════════════════

export interface BetStats {
  totalBets: number;
  wins: number;
  totalProfit: number;
  totalRoi: number;
}

export interface BetPagination {
  rows: any[];
  total: number;
  page: number;
  limit: number;
}

export interface AuthResult {
  success: boolean;
  token?: string;
  refreshToken?: string;
  isAdmin?: boolean;
  user?: { username: string; role: string; telegram?: string };
  error?: string;
  status: number;
}
