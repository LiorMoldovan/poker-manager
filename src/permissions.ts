import { Permission, PermissionRole } from './types';

const ROLE_PERMISSIONS: Record<PermissionRole, Permission[]> = {
  admin: [
    'game:create',
    'game:manage_rebuys',
    'game:enter_chips',
    'game:finalize',
    // 'game:delete' is intentionally NOT granted to admins — only the group
    // owner and super admins can delete a game from history. This prevents
    // accidental destructive actions by promoted admins.
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
