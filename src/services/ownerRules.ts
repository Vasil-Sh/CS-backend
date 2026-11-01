// ═══════════════════════════════════════════
// Who may do what to an account.
//
//   owner  — admin with is_owner: everything below + delete/demote admins,
//            reset admins' passwords, appoint/remove owners.
//   admin  — create admins, promote users to admin, edit any account's
//            data and subscription, delete users, reset users' passwords.
//
// Nobody can delete or demote themselves, and at least one owner must remain.
// ═══════════════════════════════════════════

export interface Account { id: number; role: string; isOwner: boolean }
export interface Denied { status: 400 | 403; error: string }

const isAdmin = (a: Account) => a.role === 'admin';

export function checkDelete(actor: Account, target: Account, ownerCount: number): Denied | null {
  if (actor.id === target.id) return { status: 400, error: 'Не можна видалити власний обліковий запис' };
  if (isAdmin(target) && !actor.isOwner) return { status: 403, error: 'Видаляти адміністраторів може лише власник' };
  if (target.isOwner && ownerCount <= 1) return { status: 400, error: 'Не можна видалити останнього власника' };
  return null;
}

export function checkResetPassword(actor: Account, target: Account): Denied | null {
  if (isAdmin(target) && actor.id !== target.id && !actor.isOwner) {
    return { status: 403, error: 'Скидати пароль адміністратора може лише власник' };
  }
  return null;
}

export interface AccessChange { role?: string; isOwner?: boolean; password?: boolean }

/**
 * Validates a change to role / owner flag / password.
 * On success returns the values to store (demoting to user also clears the
 * owner flag; making someone an owner also makes them an admin).
 */
export function checkUpdate(
  actor: Account, target: Account, change: AccessChange, ownerCount: number,
): Denied | { role: string; isOwner: boolean } {
  let role = change.role ?? target.role;
  let isOwner = change.isOwner ?? target.isOwner;
  if (change.isOwner === true) role = 'admin';
  if (role !== 'admin') isOwner = false;

  const self = actor.id === target.id;
  if (self && isAdmin(target) && role !== 'admin') {
    return { status: 400, error: 'Не можна зняти роль адміністратора з власного облікового запису' };
  }
  if (isOwner !== target.isOwner && !actor.isOwner) {
    return { status: 403, error: 'Призначати й знімати власників може лише власник' };
  }
  if (isAdmin(target) && role !== 'admin' && !actor.isOwner) {
    return { status: 403, error: 'Знімати роль адміністратора може лише власник' };
  }
  if (change.password && isAdmin(target) && !self && !actor.isOwner) {
    return { status: 403, error: 'Змінювати пароль адміністратора може лише власник' };
  }
  if (target.isOwner && !isOwner && ownerCount <= 1) {
    return { status: 400, error: 'Має залишитися хоча б один власник' };
  }
  return { role, isOwner };
}
