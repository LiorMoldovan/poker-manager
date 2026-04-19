import { Permission, PermissionRole } from './types';

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
    'view:all',
  ],
  member: [
    'view:all',
  ],
};

export const hasPermission = (role: PermissionRole | null, permission: Permission): boolean => {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
};

export const getRoleDisplayName = (role: PermissionRole): string => {
  switch (role) {
    case 'admin': return 'מנהל (Admin)';
    case 'member': return 'חבר (Member)';
  }
};

export const getRoleEmoji = (role: PermissionRole): string => {
  switch (role) {
    case 'admin': return '👑';
    case 'member': return '⭐';
  }
};
