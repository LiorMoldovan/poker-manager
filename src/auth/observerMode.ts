// Observer mode = a super admin has switched the active group to one
// they aren't a member of. Used to make the super-admin invisible to
// the target group's members:
//   * activityLogger skips its INSERT/UPDATE on activity_log
//   * savePushSubscription bails so we don't auto-register the
//     super-admin's browser to the target group's push roster
//
// The flag lives in this tiny module (not React state) because the
// callers above are plain TypeScript functions executed from anywhere
// in the app. App.tsx is responsible for keeping the flag in sync with
// the auth state via setObserverMode(); everyone else only reads.

let _isObserving = false;

export function setObserverMode(value: boolean): void {
  _isObserving = value;
}

export function isObserverMode(): boolean {
  return _isObserving;
}
