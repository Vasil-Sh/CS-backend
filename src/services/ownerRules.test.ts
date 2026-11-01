import { describe, it, expect } from 'vitest';
import { checkDelete, checkResetPassword, checkUpdate } from './ownerRules';

const owner = { id: 1, role: 'admin', isOwner: true };
const owner2 = { id: 5, role: 'admin', isOwner: true };
const admin = { id: 2, role: 'admin', isOwner: false };
const admin2 = { id: 3, role: 'admin', isOwner: false };
const user = { id: 4, role: 'user', isOwner: false };

describe('checkDelete', () => {
  it('admin deletes users, not admins', () => {
    expect(checkDelete(admin, user, 1)).toBeNull();
    expect(checkDelete(admin, admin2, 1)?.status).toBe(403);
    expect(checkDelete(admin, owner, 1)?.status).toBe(403);
  });
  it('owner deletes admins and other owners, but not the last owner or self', () => {
    expect(checkDelete(owner, admin, 1)).toBeNull();
    expect(checkDelete(owner, owner2, 2)).toBeNull();
    expect(checkDelete(owner, owner, 2)?.status).toBe(400);
  });
});

describe('checkResetPassword', () => {
  it('only owner resets another admin password', () => {
    expect(checkResetPassword(admin, user)).toBeNull();
    expect(checkResetPassword(admin, admin2)?.status).toBe(403);
    expect(checkResetPassword(owner, admin)).toBeNull();
    expect(checkResetPassword(admin, admin)).toBeNull(); // own password
  });
});

describe('checkUpdate', () => {
  it('admin can promote a user to admin and edit admins without touching role', () => {
    expect(checkUpdate(admin, user, { role: 'admin' }, 1)).toEqual({ role: 'admin', isOwner: false });
    expect(checkUpdate(admin, admin2, { role: 'admin' }, 1)).toEqual({ role: 'admin', isOwner: false });
    expect(checkUpdate(admin, owner, {}, 1)).toEqual({ role: 'admin', isOwner: true });
  });
  it('admin cannot demote admins, change owners or admin passwords', () => {
    expect((checkUpdate(admin, admin2, { role: 'user' }, 1) as any).status).toBe(403);
    expect((checkUpdate(admin, admin2, { isOwner: true }, 1) as any).status).toBe(403);
    expect((checkUpdate(admin, user, { isOwner: true }, 1) as any).status).toBe(403);
    expect((checkUpdate(admin, admin2, { password: true }, 1) as any).status).toBe(403);
  });
  it('owner appoints owners (making them admin) and demotes admins', () => {
    expect(checkUpdate(owner, user, { isOwner: true }, 1)).toEqual({ role: 'admin', isOwner: true });
    expect(checkUpdate(owner, admin, { role: 'user' }, 1)).toEqual({ role: 'user', isOwner: false });
    expect(checkUpdate(owner, owner2, { role: 'user' }, 2)).toEqual({ role: 'user', isOwner: false });
  });
  it('keeps at least one owner and blocks self-demotion', () => {
    expect((checkUpdate(owner, owner, { isOwner: false }, 1) as any).status).toBe(400);
    expect(checkUpdate(owner, owner, { isOwner: false }, 2)).toEqual({ role: 'admin', isOwner: false });
    expect((checkUpdate(owner, owner, { role: 'user' }, 2) as any).status).toBe(400);
    expect((checkUpdate(admin, admin, { role: 'user' }, 1) as any).status).toBe(400);
  });
});
