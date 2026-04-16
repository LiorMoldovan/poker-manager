import { Permission, PermissionRole } from './types';

// PIN codes for each role
export const ROLE_PINS: Record<PermissionRole, string> = {
  admin: '2351',
  member: '2580',
  viewer: '9876',
};

// Permission definitions per role
const ROLE_PERMISSIONS: Record<PermissionRole, Permission[]> = {
  admin: [
    'game:create',
    'game:manage_rebuys',
    'game:enter_chips',
    'game:finalize',
    'game:delete',
    'game:clear_all',
    'player:add',
    'player:edit',
    'player:change_type',
    'player:delete',
    'chips:edit',
    'settings:edit',
    'backup:all',
    'view:all',
  ],
  member: [
    'game:create',
    'game:manage_rebuys',
    'game:enter_chips',
    'game:finalize',
    'player:add',
    'backup:all',
    'view:all',
  ],
  viewer: [
    'backup:all',
    'view:all',
  ],
};

// Get role from PIN
export const getRoleFromPin = (pin: string): PermissionRole | null => {
  for (const [role, rolePin] of Object.entries(ROLE_PINS)) {
    if (rolePin === pin) {
      return role as PermissionRole;
    }
  }
  return null;
};

// Check if role has permission
export const hasPermission = (role: PermissionRole | null, permission: Permission): boolean => {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
};

// Check if role can access a feature (convenience function)
export const canAccess = (role: PermissionRole | null, permissions: Permission[]): boolean => {
  if (!role) return false;
  return permissions.every(p => hasPermission(role, p));
};

// Get role display name
export const getRoleDisplayName = (role: PermissionRole): string => {
  switch (role) {
    case 'admin': return 'מנהל (Admin)';
    case 'member': return 'חבר קבוע (Member)';
    case 'viewer': return 'צופה (Viewer)';
  }
};

// Get role emoji
export const getRoleEmoji = (role: PermissionRole): string => {
  switch (role) {
    case 'admin': return '👑';
    case 'member': return '⭐';
    case 'viewer': return '👁️';
  }
};

