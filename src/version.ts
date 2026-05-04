/**
 * App Version Management
 * Increment version with each change for tracking purposes
 * Last deploy trigger: 2026-04-20-v2
 */

export const APP_VERSION = '5.37.1';

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '5.37.1',
    date: '2026-05-04',
    changes: [
      '🚑 Blank-screen watchdog: 10s → 6s',
      '🚑 Up to 3 auto-recovery attempts (was 1)',
      '🚑 "טוען…" overlay at 2.5s for visible feedback',
      '🚑 Final retry UI after exhausted recovery',
    ],
  },
  {
    version: '5.37.0',
    date: '2026-05-04',
    changes: [
      '📣 Send-reminder button on every active poll',
      '🎯 Recipients: registered members missing any date',
      '🟠 Per-row badges: לא הצביע / 1/3',
      '✉️ Email: personal greeting + live state + countdown',
      '✉️ All emails forced RTL via RLM prefix',
      '🧹 Removed legacy poll card variant',
    ],
  },
  {
    version: '5.36.0',
    date: '2026-05-04',
    changes: [
      '🗓 Auto-open weekly poll (configurable day + time)',
      '🗓 One date per configured game-night day',
      '🛠 Reuses target / delay / start time',
      '🔔 Push + email follow Schedule toggles',
      '🛡 New SQL: 050-schedule-auto-create',
    ],
  },
  {
    version: '5.35.9',
    date: '2026-05-03',
    changes: [
      '🎯 Optimal settlement for 7-8 player games',
      '🛠 Recursion threshold: 7 → 8',
      '🛠 Fewer trips per person',
      '🛡 Validated against 12 real games',
      '🛡 Auto-closed games stay locked',
    ],
  },
  {
    version: '5.35.7',
    date: '2026-05-03',
    changes: [
      '🩹 Activity heatmap: chronological column order',
      '🩹 "לילה 0-6" → "אחרי חצות"',
    ],
  },
  {
    version: '5.35.6',
    date: '2026-05-03',
    changes: [
      '🩹 Activity tab: rolling 7-day window',
      '🩹 Labels: "7 ימים אחרונים (נע)"',
    ],
  },
  {
    version: '5.35.5',
    date: '2026-05-03',
    changes: [
      '🩹 Activity dates: collapse same-day range',
      '🩹 Caption: "מיום ראשון" instead of "משבת"',
    ],
  },
  {
    version: '5.35.4',
    date: '2026-05-03',
    changes: [
      '🩹 Weekly window: Sun→Sat',
    ],
  },
  {
    version: '5.35.3',
    date: '2026-05-03',
    changes: [
      '🩹 Activity uses live linked player names',
      '🩹 SQL 049: heal stamped player names',
    ],
  },
  {
    version: '5.35.2',
    date: '2026-05-03',
    changes: [
      '🩹 Realtime DELETE events now reach clients',
      '🛡 SQL 048: REPLICA IDENTITY FULL',
      '🛡 Re-fetch on tab focus',
    ],
  },
  {
    version: '5.35.1',
    date: '2026-05-03',
    changes: [
      '🩹 Heal duplicate Sefi player record',
      '🛡 SQL 046: merge duplicate',
      '🛡 SQL 047: list_linkable_players RPC',
      '🛡 PlayerPicker shows existing players first',
      '🔒 Admins can no longer delete games',
      '🔧 Activity log: "/p/*" → "Poll Link"',
    ],
  },
  {
    version: '5.35.0',
    date: '2026-05-03',
    changes: [
      '🎯 Training "Save AI fix" re-grades old answers',
      '🩹 SQL 044: regrade historical answers',
      '🛡 SQL 045: security/perf hardening',
      '🔧 TTS: drop bad rebuy-count sentences',
      '🩹 Training upload: stop dropping new players',
      '🔧 Surface upload errors in console',
      '🔧 Numpad reads left-to-right on RTL',
      '🔧 Translate default chip color names',
      '📚 Document Supabase MCP in agent docs',
    ],
  },
  {
    version: '5.34.2',
    date: '2026-05-03',
    changes: [
      '🚨 Fix completed-game wipe on group sync',
      '🐛 Local cache no longer authoritative for deletes',
      '🩹 Sync flushes are now upsert-only',
      '🩹 fetchByGameIds paginates >1000 rows',
      '🛡 SQL 043: block bulk deletes server-side',
    ],
  },
  {
    version: '5.34.1',
    date: '2026-05-02',
    changes: [
      '🛠 SQL 042: min-transfer default 20 → 5',
      '🔧 Schedule poll: bulk-cancel proxy votes',
      '🔧 Settings header fits on 280px',
      '🔧 Player rows: cleaner gender glyph',
      '🔧 Compact poll timer phase strings',
      '🔧 Kebab menu via portal (no clipping)',
      '🔧 Hebrew dates use middle-dot separator',
      '🔧 Push tab: deduped subscriber count',
      '🔧 Activity sorted by full timestamp',
    ],
  },
  {
    version: '5.34.0',
    date: '2026-05-02',
    changes: [
      '✅ New compact schedule poll card',
      '🔧 Action strip: ≤3 chips + kebab',
      '🔧 Tighter date tile layout',
      '🔧 Shorter schedule copy across the board',
      '🛠 Restored deleted May-2 confirmed poll',
    ],
  },
  {
    version: '5.33.6',
    date: '2026-05-01',
    changes: [
      '🔧 NumericInput: clear and re-type cleanly',
    ],
  },
  {
    version: '5.33.5',
    date: '2026-05-01',
    changes: [
      '🔧 Activity: no more duplicate user cards',
      '🛡 SQL 041: backfill NULL player_name',
    ],
  },
  {
    version: '5.33.4',
    date: '2026-05-01',
    changes: [
      '✂️ Trimmed WhatsApp share captions',
    ],
  },
  {
    version: '5.33.3',
    date: '2026-04-30',
    changes: [
      '🏷 Added "סיכום:" label above vote pills',
    ],
  },
  {
    version: '5.33.2',
    date: '2026-04-30',
    changes: [
      '📲 PWA install hardened for Edge mobile',
    ],
  },
  {
    version: '5.33.1',
    date: '2026-04-30',
    changes: [
      '🖼 Share image cap raised 1200 → 1900px',
      '🔍 Invitation typography +10–15%',
    ],
  },
  {
    version: '5.33.0',
    date: '2026-04-30',
    changes: [
      '🚑 Bootstrap watchdog auto-heals blank PWA',
      '🧹 Watchdog clears once React renders',
      '🔄 Service worker bumped v3 → v4',
    ],
  },
  {
    version: '5.32.2',
    date: '2026-04-30',
    changes: [
      '🏷 Heading: "השוואה בין תאריכים" → "סיכום הצבעות"',
    ],
  },
  {
    version: '5.32.1',
    date: '2026-04-30',
    changes: [
      '✂️ Removed "בחר" on single-date polls',
    ],
  },
  {
    version: '5.32.0',
    date: '2026-04-30',
    changes: [
      '🔗 Poll share link uses 6-char slug',
      '🛡️ SQL 040: share_slug column + RPC',
      '🛤️ Deep-link route handles both shapes',
    ],
  },
  {
    version: '5.31.4',
    date: '2026-04-30',
    changes: [
      '✂️ Hid duplicate "בחר" on multi-date rows',
    ],
  },
  {
    version: '5.31.3',
    date: '2026-04-30',
    changes: [
      '🔗 Share link: /p/<uuid> short form',
      '🔍 Share-card typography +20%',
    ],
  },
  {
    version: '5.31.2',
    date: '2026-04-30',
    changes: [
      '✂️ Pick button: "בחר" instead of "בחר תאריך"',
    ],
  },
  {
    version: '5.31.1',
    date: '2026-04-30',
    changes: [
      '✂️ Shorter destructive button labels',
    ],
  },
  {
    version: '5.31.0',
    date: '2026-04-30',
    changes: [
      '🔒 New: lock voting on schedule polls',
      '🛡️ SQL 039: voting_lock column + RPC',
      '🎨 Action row: constructive vs destructive split',
      '🌐 New translation keys for lock state',
      '🎨 Vote-count pills: large variant',
      '🌌 DateCompetitionStrip: indigo skin',
    ],
  },
  {
    version: '5.30.3',
    date: '2026-04-30',
    changes: [
      '📤 One share button + chooser when ambiguous',
    ],
  },
  {
    version: '5.30.2',
    date: '2026-04-30',
    changes: [
      '🪗 Per-date voter chips collapse by default',
    ],
  },
  {
    version: '5.30.1',
    date: '2026-04-30',
    changes: [
      '🚧 Comic feature parked behind flag',
    ],
  },
  {
    version: '5.30.0',
    date: '2026-04-30',
    changes: [
      '🗳️ New "Date competition" strip',
      '🎯 Pick / re-pin date flow',
      '📤 Share buttons match user intent',
      '✂️ Multi-date share image compact',
      '🔁 Below-target reverts to voting chrome',
      '🐛 RTL bidi fix on seat counter',
      '🎨 Single percentage-driven palette',
      '🌐 Schedule surfaced in wizard help',
      '🔔 Notification banner shows real title',
      '🔗 Google OAuth preserves full URL',
    ],
  },
  {
    version: '5.29.3',
    date: '2026-04-30',
    changes: [
      '🐛 Payment modal arrow flips in RTL',
    ],
  },
  {
    version: '5.29.2',
    date: '2026-04-30',
    changes: [
      '🎟️ Confirmation hero: stamp layout',
      '👥 Participants pill on right edge',
      'ℹ️ Footnote explaining ranks',
    ],
  },
  {
    version: '5.29.1',
    date: '2026-04-30',
    changes: [
      '🪪 Confirmation card: single screen',
      '📝 Admin note moved up',
      '📊 Table mirrors stats share format',
    ],
  },
  {
    version: '5.29.0',
    date: '2026-04-30',
    changes: [
      '📊 Confirmation card: half-year leaderboard',
      '🔍 Shows overall period rank',
      '📐 Share card: 720 → 900px',
      '🔢 Sign formatting via single LRM',
    ],
  },
  {
    version: '5.28.1',
    date: '2026-04-30',
    changes: [
      '🎫 Removed redundant status pill on share',
      '🔧 Fixed English key leakage on confirmation',
      '📱 Share card: 520 → 720px',
      '🎨 Comic bubbles narrower',
      '🤖 Comic prompt: character-first',
    ],
  },
  {
    version: '5.28.0',
    date: '2026-04-30',
    changes: [
      '🎨 Comic art: Pollinations FLUX, no text leakage',
      '📊 Per-panel progress reporting',
      '💬 Wider speech bubbles',
      '🎫 Boarding-pass: 4 uniform segments',
      '🔧 SQL 035: zero-sum trigger fix',
    ],
  },
  {
    version: '5.27.6',
    date: '2026-04-30',
    changes: [
      '📦 Consolidated multi-agent push (5.27.0–5.27.5)',
    ],
  },
  {
    version: '5.27.5',
    date: '2026-04-30',
    changes: [
      '🎨 Training: weekly count chip → emerald',
    ],
  },
  {
    version: '5.27.4',
    date: '2026-04-30',
    changes: [
      '🎯 Training rows: sort by last session',
    ],
  },
  {
    version: '5.27.3',
    date: '2026-04-30',
    changes: [
      '👤 Activity card: split last-visit vs 30d',
    ],
  },
  {
    version: '5.27.2',
    date: '2026-04-30',
    changes: [
      '🎯 Training rows: show last session date+time',
    ],
  },
  {
    version: '5.27.1',
    date: '2026-04-30',
    changes: [
      '📊 Weekly trend bars: visits, not unique users',
    ],
  },
  {
    version: '5.27.0',
    date: '2026-04-30',
    changes: [
      '🔔 Auto-notify reporter on flag resolve',
      '🤖 AI rationale included in email',
      '📨 Personalized per-reporter emails',
      '🛠️ New trainingReportNotifications helper',
    ],
  },
  {
    version: '5.26.4',
    date: '2026-04-30',
    changes: [
      '🛡️ Multi-device save: omit undefined fields',
      '🐛 Fix: AI summary no longer disappears',
    ],
  },
  {
    version: '5.26.3',
    date: '2026-04-30',
    changes: [
      '🐛 Fix: AI regenerations no longer revert',
      '🚨 Surface sync errors as toasts',
      '🧹 Track per-game pending writes',
    ],
  },
  {
    version: '5.26.2',
    date: '2026-04-30',
    changes: [
      '🩺 Comic errors: collapsible technical details',
      '🔁 Comic art: model alias fallback',
      '📐 Schedule header: title no longer truncates',
    ],
  },
  {
    version: '5.26.1',
    date: '2026-04-29',
    changes: [
      '🎨 Stage-tagged comic errors',
      '🔄 Comic art: multi-model fallback chain',
      '📊 Structured pipeline logging',
      '📐 Schedule header: flex-wrap layout',
    ],
  },
  {
    version: '5.26.0',
    date: '2026-04-29',
    changes: [
      '🎨 New: Game-Night Comic',
      '🖼️ Six auto-picked comic styles',
      '🗄️ SQL 033: comic Storage bucket',
      '🗳️ Polls: delete + edit + vote history',
      '🔔 Polls: vote-change notifications',
      '📲 Vote reminder banner',
      '🔡 Heebo font for comic bubbles',
    ],
  },
  {
    version: '5.25.0',
    date: '2026-04-28',
    changes: [
      '📅 New: Schedule (Next Game) date polls',
      '⚙️ Removed 2-5 date limit on polls',
      '🧭 Settings: moved Schedule tab to end',
      '🗓️ Activity heatmap: date range header',
    ],
  },
  {
    version: '5.24.4',
    date: '2026-04-28',
    changes: [
      '🗓️ Heatmap: highlight today\'s row',
    ],
  },
  {
    version: '5.24.3',
    date: '2026-04-28',
    changes: [
      '🎯 Pool generation aligned with quality scan',
      '✅ AI self-check before returning JSON',
      '🛡 Tighter local validation',
    ],
  },
  {
    version: '5.24.2',
    date: '2026-04-28',
    changes: [
      '⚡ Quality scan: smaller batches',
      '🔄 Prefer stable models',
      '🔁 Retry on 429/503/504',
    ],
  },
  {
    version: '5.24.1',
    date: '2026-04-28',
    changes: [
      '⚡ Pool generation: 6 questions per batch',
      '🔄 Prefer stable models',
      '🔁 Retry on 504',
    ],
  },
  {
    version: '5.24.0',
    date: '2026-04-28',
    changes: [
      '🤖 Pool gen: try all 3 models',
      '🔍 Per-category diagnostics',
      '💬 Restored WhatsApp share in fix preview',
    ],
  },
  {
    version: '5.23.4',
    date: '2026-04-26',
    changes: [
      '📱 Wizard: mobile-first centered layout',
      '📱 Better add-players spacing',
    ],
  },
  {
    version: '5.23.3',
    date: '2026-04-26',
    changes: [
      '📱 Wizard scroll fix on small screens',
    ],
  },
  {
    version: '5.23.2',
    date: '2026-04-26',
    changes: [
      '📱 Live game: aligned rebuy column',
    ],
  },
  {
    version: '5.23.1',
    date: '2026-04-26',
    changes: [
      '📱 Stats mode bar: flex-wrap',
    ],
  },
  {
    version: '5.23.0',
    date: '2026-04-26',
    changes: [
      '✅ Add/remove players during live game',
      '📱 Compact single-line player rows',
      '📱 Player count in summary card',
      '📱 Recent actions collapsed by default',
      '🔧 ROI division-by-zero guard',
      '✅ Wizard improvements',
      '📱 Settings: unified buttons',
      '📊 Stats: reordered mode buttons',
      '🔧 Owner inherits admin permissions',
    ],
  },
  {
    version: '5.22.6',
    date: '2026-04-21',
    changes: [
      '🎨 Split push/email test buttons',
      '🎨 Group info: totals + active since',
      '🎨 Members sorted by role',
      '🎨 Invite code in group info card',
      '🎨 Game flow guide modal',
      '🎨 Settings cleanup',
      '🎨 Buyin value helper text',
      '🃏 Board cards in training reports',
    ],
  },
  {
    version: '5.22.5',
    date: '2026-04-21',
    changes: [
      '🔧 Exclude super admin from activity',
      '🔧 Activity sorted by last login',
      '🔧 Better email notifications',
    ],
  },
  {
    version: '5.22.0',
    date: '2026-04-21',
    changes: [
      '✅ New: report-a-bug Settings tab',
      '✅ Owner emailed on new reports',
      '✅ Super admin sees all groups\' reports',
      '🔧 Activity: accurate session counts',
      '🔧 Activity: today by calendar date',
      '🔧 Activity: owner included',
    ],
  },
  {
    version: '5.21.0',
    date: '2026-04-21',
    changes: [
      'Push: filter by player type',
      'Push: send via Push, Email, or both',
      'Push: self-test button',
      'Push: stale endpoint cleanup',
      'Push API: cleaner result chips',
      'Email: broadcast mode',
      'Fix: player type label mapping',
    ],
  },
  {
    version: '5.20.0',
    date: '2026-04-20',
    changes: [
      'Wizard: chips, invites, summary',
      'Wizard: RTL arrows, skip optional steps',
      'Push: stale subscription recovery',
      'Push tab: cleaned up debug UI',
      'Training: share as image',
      'Game routes: fixed paths',
      'TTS card: super admin only',
    ],
  },
  {
    version: '5.19.0',
    date: '2026-04-20',
    changes: [
      'Training: direct Supabase + realtime',
      'Activity: 2min cooldown',
      'Activity tab: popular screens, training, adoption',
      'Activity: today active names + weekly trend',
      'Super admin: premium dashboard',
      'Super admin: weekly trainers from sessions',
      'Supabase: parallel + scoped refresh',
      'Training pool: in-memory cache',
      'Training writes: only changed rows',
      'Group mgmt: cleaner role layout',
      'SQL 015-018 applied',
    ],
  },
  {
    version: '5.18.0',
    date: '2026-04-20',
    changes: [
      '✨ Premium UI animations',
      '👥 Redesigned members list',
      '🔔 Settlement notifications',
      '🔧 Push: signature + diagnostics fix',
      '📸 Screenshot: freeze animations',
      '🧹 Removed redundant unlink button',
    ],
  },
  {
    version: '5.17.4',
    date: '2026-04-20',
    changes: [
      '👥 Members can see all other members',
      '🔒 Names + roles, not emails',
    ],
  },
  {
    version: '5.17.3',
    date: '2026-04-20',
    changes: [
      '🔔 Push: VAPID + JWK fixes',
      '🎯 Test Push respects selection',
      '📝 Helper text reflects target',
    ],
  },
  {
    version: '5.17.2',
    date: '2026-04-20',
    changes: [
      '🔐 Auth: JWKS for ES256',
      '🔄 Unified auth across API routes',
      '🔑 Robust token refresh',
      '🩺 Added /api/health',
    ],
  },
  {
    version: '5.17.1',
    date: '2026-04-20',
    changes: [
      '🔧 Push: P1363 signature format',
      '📧 Email: EmailJS private key',
      '🗄️ Push: UPDATE RLS policy',
      '✏️ Player traits: comma/space fix',
    ],
  },
  {
    version: '5.17.0',
    date: '2026-04-19',
    changes: [
      '🔔 Real push notifications',
      '📧 Email: Resend → EmailJS',
      '🔧 Service worker + Web Push API',
      '💬 Notification templates',
      '🎯 Recipient picker',
    ],
  },
  {
    version: '5.16.1',
    date: '2026-04-19',
    changes: [
      '🔧 Fix Vercel build: vercel.json',
    ],
  },
  {
    version: '5.16.0',
    date: '2026-04-19',
    changes: [
      '✅ Multi-group support',
      '📦 Full backup & restore',
      '📦 Backup tab in Settings',
      '🌐 i18n audit: 50+ strings',
      '🤖 AI restricted to group owner',
      '🔧 TTS pool auto-cleanup',
      '🔧 Auto game-end backup includes more data',
      '🔧 Vercel toolbar disabled',
    ],
  },
  {
    version: '5.15.1',
    date: '2026-04-19',
    changes: [
      '✅ Cache reset on logout',
      '✅ Preserve player selection on refresh',
      '✅ Hebrew share button',
      '✅ Removed legacy listeners',
    ],
  },
  {
    version: '5.15.0',
    date: '2026-04-19',
    changes: [
      '✅ Permissions: removed viewer role',
      '✅ Super Admin dashboard',
      '✅ New group setup wizard',
      '✅ AI key onboarding',
      '✅ Member read-only on game screens',
      '✅ Per-group training_enabled flag',
      '✅ Removed backup tab (Supabase)',
      '✅ Settlement toggle for participants',
      '✅ Permission hardening',
      '✅ Hebrew localization fixes',
    ],
  },
  {
    version: '5.14.0',
    date: '2026-04-18',
    changes: [
      '✅ Personal player invites',
      '✅ Add member by email',
      '✅ Shareable invite messages',
      '✅ Join supports both code formats',
    ],
  },
  {
    version: '5.13.0',
    date: '2026-04-17',
    changes: [
      '✅ Group Management tab',
      '✅ Per-group API keys',
      '✅ Post-creation invite screen',
      '✅ Self-create player flow',
      '🔧 Owner-aware RPC security',
      '🔧 Player delete guard',
      '🔧 Player linking uniqueness',
      '🔧 Removed memberSync role',
    ],
  },
  {
    version: '5.12.6',
    date: '2026-04-12',
    changes: [
      '🔄 Fix stale training data on flush',
      '🧹 Clear pending buffer on player delete',
      '⏱️ 30min stale-buffer safety',
      '📊 Rebuild progress from remote',
    ],
  },
  {
    version: '5.12.5',
    date: '2026-04-12',
    changes: [
      '🔄 Remote training data is authoritative',
    ],
  },
  {
    version: '5.12.4',
    date: '2026-04-12',
    changes: [
      '🧹 Per-player cloud data management',
      '📊 Insight generation stats',
      '🗑️ Removed hardcoded leaderboard exclusion',
    ],
  },
  {
    version: '5.12.3',
    date: '2026-04-12',
    changes: [
      '🔄 Cloud sync: preserve local-only games',
      '🔑 Authenticated GitHub reads',
      '📋 Shared training fix-format rules',
      '🎯 Admin per-player leaderboard exclusion',
      '📊 getTrainingSessionCounts utility',
      '🗂️ History: stable sort + reload',
      '⚙️ runGeminiTextPrompt: more params',
    ],
  },
  {
    version: '5.12.2',
    date: '2026-04-09',
    changes: [
      '📤 Friends can share published forecasts',
      '🖼️ WebP forecast images',
      '📱 Sequential WhatsApp sharing',
      '⚡ Optimized capture scale',
    ],
  },
  {
    version: '5.12.1',
    date: '2026-04-09',
    changes: [
      '📅 Custom date range in Graphs',
      '🧠 Smarter insight staleness',
      '✨ Always-visible batch insights button',
      '🏷️ Needs-insight badge on rows',
    ],
  },
  {
    version: '5.12.0',
    date: '2026-04-09',
    changes: [
      '📅 Custom date range in Statistics',
      '🎯 Forecast tone/highlight validation',
      '📎 Roster impact in forecast prompts',
      '🃏 Board cards separated from situation',
      '🔧 Shared runGeminiTextPrompt with fallbacks',
      '📊 Direction-correct gets partial credit',
      '🧹 Cleaner pool generation prompt',
      '⚡ Pool fetch: 3.5s timeout',
      '🔇 Neutralized answer support',
    ],
  },
  {
    version: '5.11.5',
    date: '2026-04-06',
    changes: [
      '🎯 Holistic player coaching',
      '📊 Real game stats in AI prompts',
      '🤖 Auto-coaching for eligible players',
      '💬 Personal coach card',
      '📈 Better strongest/weakest insights',
      '🔧 Milestone bundled with session upload',
    ],
  },
  {
    version: '5.11.4',
    date: '2026-04-06',
    changes: [
      '🎨 Training mode buttons: stacked layout',
    ],
  },
  {
    version: '5.11.3',
    date: '2026-04-06',
    changes: [
      '➕ Force expand pool',
      '🔍 Auto quality scan after gen',
      '📊 Pool counts on mode buttons',
      '💬 Richer flag responses',
      '🛡️ Robust AI review error handling',
    ],
  },
  {
    version: '5.11.2',
    date: '2026-04-05',
    changes: [
      '🔍 AI flag report analysis',
      '📊 Shared training analytics',
      '🏠 Home-game reasoning enforced',
      '📝 Richer personal reports',
    ],
  },
  {
    version: '5.11.1',
    date: '2026-04-05',
    changes: [
      '🔧 GitHub Blob API for >1MB files',
      '📋 Milestone teaser in reports',
      '🃏 Hebrew poker terminology enforced',
    ],
  },
  {
    version: '5.11.0',
    date: '2026-04-05',
    changes: [
      '🎯 Player styles + game context in prompts',
      '📝 AI personal training reports',
      '💬 Fun answer reactions',
      '🔄 Identity switch needs admin PIN',
      '🗣️ Game-night summary prompt rewritten',
      '🃏 Inline card coloring + odds categories',
    ],
  },
  {
    version: '5.10.9',
    date: '2026-03-11',
    changes: [
      '🛠️ Training admin cleanup',
      '⬅️ Settlement arrows: ← in RTL',
    ],
  },
  {
    version: '5.10.8',
    date: '2026-03-11',
    changes: [
      '📸 Shared captureAndSplit utility',
      '🚩 Rich flag reports',
      '🛠️ Admin flag management + AI fix',
      '🎯 Near-miss excluded from accuracy',
      '🗣️ Training data in TTS prompts',
      '🃏 Card BiDi fix in RTL',
    ],
  },
  {
    version: '5.10.7',
    date: '2026-03-11',
    changes: [
      '⚡ Reduced GitHub auto-commits',
      '🔄 Pool gen: single upload',
      '⏱️ Training answers: 10min cooldown',
      '📊 Activity logger: 15min cooldown',
    ],
  },
  {
    version: '5.10.6',
    date: '2026-03-11',
    changes: [
      '🔄 Mobile cache: no-cache for all routes',
    ],
  },
  {
    version: '5.10.5',
    date: '2026-03-11',
    changes: [
      '🤖 AI pool review',
      '💾 Partial session save',
      '🪪 Identity by player ID',
      '🎨 Hardcoded dark theme on standings',
      '📊 Top wins respect selected players',
      '🔧 Training banner UI fixes',
    ],
  },
  {
    version: '5.10.4',
    date: '2026-03-11',
    changes: [
      '🚩 Better flagged-question removal',
      '🎯 Near-miss icon: ½ → ~',
    ],
  },
  {
    version: '5.10.3',
    date: '2026-03-11',
    changes: [
      '📸 Image-based training shares',
      '🔄 Rebuild progress from remote',
      '🎯 Near-miss tracking',
      '💰 ₪ context in AI prompts',
      '📋 Training admin generation log',
      '🔧 Forecast / flagged updates immediate',
    ],
  },
  {
    version: '5.10.2',
    date: '2026-03-11',
    changes: [
      '🔄 Fix sync skipping when remote ahead',
    ],
  },
  {
    version: '5.10.1',
    date: '2026-03-11',
    changes: [
      '🎯 Personalized training banner',
      '🛡️ Pool gen: crash recovery',
      '🤖 Pool gen: best model + retry',
      '🔧 Truncated JSON salvage',
      '♾️ Unlimited mode counter',
    ],
  },
  {
    version: '5.10.0',
    date: '2026-03-11',
    changes: [
      '🎯 New: Shared Training (pool-based)',
      '🛠️ Training Admin tab',
      '☁️ Forecast publish auto-syncs',
      '🔄 Cloud forecast authoritative',
      '💱 Removed ₪ symbol',
    ],
  },
  {
    version: '5.9.8',
    date: '2026-03-11',
    changes: [
      '🔄 Forecast refresh keeps context',
      '📍 Location saved with pending forecast',
    ],
  },
  {
    version: '5.9.7',
    date: '2026-03-11',
    changes: [
      '🧪 Smart global insights',
      '🔮 Forecast card redesign',
      '📢 Unpublished visible to admin',
      '📊 Exact win counts',
      '🎯 Dynamic veteran threshold',
    ],
  },
  {
    version: '5.9.6',
    date: '2026-03-11',
    changes: [
      '📱 Mobile-friendly insight layout',
      '🔤 Larger insight text',
      '🎨 Key Insights section header',
    ],
  },
  {
    version: '5.9.5',
    date: '2026-03-11',
    changes: [
      '🧪 Enriched Chemistry insights',
      '🔍 Key Insights headline section',
      '🎯 Every player shows insight',
      '🧹 Removed duplicate summary layer',
    ],
  },
  {
    version: '5.9.4',
    date: '2026-03-30',
    changes: [
      '✨ Settlement UX improvements',
      '📱 History/stats polish',
    ],
  },
  {
    version: '5.9.3',
    date: '2026-03-26',
    changes: [
      '🔄 Merged latest improvements',
    ],
  },
  {
    version: '5.9.2',
    date: '2026-03-25',
    changes: [
      '📅 Monthly summary on month\'s last game',
      '🚫 Date-based blocked transfers',
      '📊 Combo history hidden if 1 shared game',
      '💬 ElevenLabs test text minimized',
      '🗑️ Delete TTS game entries',
      '📱 Activity log: meaningful sessions only',
    ],
  },
  {
    version: '5.9.1',
    date: '2026-03-11',
    changes: [
      '⚡ TTS latency optimization',
      '🗑️ Delete individual activity records',
      '🗑️ Delete individual TTS entries',
      '📱 Activity log text-wrap fix',
    ],
  },
  {
    version: '5.9.0',
    date: '2026-03-11',
    changes: [
      '🎙️ TTS prioritizes dynamic stats',
      '📅 Period markers use next game night',
      '🔇 Removed auto-announce timer',
    ],
  },
  {
    version: '5.8.9',
    date: '2026-03-11',
    changes: [
      '💸 Settlement: blocked transfers',
    ],
  },
  {
    version: '5.8.8',
    date: '2026-03-11',
    changes: [
      '☁️ Pending forecast cloud sync',
      '📊 Combo history dedup',
      '🌐 Hebrew graph period labels',
      '🎮 Larger live game buttons',
      '📱 Activity device cleanup',
    ],
  },
  {
    version: '5.8.7',
    date: '2026-03-19',
    changes: [
      '📋 Game summary cleanup',
    ],
  },
  {
    version: '5.8.6',
    date: '2026-03-19',
    changes: [
      '🔊 TTS engine major upgrade',
      '⚙️ Settings TTS panel',
      '🎮 Live game TTS refinements',
    ],
  },
  {
    version: '5.8.5',
    date: '2026-03-19',
    changes: [
      '🔊 Edge TTS for Hebrew',
      '⚙️ Settings overhaul',
      '🎮 Live game cleanup',
      '📊 Stats/graphs minor fixes',
    ],
  },
  {
    version: '5.8.4',
    date: '2026-03-18',
    changes: [
      '🤖 Background AI summaries',
      '📊 AI usage tracker enhancements',
      '🔊 TTS reliability fixes',
      '🎮 Live game / summary polish',
      '📝 Documented dev port 3000',
    ],
  },
  {
    version: '5.8.3',
    date: '2026-03-18',
    changes: [
      '📊 New: AI usage tracker',
      '⚙️ AI usage dashboard',
    ],
  },
  {
    version: '5.8.2',
    date: '2026-03-18',
    changes: [
      '🔧 Storage / AI / UI refinements',
    ],
  },
  {
    version: '5.8.1',
    date: '2026-03-18',
    changes: [
      '🎙️ Hebrew ordinals + richer announcements',
      '🏆 Once-per-session record announcements',
      '⏱️ AI progress bar component',
      '🎭 Player traits + gender Hebrew',
      '📊 2026 stats scoping for TTS',
      '🔧 Model display names + timing',
    ],
  },
  {
    version: '5.8.0',
    date: '2026-03-17',
    changes: [
      '🎙️ AI TTS pool',
      '🎭 Player traits system',
      '🏆 Rebuy records tracking',
      '📣 Social actions',
      '🎪 Awards ceremony',
      '🔄 Cursor rules → .mdc',
    ],
  },
  {
    version: '5.7.3',
    date: '2026-03-16',
    changes: [
      '🔍 Device fingerprinting',
      '📱 Activity log: device-grouped view',
    ],
  },
  {
    version: '5.7.2',
    date: '2026-03-16',
    changes: [
      '🏠 Refined location insights',
    ],
  },
  {
    version: '5.7.1',
    date: '2026-03-16',
    changes: [
      '🏠 Location insights',
      '🤝 Combo history polish',
      '📍 Locations in summary AI',
    ],
  },
  {
    version: '5.7.0',
    date: '2026-03-16',
    changes: [
      '📊 AI graph insights',
      '🤝 Combo history',
      '📱 Activity logger',
      '🎯 Unified surprise system',
      '📄 Forecast pages: 4 players each',
      '💬 Better H2H storylines',
      '📋 Game summary: deep-link sections',
      '🔊 TTS only at game end',
    ],
  },
  {
    version: '5.6.0',
    date: '2026-03-15',
    changes: [
      '📖 Player chronicles',
      '🏷️ Period markers',
      '🎭 Pre-game teaser',
      '🏆 Milestones engine refactor',
      '🤖 Gemini cascade updated',
      '📊 Stats: chronicle sharing',
      '🎮 Location + period selectors',
      '📜 Summary deep-linking',
    ],
  },
  {
    version: '5.5.3',
    date: '2026-03-13',
    changes: [
      '⚠️ AI summary error handling',
      '📜 History button polish',
    ],
  },
  {
    version: '5.5.2',
    date: '2026-03-13',
    changes: [
      '🔄 Regenerate AI summary button',
      '🔮 Robust forecast algorithm',
      '📜 History UI enhancements',
    ],
  },
  {
    version: '5.5.1',
    date: '2026-03-13',
    changes: [
      '🔊 TTS module + Hebrew numbers',
      '🧮 Optimized settlement algorithm',
      '🎙️ Fix truncated AI summaries',
      '📉 Graphs/stats cleanup',
      '🎮 LiveGame uses shared TTS',
    ],
  },
  {
    version: '5.5.0',
    date: '2026-03-13',
    changes: [
      '🤖 AI game-night summary',
      '📊 Half-year standings',
      '☁️ Restore from cloud backup',
      '🔮 Simplified forecast',
      '⚡ Smart deploy: skip data syncs',
      '💾 Training sync every 3 days',
    ],
  },
  {
    version: '5.4.2',
    date: '2026-03-12',
    changes: [
      '🔄 Training UI polish',
    ],
  },
  {
    version: '5.4.1',
    date: '2026-03-11',
    changes: [
      '⚡ Quick Training mode',
      '🗺️ Table position map',
      '🇮🇱 Full Hebrew localization',
      '🃏 Card validation',
      '📝 Stricter card-context prompt',
    ],
  },
  {
    version: '5.4.0',
    date: '2026-03-11',
    changes: [
      '🎯 New: Poker Training',
      '🧠 24 scenario categories',
      '📊 Progress tracking + insights',
      '☁️ GitHub cloud sync',
      '🔧 Backup type fix',
      '🧹 Settings cleanup',
    ],
  },
  {
    version: '5.2.6',
    date: '2026-02-26',
    changes: [
      '🐛 Fix Insights blank screen',
      '🔊 Reuse AudioContext for rebuy sound',
      '🎤 80+ new rebuy voice messages',
      '🖥️ Fix dropdowns on PC',
      '🎨 Redesign Impact cards',
      '🎭 Redesign "Moments of the Night"',
      '🧹 Remove arrows from impact badges',
    ],
  },
  {
    version: '5.2.0',
    date: '2026-02-26',
    changes: [
      '🎙️ TTS: winner & loser at game end',
      '📊 Pot milestone TTS',
      '🏆 Last man standing',
      '🎯 Personalized rebuy messages',
      '📋 Highlights redesign: 10 lines',
      '🔥 Streaks 4+ only',
      '🎯 Upsets merged',
      '👑 Rebuy King: 5+ buyins',
      '🧹 Lint cleanup',
    ],
  },
  {
    version: '5.1.0',
    date: '2026-02-05',
    changes: [
      '🎭 Highlights match assigned angle',
      '📊 Stat-card label clarity',
      '🚫 Stronger no-negative rule',
      '🎯 "מוביל" only for #1',
      '⚡ Surprise only at +40₪',
      '🔙 Comeback: 30 → 20 days',
    ],
  },
  {
    version: '5.0.0',
    date: '2026-02-05',
    changes: [
      '🤖 AI forecast: complete overhaul',
      '📝 Rich Hebrew prompt with examples',
      '🎭 Unique angle per player',
      '⚡ Quality-first model order',
      '🎨 Higher creativity settings',
      '🧹 Removed 300+ template lines',
      '🛡️ Fallback sentence',
      '✅ Code-generated highlights kept',
    ],
  },
  {
    version: '4.63.0',
    date: '2026-02-05',
    changes: [
      '📊 Every sentence has 2-3 stats',
      '🎯 Filter prefers stat-rich sentences',
      '🚫 Removed generic fillers',
      '🔗 Forecast correlation expanded',
    ],
  },
  {
    version: '4.61.0',
    date: '2026-02-05',
    changes: [
      '🔗 Sentence tone matches prediction',
      '🚫 No redundant forecast number',
      '✅ Tested on 8 real players',
      '📊 99% pass rate',
    ],
  },
  {
    version: '4.60.0',
    date: '2026-02-05',
    changes: [
      '💪 Encouraging tone',
      '🚫 No negative records',
      '🎯 Smart conditionals',
      '😊 Adult humor',
      '📊 99% quality pass',
    ],
  },
  {
    version: '4.59.0',
    date: '2026-02-05',
    changes: [
      '🎰 10-26 sentence options per player',
      '📊 100% factual stats',
      '🔥 New sentence types',
      '♀️ Gender-correct Hebrew',
      '✨ Unique per-player highlights',
      '🎯 AI predicts profit only',
    ],
  },
  {
    version: '4.58.0',
    date: '2026-02-05',
    changes: [
      '📊 Sentences include statistics',
      '🎯 Highlights show numbers',
      '📈 Context-aware sentences',
      '🔢 Real numeric examples',
    ],
  },
  {
    version: '4.48.0',
    date: '2026-02-05',
    changes: [
      '⏪ Restored v4.43.9 prompt',
      '🗑️ Removed experimental code',
      '✅ Back to AI-generated content',
    ],
  },
  {
    version: '4.46.0',
    date: '2026-02-05',
    changes: [
      '🎨 Clean prompt + few-shot examples',
      '✨ Creative AI output',
      '📊 Clear data format',
      '🌡️ Temperature 0.9',
      '💾 Backup of v4.43.9',
    ],
  },
  {
    version: '4.45.0',
    date: '2026-02-05',
    changes: [
      '🏗️ 100% code-generated sentences',
      '✨ 7 unique patterns',
      '🎯 Facts in code, not AI',
      '🚀 Faster, simpler prompt',
    ],
  },
  {
    version: '4.44.3',
    date: '2026-02-05',
    changes: [
      '🇮🇱 Hebrew: WON/LOST → רווח/הפסד',
      '✅ Pre-built highlight + sentence',
      '🎨 7 unique patterns',
      '📝 AI just polishes',
    ],
  },
  {
    version: '4.44.2',
    date: '2026-02-05',
    changes: [
      '🐛 Switch instead of arrow array',
      '✅ Safer pattern selection',
      '🔧 Null safety for periodGames',
    ],
  },
  {
    version: '4.44.1',
    date: '2026-02-05',
    changes: [
      '🎨 Code generates patterns by index',
      '✅ AI just polishes',
      '📝 Unique opening per player',
      '🔧 Sentences built in code',
    ],
  },
  {
    version: '4.44.0',
    date: '2026-02-05',
    changes: [
      '🔧 Pre-computed fact sheets',
      '✅ Ranking phrase pre-built',
      '📝 Simplified prompt',
      '🎯 Temperature 0.7',
    ],
  },
  {
    version: '4.43.11',
    date: '2026-02-22',
    changes: [
      '🎰 Rebuy Stats table in Statistics',
      '🔢 Sentences match announced count',
      '🗑️ Removed redundant rebuy lines',
    ],
  },
  {
    version: '4.43.10',
    date: '2026-02-05',
    changes: [
      '🔧 Temperature 0.95 → 0.9',
      '✅ Highlight + sentence must match',
      '🚫 Use only data facts',
    ],
  },
  {
    version: '4.43.9',
    date: '2026-02-05',
    changes: [
      '🎲 Random seed + player order',
      '🔥 Temperature 0.85 → 0.95',
      '✅ Truly different each run',
    ],
  },
  {
    version: '4.43.8',
    date: '2026-02-05',
    changes: [
      '🚨 Each sentence: different opener',
      '✍️ Explicit opening patterns',
      '🎨 Stronger variety enforcement',
    ],
  },
  {
    version: '4.43.7',
    date: '2026-02-05',
    changes: [
      '🔧 Single game: "במשחק היחיד"',
      '🔢 Whole numbers only',
      '📈 Trend must show comparison',
    ],
  },
  {
    version: '4.43.6',
    date: '2026-02-05',
    changes: [
      '🎨 7 different opening patterns',
      '🎲 Temperature 0.6 → 0.85',
      '✅ Positive prompt instructions',
    ],
  },
  {
    version: '4.43.5',
    date: '2026-02-05',
    changes: [
      '🔧 Use GLOBAL half-year ranking',
      '✅ Among all active players',
      '✅ Shows total active count',
      '✅ Falls back to tonight\'s players',
    ],
  },
  {
    version: '4.43.4',
    date: '2026-02-05',
    changes: [
      '🔧 Use current period (H1/H2)',
      '✅ Falls back to previous half',
      '✅ Period label per player',
      '✅ Marks "(מתקופה קודמת)"',
    ],
  },
  {
    version: '4.43.3',
    date: '2026-02-05',
    changes: [
      '🔧 "Recent" = current year',
      '✅ AI uses 2026 only',
      '✅ Player data: full year',
      '✅ Suggestion uses current year',
    ],
  },
  {
    version: '4.43.2',
    date: '2026-02-05',
    changes: [
      '📊 Forecast: ±50-150₪ typical',
      '✅ Amplified 2.5x',
      '✅ Min ±25₪',
      '🎲 Surprise: bad history + good form',
      '✅ Surprise = positive prediction',
    ],
  },
  {
    version: '4.43.0',
    date: '2026-02-05',
    changes: [
      '🔄 Complete prompt rewrite — Hebrew-first',
      '📈 Trend analysis prioritized',
      '✅ Concise Hebrew player data',
      '✅ Clear tone-matching rules',
      '✅ "השחקנים" not "הלילה"',
      '❌ Removed redundant rules',
    ],
  },
  {
    version: '4.42.5',
    date: '2026-02-05',
    changes: [
      '📈 Added trend analysis',
      '✅ IMPROVING / DECLINING flags',
      '✅ Recent + all-time avg',
      '✅ AI mentions trend contrasts',
    ],
  },
  {
    version: '4.42.4',
    date: '2026-02-05',
    changes: [
      '🔧 Enforced 3-way alignment',
      '✅ Explicit alignment table',
      '✅ Forbidden combinations',
      '✅ Surprise must be positive',
      '✅ Verification checklist',
    ],
  },
  {
    version: '4.42.3',
    date: '2026-02-05',
    changes: [
      '🔧 Restored critical prompt rules',
      '✅ "Don\'t mention profit" restored',
      '✅ Tone/profit correlation',
      '✅ Current ranking emphasized',
      '✅ Cleaner data hierarchy',
      '❌ No more big-loss highlights',
    ],
  },
  {
    version: '4.42.2',
    date: '2026-02-05',
    changes: [
      '✅ Comeback players mentioned',
      'Prompt 60% shorter',
      'Player data more compact',
    ],
  },
  {
    version: '4.41.5',
    date: '2026-02-05',
    changes: [
      '✅ "/משחק" → "למשחק" (grammar)',
      'Applied to all milestone descriptions',
    ],
  },
  {
    version: '4.41.4',
    date: '2026-02-05',
    changes: [
      '✅ Fixed "2026 מתחילה" timing',
      'Only in January with 0-1 games',
      'Added "Early Year Leader"',
    ],
  },
  {
    version: '4.41.3',
    date: '2026-02-05',
    changes: [
      '✅ Forecast tone matches prediction',
      '✅ Milestone deduplication',
      'Strengthened tone alignment',
    ],
  },
  {
    version: '4.41.2',
    date: '2026-02-05',
    changes: [
      '✅ Fixed Vercel cache for mobile',
      'Cache-busting headers',
    ],
  },
  {
    version: '4.41.1',
    date: '2026-02-05',
    changes: [
      '✅ Milestone rounding fix',
      'Added validation scripts',
      '49 tests passing',
    ],
  },
  {
    version: '4.41.0',
    date: '2026-02-05',
    changes: [
      '✅ Major AI forecast improvements',
      '✅ 7 milestone categories',
      'Smart deduplication',
      'GlobalRankingContext',
      'Punchy Hebrew titles',
    ],
  },
  {
    version: '4.40.46',
    date: '2026-01-19',
    changes: [
      '✅ Hall of Fame matches Season Podium',
      'Single calculation for current year',
    ],
  },
  {
    version: '4.40.45',
    date: '2026-01-19',
    changes: [
      '✅ Season Podium: all player types',
      'Both rank by profit only',
    ],
  },
  {
    version: '4.40.44',
    date: '2026-01-19',
    changes: [
      '✅ Reverted v4.40.43',
      'HoF = all players, Podium = permanent',
      'Real fix: data loading + name updates',
    ],
  },
  {
    version: '4.40.42',
    date: '2026-01-19',
    changes: [
      '✅ Initial data load + storage listener',
      'Fixed empty players on first render',
      'Fixed missing sync listener',
    ],
  },
  {
    version: '4.40.41',
    date: '2026-01-19',
    changes: [
      '✅ HoF uses player STATE',
      'Fixed stale storage fetch',
    ],
  },
  {
    version: '4.40.40',
    date: '2026-01-19',
    changes: [
      '✅ HoF recalculates on data change',
      'useMemo depends on players state',
    ],
  },
  {
    version: '4.40.39',
    date: '2026-01-19',
    changes: [
      '🔍 Debug logging added',
      'Identified stale useMemo cache',
    ],
  },
  {
    version: '4.40.38',
    date: '2026-01-19',
    changes: [
      '🔍 Debug player database state',
    ],
  },
  {
    version: '4.40.37',
    date: '2026-01-19',
    changes: [
      '🐛 Debug HoF name issue',
    ],
  },
  {
    version: '4.40.36',
    date: '2026-01-19',
    changes: [
      '🔧 Fixed Season Podium names',
      '📊 Fixed Biggest Wins names',
      'Always use current names',
    ],
  },
  {
    version: '4.40.35',
    date: '2026-01-19',
    changes: [
      '🏆 HoF: current names not historical',
      'All years affected',
    ],
  },
  {
    version: '4.40.34',
    date: '2026-01-19',
    changes: [
      '✨ Unified Leaders section format',
      '🔧 Best Avg/Game sign handling',
    ],
  },
  {
    version: '4.40.33',
    date: '2026-01-19',
    changes: [
      '📊 Records align with filters',
      'No min-games on win rate',
      'No min-games on average profit',
      'Buyin King: "רכישות"',
    ],
  },
  {
    version: '4.40.32',
    date: '2026-01-05',
    changes: [
      '🔊 Voice on Undo rebuy',
      'Hebrew announcement',
      'Same voice as rebuys',
    ],
  },
  {
    version: '4.40.31',
    date: '2026-01-05',
    changes: [
      '👋 Remove player after game starts',
      'Click ✕ before they rebuy',
      'Admin only with confirmation',
    ],
  },
  {
    version: '4.40.30',
    date: '2026-01-04',
    changes: [
      '🧹 Milestone deduplication',
      'Max 2 per player',
      'Each theme once',
      'Reduced 10 → 8 milestones',
    ],
  },
  {
    version: '4.40.29',
    date: '2026-01-04',
    changes: [
      '🗑️ Removed chatbot feature',
    ],
  },
  {
    version: '4.40.26',
    date: '2026-01-04',
    changes: [
      '🌟 Dramatic milestones',
      '"מהפסיד למנצח" / "מנצח לנפגע"',
      '"מלחמת הרצפים"',
      '"הרים רוסיים" / "המקום האחרון עולה"',
      '2025 champion fades after week 2',
    ],
  },
  {
    version: '4.40.25',
    date: '2026-01-04',
    changes: [
      '🤖 Enhanced poker chatbot',
      '⚔️ Head-to-head + nemesis + victim',
      '📈 Trends + location + volatility',
      '🔮 Predictions + follow-ups',
      '30+ new patterns',
    ],
  },
  {
    version: '4.40.24',
    date: '2026-01-04',
    changes: [
      '🔥 Streaks span across years',
      'Forecasts use true streak',
      'Cross-year reporting',
    ],
  },
  {
    version: '4.40.23',
    date: '2026-01-04',
    changes: [
      '📅 Date-based chatbot questions',
      'Hebrew & English month names',
      'Auto-filters games by range',
    ],
  },
  {
    version: '4.40.22',
    date: '2026-01-04',
    changes: [
      '💬 Smarter chatbot fallback',
      '10+ new question patterns',
      '"עזרה" / "סיכום" support',
    ],
  },
  {
    version: '4.40.21',
    date: '2026-01-04',
    changes: [
      '🔍 Forecast fact-checking',
      'Auto-corrects wrong streaks',
      'Auto-corrects game counts',
      'Logs corrections',
    ],
  },
  {
    version: '4.40.20',
    date: '2026-01-04',
    changes: [
      '💬 Bulletproof chatbot',
      '20+ local question types',
      'Graceful AI fallback',
      'Better timeout handling',
    ],
  },
  {
    version: '4.40.19',
    date: '2026-01-04',
    changes: [
      '🎯 Dynamic milestones',
      'Last Game Hero / Comeback / Form',
      'Monthly position changes',
      'Removed static "Consistency King"',
    ],
  },
  {
    version: '4.40.18',
    date: '2026-01-04',
    changes: [
      '🎯 Better insights for low data',
      '3 unique sentences per player',
      'Dramatic narratives',
      'Hebrew variety + humor',
    ],
  },
  {
    version: '4.40.17',
    date: '2026-01-04',
    changes: [
      '🤖 Chatbot rewrite: full NLU',
      'AI sees all your data',
      'Hebrew or English input',
      'New purple chat UI',
    ],
  },
  {
    version: '4.40.16',
    date: '2026-01-04',
    changes: [
      '💬 Chat as floating button',
      'Cleaner navigation: 5 icons',
      '🔧 Chatbot now actually works',
      'Hebrew Q&A support',
    ],
  },
  {
    version: '4.40.15',
    date: '2026-01-04',
    changes: [
      '🔧 Nav bar: 6 icons fit',
      'Smaller icons + text',
    ],
  },
  {
    version: '4.40.14',
    date: '2026-01-21',
    changes: [
      '🐛 Fix profile sentences for low data',
      'Simple statements for 1-2 games',
      'Complex analysis: 5+ games only',
    ],
  },
  {
    version: '4.40.13',
    date: '2026-01-21',
    changes: [
      '💬 New: AI Chatbot',
      'Natural-language questions',
      'Local-first, AI-enhanced',
      'Smart fallback',
    ],
  },
  {
    version: '4.40.12',
    date: '2026-01-04',
    changes: [
      '🎯 Recent insights focus',
      'Removed repetitive consistency',
      'Reduced routine "leader" text',
      'Recent form milestone',
      'Pattern-breaking milestone',
      'Active streaks only',
    ],
  },
  {
    version: '4.40.11',
    date: '2026-01-04',
    changes: [
      '🎯 Use actual overall rankings',
      'Adjacent-only "can pass"',
      'Podium + close battles fixed',
    ],
  },
  {
    version: '4.40.10',
    date: '2026-01-04',
    changes: [
      '🤖 Fix streaks for current year',
      'No false 2-game streaks',
      'All-time still shown separately',
    ],
  },
  {
    version: '4.40.9',
    date: '2026-01-04',
    changes: [
      '👤 Profiles work with 1-2 games',
      'Style classification with single game',
      'Sentences focus on available data',
    ],
  },
  {
    version: '4.40.8',
    date: '2026-01-04',
    changes: [
      '🔧 Break-even (0) breaks streaks',
      'Consistent across all views',
    ],
  },
  {
    version: '4.40.7',
    date: '2026-01-04',
    changes: [
      '🎯 Milestones for 1-2 games',
      'Lower thresholds',
      'Simple 1-game milestones',
    ],
  },
  {
    version: '4.40.6',
    date: '2026-01-04',
    changes: [
      '🎯 Variety in consistency text',
      '5 description variations',
      'Stable but unique per player',
    ],
  },
  {
    version: '4.40.5',
    date: '2026-01-04',
    changes: [
      '🤖 No redundant profit numbers',
      'Focus on stats + storylines',
    ],
  },
  {
    version: '4.40.4',
    date: '2026-01-04',
    changes: [
      '📊 Graphs filters match Stats',
      'Same time period UI',
      'Same player filter behavior',
    ],
  },
  {
    version: '4.40.3',
    date: '2026-01-04',
    changes: [
      '🔧 Fixed Vercel build error',
      'Removed extra closing tag',
    ],
  },
  {
    version: '4.40.2',
    date: '2026-01-04',
    changes: [
      '📊 Removed redundant type filter',
      'Cleaner filter interface',
    ],
  },
  {
    version: '4.40.1',
    date: '2026-01-04',
    changes: [
      '📊 Filters always visible',
      'Helpful Hebrew empty state',
    ],
  },
  {
    version: '4.40.0',
    date: '2025-12-28',
    changes: [
      '🔄 New MemberSync role (PIN 0852)',
      'Auto cloud sync on game end',
    ],
  },
  {
    version: '4.39.12',
    date: '2025-12-28',
    changes: [
      '🍕 Compact shared expenses box',
    ],
  },
  {
    version: '4.39.11',
    date: '2025-12-28',
    changes: [
      '🍕 Full expense details in settlement',
    ],
  },
  {
    version: '4.39.10',
    date: '2025-12-28',
    changes: [
      '🍕 Pizza icons legend',
    ],
  },
  {
    version: '4.39.9',
    date: '2025-12-28',
    changes: [
      '🍕 Show payer + eater names',
    ],
  },
  {
    version: '4.39.8',
    date: '2025-12-28',
    changes: [
      '🍕 Compact expense modal',
    ],
  },
  {
    version: '4.39.7',
    date: '2025-12-28',
    changes: [
      '📊 Past tense for completed periods',
      'Skip speculative milestones',
    ],
  },
  {
    version: '4.39.6',
    date: '2025-12-28',
    changes: [
      '🍕 Pizza icons by name',
    ],
  },
  {
    version: '4.39.5',
    date: '2025-12-28',
    changes: [
      '🔀 Combined poker + expense settlements',
      'Fewer transfers between players',
    ],
  },
  {
    version: '4.39.4',
    date: '2025-12-28',
    changes: [
      '✏️ Edit existing expenses',
    ],
  },
  {
    version: '4.39.3',
    date: '2025-12-28',
    changes: [
      '🔙 Comeback after absence indicator',
      '30/60/90+ days',
    ],
  },
  {
    version: '4.39.2',
    date: '2025-12-28',
    changes: [
      '🍕 Default expense: "פיצה"',
    ],
  },
  {
    version: '4.39.1',
    date: '2025-12-28',
    changes: [
      '🔧 Forecast: explicit last-game result',
      'Strong anti-invention warnings',
    ],
  },
  {
    version: '4.39.0',
    date: '2025-12-28',
    changes: [
      '🍕 New: Shared Expenses',
      'Track food/pizza purchases',
      'Split equally among participants',
      'Separate from poker P&L',
    ],
  },
  {
    version: '4.38.22',
    date: '2025-12-28',
    changes: [
      '📅 Focus on year/half, not all-time',
      'Streak of 1 → "won/lost last"',
      'All-time only for milestones',
    ],
  },
  {
    version: '4.38.21',
    date: '2025-12-28',
    changes: [
      '🎲 Pre-select surprise candidates',
      'TL;DR with 5 key rules',
    ],
  },
  {
    version: '4.38.20',
    date: '2025-12-28',
    changes: [
      '🧹 Removed redundant prompt sections',
      '~20% shorter prompt',
    ],
  },
  {
    version: '4.38.19',
    date: '2025-12-28',
    changes: [
      '🎲 Mandatory surprise requirement',
      'Max 35% surprise rate',
    ],
  },
  {
    version: '4.38.18',
    date: '2025-12-28',
    changes: [
      '🤖 Suggested expected profit',
      '70% recent + 30% overall',
      'Recent form section',
      'Temperature 0.6',
    ],
  },
  {
    version: '4.38.17',
    date: '2025-12-28',
    changes: [
      '🎯 Reduced random variance',
      '70/30 recent/overall',
      'Stronger streak modifiers',
      'Surprise rate 25 → 35%',
    ],
  },
  {
    version: '4.38.16',
    date: '2025-12-28',
    changes: [
      '🎙️ Quick rebuy: only quick message',
    ],
  },
  {
    version: '4.38.15',
    date: '2025-12-28',
    changes: [
      '📍 Location next to date in History',
    ],
  },
  {
    version: '4.38.14',
    date: '2025-12-28',
    changes: [
      '🎙️ Hebrew feminine number forms',
      '🔊 AudioContext resume fix',
    ],
  },
  {
    version: '4.38.13',
    date: '2025-12-28',
    changes: [
      '📍 Location mandatory',
      '📍 Shown in History cards',
    ],
  },
  {
    version: '4.38.12',
    date: '2025-12-28',
    changes: [
      '🎙️ More rebuy sentences',
    ],
  },
  {
    version: '4.38.11',
    date: '2025-12-28',
    changes: [
      '🎙️ Updated quick rebuy lines',
    ],
  },
  {
    version: '4.38.10',
    date: '2025-12-28',
    changes: [
      'HoF: includes all active player types',
      'Activity = 20% of period games',
    ],
  },
  {
    version: '4.38.9',
    date: '2025-12-28',
    changes: [
      'HoF: only permanent players',
    ],
  },
  {
    version: '4.38.8',
    date: '2025-12-28',
    changes: [
      '🐛 HoF + Podium: current names',
    ],
  },
  {
    version: '4.38.7',
    date: '2025-12-28',
    changes: [
      '🎙️ Gender-neutral rebuy lines',
      'Better Hebrew pronunciation',
      'Female voice settings',
    ],
  },
  {
    version: '4.38.6',
    date: '2025-12-28',
    changes: [
      'Removed + signs on Podium / HoF',
    ],
  },
  {
    version: '4.38.5',
    date: '2025-12-28',
    changes: [
      '🏅 HoF: all players, top performers',
      'Min 20% / 3 games',
    ],
  },
  {
    version: '4.38.4',
    date: '2025-12-28',
    changes: [
      '🥇🥈🥉 HoF: top 3 per period',
      'Player + profit per place',
    ],
  },
  {
    version: '4.38.3',
    date: '2025-12-28',
    changes: [
      '📤 HoF: screenshot share',
    ],
  },
  {
    version: '4.38.2',
    date: '2025-12-28',
    changes: [
      'HoF includes current year',
      'Auto-adds new years',
    ],
  },
  {
    version: '4.38.1',
    date: '2025-12-28',
    changes: [
      '🏅 New: Hall of Fame',
      'H1, H2, Yearly winners',
      'Years 2021 to present',
    ],
  },
  {
    version: '4.38.0',
    date: '2025-12-28',
    changes: [
      '🏆 New: Season Podium (top 3)',
      'Independent of filters',
      'Share as screenshot',
    ],
  },
  {
    version: '4.37.11',
    date: '2025-12-25',
    changes: [
      'UI: last 6 games are actually latest',
    ],
  },
  {
    version: '4.37.10',
    date: '2025-12-25',
    changes: [
      '🐛 Player games modal: ALL games',
      '🐛 Hide rebuy data for All Time',
    ],
  },
  {
    version: '4.37.9',
    date: '2025-12-25',
    changes: [
      '🐛 Insights shows ALL players',
    ],
  },
  {
    version: '4.37.8',
    date: '2025-12-25',
    changes: [
      '🐛 Double-minus fix in milestones',
      '🐛 "participations" not "games"',
    ],
  },
  {
    version: '4.37.7',
    date: '2025-12-25',
    changes: [
      'UI: menu cards fit container',
    ],
  },
  {
    version: '4.37.6',
    date: '2025-12-25',
    changes: [
      '🐛 Dedup duplicate milestones',
    ],
  },
  {
    version: '4.37.5',
    date: '2025-12-25',
    changes: [
      'UI: limit player stats to 6 games',
    ],
  },
  {
    version: '4.37.4',
    date: '2025-12-25',
    changes: [
      'UI: aligned menu card sizes',
    ],
  },
  {
    version: '4.37.3',
    date: '2025-12-25',
    changes: [
      '🐛 Null safety for empty player list',
    ],
  },
  {
    version: '4.37.2',
    date: '2025-12-25',
    changes: [
      '🐛 biggestLoss sign fix',
      '🐛 Comeback King logic fix',
      '🐛 Volatility / sentence formatting',
      '🐛 Array mutation fix',
    ],
  },
  {
    version: '4.37.1',
    date: '2025-12-25',
    changes: [
      '🐛 Build error: duplicate variable',
    ],
  },
  {
    version: '4.37.0',
    date: '2025-12-25',
    changes: [
      '🏷️ Player styles rewritten',
      'New labels: רווחי, מפסיד, חם, קר…',
      'Streak-based styles take priority',
      'Clearer per-style meaning',
    ],
  },
  {
    version: '4.36.0',
    date: '2025-12-25',
    changes: [
      '🎯 8 new milestone types (20 total)',
      'Win rate, biggest loser, volatility, …',
      'Top 8 by priority shown',
    ],
  },
  {
    version: '4.35.0',
    date: '2025-12-25',
    changes: [
      '🏆 Year/half-year championship titles',
      '"אלוף 2025?" / "אלוף H2?"',
      'Dramatic questions',
      '"מרדף על מקום 2"',
    ],
  },
  {
    version: '4.34.0',
    date: '2025-12-25',
    changes: [
      '🔧 Rebuy data: 2026+ only',
      '🎯 Realistic milestone gaps',
      'Max 80₪ "can pass" gap',
    ],
  },
  {
    version: '4.33.0',
    date: '2025-12-25',
    changes: [
      '🎨 Player styles: multi-factor classification',
      '📝 60+ unique sentences in 12 categories',
      'Variety per view',
    ],
  },
  {
    version: '4.32.0',
    date: '2025-12-25',
    changes: [
      '🎯 Creative milestone variety',
      '👤 Profiles: flowing narrative',
      '2-3 sentences per player',
    ],
  },
  {
    version: '4.31.4',
    date: '2025-12-25',
    changes: [
      '🐛 No duplicate milestones',
      'One best candidate per category',
    ],
  },
  {
    version: '4.31.3',
    date: '2025-12-25',
    changes: [
      '🐛 Lose streak duplicates removed',
      'Section 12 only for -2 streaks',
    ],
  },
  {
    version: '4.31.2',
    date: '2025-12-25',
    changes: [
      '🧪 25 tests across 8 categories',
      'Duplicate prevention + integrity',
    ],
  },
  {
    version: '4.31.1',
    date: '2025-12-25',
    changes: [
      '🐛 Record-chase duplicates fixed',
      'No 0-win players in record chase',
    ],
  },
  {
    version: '4.31.0',
    date: '2025-12-25',
    changes: [
      '🎯 New: Insights tab in Statistics',
      'Player profiles + suggestions',
      'All filters apply',
    ],
  },
  {
    version: '4.30.0',
    date: '2025-12-25',
    changes: [
      '🎆 "Fresh Start" milestones',
      'Year/half kickoff',
      'Graceful empty handling',
    ],
  },
  {
    version: '4.29.0',
    date: '2025-12-25',
    changes: [
      '🗓️ Year transition handling',
      '🏆 "2025 Final Results" in January',
      '🥈🥉 2nd / 3rd shown',
      '📊 H1 finals in July',
    ],
  },
  {
    version: '4.28.0',
    date: '2025-12-25',
    changes: [
      '📊 H2 tracking milestones',
      '🏆 December year-end specials',
      '⏰ "Last chance for 2025"',
      '🎢 Volatility alerts',
      '👑 Half-year leader highlights',
    ],
  },
  {
    version: '4.27.0',
    date: '2025-12-25',
    changes: [
      '🧪 20+ tests across 6 categories',
      '🐛 Forecast date format DD/MM/YYYY',
      'Per-player verification helper',
    ],
  },
  {
    version: '4.26.0',
    date: '2025-12-25',
    changes: [
      '🐛 Full game history (was 6 games)',
      'Wrong year-profit fixed',
      'Date parser: dot/slash/ISO',
    ],
  },
  {
    version: '4.25.0',
    date: '2025-12-25',
    changes: [
      '🐛 Date format mismatch fix',
      'Year-table milestones: 5+ games',
    ],
  },
  {
    version: '4.24.1',
    date: '2025-12-25',
    changes: [
      '🔍 Year-profit logging',
      'Year-table: 5+ games required',
    ],
  },
  {
    version: '4.24.0',
    date: '2025-12-25',
    changes: [
      '🎨 Mandatory sentence variety',
      'Banned "במקום ה-X" opener',
      '7 distinct opening patterns',
    ],
  },
  {
    version: '4.23.1',
    date: '2025-12-25',
    changes: [
      '🎯 No invented positive facts',
      '7-10 interesting milestones',
      'Priority 50+ only',
    ],
  },
  {
    version: '4.23.0',
    date: '2025-12-25',
    changes: [
      '🚨 Critical accuracy rewrite',
      'Year stats per player',
      'Explicit RANK field',
      'Verification checklist',
    ],
  },
  {
    version: '4.22.0',
    date: '2025-12-25',
    changes: [
      '📸 Milestones split: 5 per page',
      '🎯 No false record claims',
      'Personal best records added',
      '10 milestones guaranteed',
    ],
  },
  {
    version: '4.21.1',
    date: '2025-12-25',
    changes: [
      '🚨 Every number needs context',
      'Specify which table',
      'No vague references',
    ],
  },
  {
    version: '4.21.0',
    date: '2025-12-25',
    changes: [
      '📝 Longer milestone descriptions',
      'Specify which table',
      'Explain why it matters',
    ],
  },
  {
    version: '4.20.4',
    date: '2025-12-25',
    changes: [
      '🔤 RTL Hebrew alignment',
      '🔢 Whole numbers only',
      '🎯 Always 10 milestones',
    ],
  },
  {
    version: '4.20.3',
    date: '2025-12-25',
    changes: [
      '📝 No need to repeat profit number',
      'Focus on the story',
    ],
  },
  {
    version: '4.20.2',
    date: '2025-12-25',
    changes: [
      '🔢 Number must equal expectedProfit',
      'Optional sentence without number',
    ],
  },
  {
    version: '4.20.1',
    date: '2025-12-25',
    changes: [
      '🔗 Sentence must match expectedProfit',
      'Tone correlates with prediction',
    ],
  },
  {
    version: '4.20.0',
    date: '2025-12-25',
    changes: [
      '🎯 New: Milestones button',
      'Top 7-10 highlights',
      'WhatsApp screenshot share',
    ],
  },
  {
    version: '4.19.1',
    date: '2025-12-25',
    changes: [
      '🎯 10 more milestone types',
      'Win rate, close battles, jumps',
      'Recovery, monthly counts',
    ],
  },
  {
    version: '4.19.0',
    date: '2025-12-25',
    changes: [
      '🎯 Multi-timeframe milestones',
      'Year + Half + Monthly',
      'All clearly labeled',
    ],
  },
  {
    version: '4.18.2',
    date: '2025-12-25',
    changes: [
      '📊 Explicit "ALL-TIME" labels',
      'Current rank + amounts',
    ],
  },
  {
    version: '4.18.1',
    date: '2025-12-25',
    changes: [
      '🎰 20 random rebuy sounds',
    ],
  },
  {
    version: '4.18.0',
    date: '2025-12-25',
    changes: [
      '🎯 New: Records at Stake',
      'Leaderboard passing hints',
      'Streak / round-number alerts',
    ],
  },
  {
    version: '4.17.2',
    date: '2025-12-25',
    changes: [
      '📊 Show AI actual game stats',
      '📋 Recent example games',
      '✅ Hard profit constraints',
    ],
  },
  {
    version: '4.17.1',
    date: '2025-12-25',
    changes: [
      '🎯 Realistic profit ranges',
      '💚 Special handling for Tomer',
      '🚫 Stronger anti-repetition',
    ],
  },
  {
    version: '4.17.0',
    date: '2025-12-25',
    changes: [
      '🤖 Forecast v3.0: Legacy Factor',
      'All-time records included',
      'Nemesis angle',
      'Hebrew output, English reasoning',
    ],
  },
  {
    version: '4.16.24',
    date: '2025-12-22',
    changes: [
      'Fix: Statistics blank screen',
    ],
  },
  {
    version: '4.16.23',
    date: '2025-12-22',
    changes: [
      'Top 20 Wins: filtered by period',
    ],
  },
  {
    version: '4.16.22',
    date: '2025-12-22',
    changes: [
      'Graphs: removed emoji from title',
    ],
  },
  {
    version: '4.16.21',
    date: '2025-12-22',
    changes: [
      'Stats: compact sort + Gain/Loss',
    ],
  },
  {
    version: '4.16.20',
    date: '2025-12-22',
    changes: [
      'Stats: sort dropdown',
    ],
  },
  {
    version: '4.16.19',
    date: '2025-12-22',
    changes: [
      'Stats: cycling sort button',
    ],
  },
  {
    version: '4.16.18',
    date: '2025-12-21',
    changes: [
      'Voice: reverted quick rebuy',
    ],
  },
  {
    version: '4.16.17',
    date: '2025-12-21',
    changes: [
      'Voice: simplified quick rebuy',
    ],
  },
  {
    version: '4.16.16',
    date: '2025-12-21',
    changes: [
      'Voice: updated rebuy sentences',
    ],
  },
  {
    version: '4.16.15',
    date: '2025-12-21',
    changes: [
      'Graphs accessible to admin + member',
    ],
  },
  {
    version: '4.16.14',
    date: '2025-12-21',
    changes: [
      'H2H: big-win/loss threshold ₪150',
    ],
  },
  {
    version: '4.16.13',
    date: '2025-12-21',
    changes: [
      'Voice: 1st + 3rd rebuy fixes',
    ],
  },
  {
    version: '4.16.12',
    date: '2025-12-21',
    changes: [
      'Voice: natural Hebrew sentences',
    ],
  },
  {
    version: '4.16.11',
    date: '2025-12-21',
    changes: [
      'H2H: play-style legend',
    ],
  },
  {
    version: '4.16.10',
    date: '2025-12-21',
    changes: [
      'Voice: quick rebuy = 5 min',
    ],
  },
  {
    version: '4.16.9',
    date: '2025-12-21',
    changes: [
      'Voice: based on rebuy count',
      'First rebuy = first message',
      'Shorter Hebrew sentences',
    ],
  },
  {
    version: '4.16.8',
    date: '2025-12-21',
    changes: [
      'Fix: Graphs blank screen',
    ],
  },
  {
    version: '4.16.7',
    date: '2025-12-21',
    changes: [
      'Sound: ching-ching coin',
      'Display: 1.5 / 2.5 rebuys',
      'Voice: "קנה אחד" for 1',
    ],
  },
  {
    version: '4.16.6',
    date: '2025-12-21',
    changes: [
      'Fix: H2H blank screen',
      '🔥 Streaks & recent form',
    ],
  },
  {
    version: '4.16.5',
    date: '2025-12-21',
    changes: [
      'Voice: "קָנָה" with niqqud',
      '0.5 counter fix',
    ],
  },
  {
    version: '4.16.4',
    date: '2025-12-21',
    changes: [
      'H2H: direct battles + recent form',
      'Play style + volatility',
    ],
  },
  {
    version: '4.16.3',
    date: '2025-12-21',
    changes: [
      'Voice: cash-drawer sound',
      '"קנה" → "נכנס"',
      'Hebrew totals, lower pitch',
    ],
  },
  {
    version: '4.16.2',
    date: '2025-12-21',
    changes: [
      'Voice: "קנה חצי" works',
      '3 cash-register variations',
      'Hebrew totals',
    ],
  },
  {
    version: '4.16.1',
    date: '2025-12-21',
    changes: [
      'New: Monthly Profit bar chart',
      'Best/Worst/Average month stats',
    ],
  },
  {
    version: '4.16.0',
    date: '2025-12-21',
    changes: [
      'New: Month filter in Stats + Graphs',
    ],
  },
  {
    version: '4.15.1',
    date: '2025-12-21',
    changes: [
      'Sync: only completed games upload',
      'Removed 7 stale incomplete games',
    ],
  },
  {
    version: '4.15.0',
    date: '2025-12-21',
    changes: [
      '🤖 Forecast v2.0: prompt rewrite',
      'Player archetypes',
      'Emotional hooks',
      'Lower temperature 0.75',
    ],
  },
  {
    version: '4.14.4',
    date: '2025-12-21',
    changes: [
      'H2H: shared games / total',
    ],
  },
  {
    version: '4.14.3',
    date: '2025-12-21',
    changes: [
      'Graphs: removed tooltip',
    ],
  },
  {
    version: '4.14.2',
    date: '2025-12-21',
    changes: [
      'Graphs: tooltip in panel below',
    ],
  },
  {
    version: '4.14.1',
    date: '2025-12-21',
    changes: [
      'Graphs: removed Race chart',
      'Period filter + colored legend',
    ],
  },
  {
    version: '4.14.0',
    date: '2025-12-21',
    changes: [
      '🔄 New: resume interrupted games',
      'Auto-save during chip entry',
      'Optional abandon flow',
    ],
  },
  {
    version: '4.13.3',
    date: '2025-12-21',
    changes: [
      '💸 No more tiny transfers',
      'All transfers ≥ minTransfer',
    ],
  },
  {
    version: '4.13.0',
    date: '2025-12-21',
    changes: [
      '🔮 Forecast flow redesigned',
      'Forecast in New Game only',
      'Mismatch dialog on roster change',
      'Comparison at game end',
    ],
  },
  {
    version: '4.11.9',
    date: '2025-12-18',
    changes: [
      'New: Top 20 Single Night Wins',
      'Clickable rows + share button',
    ],
  },
  {
    version: '4.11.8',
    date: '2025-12-18',
    changes: [
      'Live game forecast: split sharing',
    ],
  },
  {
    version: '4.11.6',
    date: '2025-12-18',
    changes: [
      'Forecast vs Reality: compact table',
      'AI summary always visible',
    ],
  },
  {
    version: '4.11.5',
    date: '2025-12-18',
    changes: [
      'Player stats: 6 games (was 15)',
    ],
  },
  {
    version: '4.11.4',
    date: '2025-12-18',
    changes: [
      'Chip count: name in numpad header',
      'No auto-open',
    ],
  },
  {
    version: '4.11.3',
    date: '2025-12-18',
    changes: [
      'Forecast: polished prompt',
      'Sentence 25-35 words',
      'Unique story per player',
    ],
  },
  {
    version: '4.11.2',
    date: '2025-12-18',
    changes: [
      'Forecast comparison: rating system',
      'Accurate=2 / Close=1 / Missed=0',
      'Levels: מעולה / טוב / סביר / חלש',
    ],
  },
  {
    version: '4.11.1',
    date: '2025-12-18',
    changes: [
      'Chip count: user-controlled flow',
      'Auto-advance through chip colors',
    ],
  },
  {
    version: '4.11.0',
    date: '2025-12-18',
    changes: [
      'Forecast comparison: gap-based',
      '✓ ≤30 / ~ 31-60 / ✗ >60',
      'Legend + admin-only forecast button',
    ],
  },
  {
    version: '4.10.8',
    date: '2025-12-18',
    changes: [
      'Forecast: balanced prompt',
      'Historical-average expected profit',
      'Highlights with specific numbers',
    ],
  },
  {
    version: '4.10.7',
    date: '2025-12-18',
    changes: [
      'Forecast button: admin only',
    ],
  },
  {
    version: '4.10.6',
    date: '2025-12-18',
    changes: [
      'New: forecast from Live Game',
      'Save + share via WhatsApp',
    ],
  },
  {
    version: '4.10.5',
    date: '2025-12-18',
    changes: [
      'Share forecast on game start',
      'Forecast in result screenshots',
      'AI accuracy comment',
    ],
  },
  {
    version: '4.10.4',
    date: '2025-12-18',
    changes: [
      'New: Forecast vs Reality at end',
      'AI accuracy comment',
      'Direction accuracy ✓/✗',
    ],
  },
  {
    version: '4.10.3',
    date: '2025-12-18',
    changes: [
      'Forecast: smarter prompt',
      'Unique highlight per player',
      'Shorter, punchier sentences',
    ],
  },
  {
    version: '4.10.2',
    date: '2025-12-18',
    changes: [
      'Forecast screenshot: sort fix',
      'Minus signs shown',
    ],
  },
  {
    version: '4.10.1',
    date: '2025-12-18',
    changes: [
      'Forecast: rate-limit countdown',
      'Static fallback option',
    ],
  },
  {
    version: '4.10.0',
    date: '2025-12-18',
    changes: [
      'Forecast: player dynamics analysis',
      '15 games of history',
      'Rivalry detection',
    ],
  },
  {
    version: '4.9.9',
    date: '2025-12-18',
    changes: [
      'Forecast: more variety per run',
      'Random seed + timestamp',
    ],
  },
  {
    version: '4.9.8',
    date: '2025-12-18',
    changes: [
      'Data fix: corrected player types',
      'Synced via cloud',
    ],
  },
  {
    version: '4.9.7',
    date: '2025-12-18',
    changes: [
      'Forecast: sorted by expected profit',
    ],
  },
  {
    version: '4.9.6',
    date: '2025-12-18',
    changes: [
      'Forecast: split into screenshots',
      '5 players per page',
    ],
  },
  {
    version: '4.9.4',
    date: '2025-12-18',
    changes: [
      'UI: aligned medal positions',
    ],
  },
  {
    version: '4.9.2',
    date: '2025-12-18',
    changes: [
      'Voice: prefer female English voices',
    ],
  },
  {
    version: '4.9.1',
    date: '2025-12-18',
    changes: [
      'Voice: better English voice selection',
    ],
  },
  {
    version: '4.9.0',
    date: '2024-12-18',
    changes: [
      'Forecast: API diagnostic rewrite',
      'Lists available models first',
    ],
  },
  {
    version: '4.8.11',
    date: '2025-12-18',
    changes: [
      'Voice: Hebrew name + English action',
    ],
  },
  {
    version: '4.8.10',
    date: '2025-12-18',
    changes: [
      'Voice: alert chime before name',
    ],
  },
  {
    version: '4.8.9',
    date: '2024-12-18',
    changes: [
      'Forecast: auto-detect Gemini model',
      'Saves working model',
    ],
  },
  {
    version: '4.8.8',
    date: '2025-12-18',
    changes: [
      'Voice: Hebrew "קנה" / "קנה חצי"',
    ],
  },
  {
    version: '4.8.7',
    date: '2025-12-18',
    changes: [
      'New: voice announcement for buyins',
    ],
  },
  {
    version: '4.8.6',
    date: '2024-12-18',
    changes: [
      'Fix: AI model endpoint',
    ],
  },
  {
    version: '4.8.5',
    date: '2024-12-18',
    changes: [
      'Forecast: dynamic profit range',
      'Based on player history',
    ],
  },
  {
    version: '4.8.4',
    date: '2024-12-18',
    changes: [
      'Forecast: better prompt rules',
      'Highlight explains the reason',
      'Recent games weighted more',
    ],
  },
  {
    version: '4.8.3',
    date: '2025-12-18',
    changes: [
      'Screenshot: vertical layout',
      'Share sends 2 images',
    ],
  },
  {
    version: '4.8.2',
    date: '2024-12-18',
    changes: [
      'Forecast: API key test fixed',
      'Full game history per player',
    ],
  },
  {
    version: '4.8.1',
    date: '2025-12-18',
    changes: [
      'Screenshot: 2-column layout',
    ],
  },
  {
    version: '4.8.0',
    date: '2024-12-18',
    changes: [
      'New: AI-Powered Forecasts',
      'Uses Google Gemini',
      'Sarcastic comments for absentees',
      'Free with API key',
    ],
  },
  {
    version: '4.7.0',
    date: '2025-12-18',
    changes: [
      'New: Graphs feature (Admin only)',
      'Cumulative profit chart',
      'Head-to-head comparison',
      'Leaderboard race',
    ],
  },
  {
    version: '4.6.41',
    date: '2025-12-18',
    changes: [
      'Removed historical-import (now via cloud)',
    ],
  },
  {
    version: '4.6.40',
    date: '2025-12-18',
    changes: [
      'Fix: GitHub fetch CORS',
    ],
  },
  {
    version: '4.6.39',
    date: '2025-12-18',
    changes: [
      'Fix: UTF-8 decoding for Hebrew names',
    ],
  },
  {
    version: '4.6.38',
    date: '2025-12-18',
    changes: [
      'Fix: sync via API not raw CDN',
    ],
  },
  {
    version: '4.6.37',
    date: '2025-12-18',
    changes: [
      'Sync: page reloads after sync',
    ],
  },
  {
    version: '4.6.36',
    date: '2025-12-18',
    changes: [
      'Critical: stats works after sync',
      'Player IDs matched correctly',
    ],
  },
  {
    version: '4.6.35',
    date: '2025-12-18',
    changes: [
      'Player stats: grey arrow',
    ],
  },
  {
    version: '4.6.34',
    date: '2025-12-18',
    changes: [
      'Fix: synced players have correct type',
    ],
  },
  {
    version: '4.6.33',
    date: '2025-12-18',
    changes: [
      'Player stats: aligned with Records design',
      '2-column grid + icons + labels',
    ],
  },
  {
    version: '4.6.32',
    date: '2025-12-18',
    changes: [
      'Cloud sync: full replacement',
      'Version tracking',
      'Auto-sync on game delete',
    ],
  },
  {
    version: '4.6.30',
    date: '2025-12-18',
    changes: [
      'Stat-card boxes match Records design',
    ],
  },
  {
    version: '4.6.29',
    date: '2025-12-18',
    changes: [
      'Player stats: timeframe header',
    ],
  },
  {
    version: '4.6.28',
    date: '2025-12-18',
    changes: [
      'Streaks: "3 Wins" / "4 Losses"',
    ],
  },
  {
    version: '4.6.27',
    date: '2025-12-18',
    changes: [
      'Cloud sync: delta mode',
      'Force Full Sync button',
    ],
  },
  {
    version: '4.6.26',
    date: '2025-12-18',
    changes: [
      'Records title shows timeframe',
    ],
  },
  {
    version: '4.6.25',
    date: '2025-12-18',
    changes: [
      'Records header: English only',
      'Compact streak display',
    ],
  },
  {
    version: '4.6.24',
    date: '2025-12-18',
    changes: [
      'Records: gray arrow for clickable',
    ],
  },
  {
    version: '4.6.23',
    date: '2025-12-18',
    changes: [
      'Records: cleaner layout',
      'Shorter player-stat labels',
    ],
  },
  {
    version: '4.6.22',
    date: '2025-12-18',
    changes: [
      'Cloud sync: full data replacement',
      'Deletes propagate to all users',
    ],
  },
  {
    version: '4.6.21',
    date: '2025-12-18',
    changes: [
      'Records: layout fix',
    ],
  },
  {
    version: '4.6.20',
    date: '2025-12-18',
    changes: [
      'New: GitHub Cloud Sync',
      'Auto-sync on game complete',
      'Viewer role excluded',
    ],
  },
  {
    version: '4.6.19',
    date: '2025-12-18',
    changes: [
      'All numbers: whole numbers only',
    ],
  },
  {
    version: '4.6.18',
    date: '2025-12-18',
    changes: [
      'Numbers: thousand separators',
    ],
  },
  {
    version: '4.6.17',
    date: '2025-12-18',
    changes: [
      'Player W/L bar: latest on right',
      'Date includes year',
    ],
  },
  {
    version: '4.6.16',
    date: '2025-12-18',
    changes: [
      'Stats screenshot: no share button',
    ],
  },
  {
    version: '4.6.15',
    date: '2025-12-18',
    changes: [
      'Stats screenshot: includes share button',
    ],
  },
  {
    version: '4.6.14',
    date: '2025-12-18',
    changes: [
      'Stats: smaller centered share button',
    ],
  },
  {
    version: '4.6.13',
    date: '2025-12-18',
    changes: [
      'Player games respect period filter',
    ],
  },
  {
    version: '4.6.12',
    date: '2025-12-18',
    changes: [
      'Stats: WhatsApp screenshot share',
    ],
  },
  {
    version: '4.6.11',
    date: '2025-12-18',
    changes: [
      'Fix: Stats crash (useRef import)',
    ],
  },
  {
    version: '4.6.10',
    date: '2025-12-18',
    changes: [
      'Import: shows file prep date',
    ],
  },
  {
    version: '4.6.9',
    date: '2025-12-18',
    changes: [
      'Period preserved in navigation',
      'Filter changes don\'t reopen modal',
    ],
  },
  {
    version: '4.6.8',
    date: '2025-12-18',
    changes: [
      'Import: file prep timestamp',
    ],
  },
  {
    version: '4.6.7',
    date: '2025-12-18',
    changes: [
      'Stats table: better column spacing',
    ],
  },
  {
    version: '4.6.6',
    date: '2025-12-18',
    changes: [
      'Stats table: compact, no wrap',
    ],
  },
  {
    version: '4.6.5',
    date: '2025-12-18',
    changes: [
      'Records: English labels',
    ],
  },
  {
    version: '4.6.4',
    date: '2025-12-18',
    changes: [
      'Stats table: Avg column',
      'Whole numbers only',
      'Medals after name',
    ],
  },
  {
    version: '4.6.3',
    date: '2025-12-18',
    changes: [
      'Renamed "All-Time Leaders" → "מובילים"',
    ],
  },
  {
    version: '4.6.1',
    date: '2025-12-17',
    changes: [
      'Active filter: 33% of period games',
    ],
  },
  {
    version: '4.6.0',
    date: '2024-12-17',
    changes: [
      'Forecast: gender support for מור',
    ],
  },
  {
    version: '4.5.9',
    date: '2025-12-17',
    changes: [
      'Filter explanation: "מעל 33%"',
    ],
  },
  {
    version: '4.5.8',
    date: '2025-12-17',
    changes: [
      'Active filter label clarified',
    ],
  },
  {
    version: '4.5.7',
    date: '2025-12-17',
    changes: [
      'Filter buttons no longer trigger popups',
    ],
  },
  {
    version: '4.5.6',
    date: '2025-12-17',
    changes: [
      'Stat box respects period',
      'Game details scrolls to top',
      'Back navigation preserves view',
    ],
  },
  {
    version: '4.5.5',
    date: '2024-12-17',
    changes: [
      'Forecast: gender-aware Hebrew',
      'Auto-detect female names',
    ],
  },
  {
    version: '4.5.4',
    date: '2025-12-17',
    changes: [
      'Player view: all stat boxes clickable',
      'Stats records-style modal',
    ],
  },
  {
    version: '4.5.3',
    date: '2024-12-17',
    changes: [
      'Forecast: sarcastic for absentees',
      '3+ / 6+ / year+ levels',
    ],
  },
  {
    version: '4.5.2',
    date: '2025-12-17',
    changes: [
      'Filter buttons no popups',
      'Click row in table → game history',
    ],
  },
  {
    version: '4.5.1',
    date: '2025-12-17',
    changes: [
      'Settings tab: "Backup & Restore"',
    ],
  },
  {
    version: '4.5.0',
    date: '2025-12-17',
    changes: [
      'Player stats: last 6 games',
      'Clickable game tiles',
      'Scroll to player on return',
    ],
  },
  {
    version: '4.4.0',
    date: '2024-12-17',
    changes: [
      'Forecast: time-aware sentences',
      'No "לאחרונה" for absent players',
      'Returning-player handling',
    ],
  },
  {
    version: '4.3.6',
    date: '2025-12-17',
    changes: [
      'Back returns to record details',
    ],
  },
  {
    version: '4.3.5',
    date: '2024-12-17',
    changes: [
      'Back returns to Records view',
    ],
  },
  {
    version: '4.3.4',
    date: '2024-12-17',
    changes: [
      'Records: per-player "פרטים"',
    ],
  },
  {
    version: '4.3.3',
    date: '2024-12-17',
    changes: [
      'Records: dedicated back-flow',
    ],
  },
  {
    version: '4.3.2',
    date: '2024-12-17',
    changes: [
      'Forecast: fully dynamic per run',
      'Doubled sentence variety',
    ],
  },
  {
    version: '4.3.1',
    date: '2024-12-17',
    changes: [
      'Records: DD/MM/YYYY dates',
      'Click row → game details',
    ],
  },
  {
    version: '4.3.0',
    date: '2024-12-17',
    changes: [
      'Forecast: dynamic per-player highlights',
      'Detects streaks/comebacks/volatility',
    ],
  },
  {
    version: '4.2.3',
    date: '2024-12-17',
    changes: [
      'Records drill-down: actual data',
      '"פרטים ❯" button',
    ],
  },
  {
    version: '4.2.2',
    date: '2024-12-17',
    changes: [
      'Forecast: stats highlights',
      'Creative sentences separate',
    ],
  },
  {
    version: '4.2.1',
    date: '2024-12-17',
    changes: [
      'Records: 🔍 to see games',
    ],
  },
  {
    version: '4.2.0',
    date: '2024-12-17',
    changes: [
      'Forecast: 60% recent / 40% history',
      'Streak badges 🔥/❄️',
      'Trend detection',
      'Smarter surprises',
    ],
  },
  {
    version: '4.1.3',
    date: '2024-12-17',
    changes: [
      'Fix: forecast button works',
    ],
  },
  {
    version: '4.1.2',
    date: '2024-12-17',
    changes: [
      'Fix: אורח filter highlight',
    ],
  },
  {
    version: '4.1.1',
    date: '2024-12-17',
    changes: [
      'Forecast: rewritten sentences',
      'Smart surprise system',
      'Screenshot WhatsApp share',
    ],
  },
  {
    version: '4.1.0',
    date: '2024-12-17',
    changes: [
      'Roles: Admin / Member / Viewer',
      'PIN-based access',
      'UI adapts to permissions',
    ],
  },
  {
    version: '4.0.0',
    date: '2024-12-17',
    changes: [
      'Forecast 3.0: pro overhaul',
      'Smart surprise (≤35%)',
      'Unique sentences per player',
      'Visual legend',
      'Cached forecasts',
    ],
  },
  {
    version: '3.9.9',
    date: '2024-12-17',
    changes: [
      'Records: name + value side by side',
    ],
  },
  {
    version: '3.9.8',
    date: '2024-12-17',
    changes: [
      'Records: expandable ties',
    ],
  },
  {
    version: '3.9.7',
    date: '2024-12-17',
    changes: [
      'History: consistent buyins display',
    ],
  },
  {
    version: '3.9.6',
    date: '2024-12-17',
    changes: [
      'History: all players sorted by profit',
      '"פרטים מלאים" button',
    ],
  },
  {
    version: '3.9.5',
    date: '2024-12-17',
    changes: [
      'Active Players filter at top',
      'On by default',
    ],
  },
  {
    version: '3.9.4',
    date: '2024-12-17',
    changes: [
      'Stats default: current half-year',
    ],
  },
  {
    version: '3.9.3',
    date: '2024-12-17',
    changes: [
      'iOS-style toggle for Active Players',
      'Compact year selector',
    ],
  },
  {
    version: '3.9.2',
    date: '2024-12-17',
    changes: [
      'Bugfix: JSX syntax error',
    ],
  },
  {
    version: '3.8.0',
    date: '2024-12-17',
    changes: [
      'New game: location selector',
      'Quick + custom options',
    ],
  },
  {
    version: '3.7.2',
    date: '2024-12-17',
    changes: [
      'Removed Dec-6 auto-import',
    ],
  },
  {
    version: '3.7.1',
    date: '2024-12-17',
    changes: [
      'New game: compact layout',
      '11 players visible no-scroll',
    ],
  },
  {
    version: '3.7.0',
    date: '2024-12-17',
    changes: [
      'Terminology: "Rebuy" → "Buyin"',
    ],
  },
  {
    version: '3.6.4',
    date: '2024-12-17',
    changes: [
      'Guest badge: grey background',
    ],
  },
  {
    version: '3.6.3',
    date: '2024-12-17',
    changes: [
      'Labels: אורח / מזדמן (singular)',
      'Guest icon: 🏠',
    ],
  },
  {
    version: '3.6.2',
    date: '2024-12-17',
    changes: [
      'Settings: players sorted by type',
    ],
  },
  {
    version: '3.6.1',
    date: '2024-12-17',
    changes: [
      'Import: read player types',
    ],
  },
  {
    version: '3.6.0',
    date: '2024-12-17',
    changes: [
      'Import replaces all data',
      '217 games from Excel',
    ],
  },
  {
    version: '3.5.0',
    date: '2024-12-16',
    changes: [
      'Renamed types: קבוע / אורח / מזדמן',
      'New icons + Hebrew descriptions',
    ],
  },
  {
    version: '3.4.3',
    date: '2024-12-16',
    changes: [
      'UI: unified selection colors',
    ],
  },
  {
    version: '3.4.2',
    date: '2024-12-16',
    changes: [
      'Bugfix: Select/Deselect All',
      'Bugfix: Stats Clear button',
    ],
  },
  {
    version: '3.4.1',
    date: '2024-12-16',
    changes: [
      'Bugfix: tab-switch freeze',
      'Stats: memoization added',
    ],
  },
  {
    version: '3.4.0',
    date: '2024-12-16',
    changes: [
      'Stats: multi-select player type',
    ],
  },
  {
    version: '3.3.0',
    date: '2024-12-16',
    changes: [
      'Stats: minimum games filter',
    ],
  },
  {
    version: '3.2.0',
    date: '2024-12-16',
    changes: [
      'Stats: time period filter',
      'Filter by year (2021+)',
    ],
  },
  {
    version: '3.1.0',
    date: '2024-12-16',
    changes: [
      'Excel import: 213 historical games',
      'Backup before applying',
    ],
  },
  {
    version: '3.0.0',
    date: '2024-12-16',
    changes: [
      '3 player types: Permanent / Guest / Occasional',
      'Stats: filter by type',
      'Settings: type editor',
    ],
  },
  {
    version: '2.10.0',
    date: '2024-12-16',
    changes: [
      'Backup: Download to Downloads',
    ],
  },
  {
    version: '2.9.9',
    date: '2024-12-16',
    changes: [
      'Backup: Open WhatsApp button',
    ],
  },
  {
    version: '2.9.8',
    date: '2024-12-16',
    changes: [
      'Backup: WhatsApp share instructions',
    ],
  },
  {
    version: '2.9.7',
    date: '2024-12-16',
    changes: [
      'Backup: download fallback for share',
    ],
  },
  {
    version: '2.9.6',
    date: '2024-12-16',
    changes: [
      'Backup: share JSON file',
    ],
  },
  {
    version: '2.9.5',
    date: '2024-12-16',
    changes: [
      'Backup: WhatsApp share option',
    ],
  },
  {
    version: '2.9.4',
    date: '2024-12-16',
    changes: [
      'Stats: date below each game tile',
    ],
  },
  {
    version: '2.9.3',
    date: '2024-12-16',
    changes: [
      'Stats: "אחרון" label',
    ],
  },
  {
    version: '2.9.2',
    date: '2024-12-16',
    changes: [
      'Stats: ▲ on most recent game',
    ],
  },
  {
    version: '2.9.1',
    date: '2024-12-16',
    changes: [
      'Stats: 6 games (was 5)',
      'Most recent on the left',
    ],
  },
  {
    version: '2.9.0',
    date: '2024-12-16',
    changes: [
      'Forecast 2.0: complete overhaul',
      '40% surprise rate',
      '100+ unique Hebrew sentences',
    ],
  },
  {
    version: '2.8.4',
    date: '2024-12-15',
    changes: [
      'Forecast balanced: zero-sum',
    ],
  },
  {
    version: '2.8.3',
    date: '2024-12-15',
    changes: [
      'Auto backup: Sun → Fri',
    ],
  },
  {
    version: '2.8.2',
    date: '2024-12-15',
    changes: [
      'Chip delete icon styled to match',
    ],
  },
  {
    version: '2.8.1',
    date: '2024-12-15',
    changes: [
      'Auto backup after each game',
      'Backup type labels',
    ],
  },
  {
    version: '2.8.0',
    date: '2024-12-15',
    changes: [
      'Delete confirmation dialogs',
    ],
  },
  {
    version: '2.7.9',
    date: '2024-12-15',
    changes: [
      'Forecast: sentences match direction',
      'Longer + 100+ unique lines',
    ],
  },
  {
    version: '2.7.8',
    date: '2024-12-15',
    changes: [
      'Settings: unified player edit',
      'Cleaner backup section',
    ],
  },
  {
    version: '2.7.7',
    date: '2024-12-15',
    changes: [
      'Settings: Players tab first',
      'Tabs styled like Statistics',
    ],
  },
  {
    version: '2.7.6',
    date: '2024-12-15',
    changes: [
      'Settings: edit player names',
    ],
  },
  {
    version: '2.7.5',
    date: '2024-12-15',
    changes: [
      'Forecast: 100+ sentence options',
      '15% surprise predictions',
    ],
  },
  {
    version: '2.7.4',
    date: '2024-12-15',
    changes: [
      'Settings tabs wrap (no scroll)',
    ],
  },
  {
    version: '2.7.3',
    date: '2024-12-15',
    changes: [
      'Settings: player type column',
      'Choose type when adding',
      'Toggle for existing',
    ],
  },
  {
    version: '2.7.2',
    date: '2024-12-15',
    changes: [
      'Forecast sentences in Hebrew',
    ],
  },
  {
    version: '2.7.1',
    date: '2024-12-15',
    changes: [
      'Settings: tabs added',
    ],
  },
  {
    version: '2.7.0',
    date: '2024-12-15',
    changes: [
      'New: Forecast on New Game',
      'Profit/loss prediction',
      'Funny sentences per player',
      'WhatsApp share',
    ],
  },
  {
    version: '2.6.0',
    date: '2024-12-15',
    changes: [
      'New: Backup & Restore',
      'Auto-backup on Sundays',
      'Keeps last 4 backups',
    ],
  },
  {
    version: '2.5.6',
    date: '2024-12-15',
    changes: [
      'Game Details simplified',
      'Total Rebuys in header',
    ],
  },
  {
    version: '2.5.5',
    date: '2024-12-15',
    changes: [
      'Total Rebuys in summary',
    ],
  },
  {
    version: '2.5.4',
    date: '2024-12-15',
    changes: [
      'Game Details fits screen',
    ],
  },
  {
    version: '2.5.3',
    date: '2024-12-15',
    changes: [
      'Restored Chips column',
    ],
  },
  {
    version: '2.5.2',
    date: '2024-12-15',
    changes: [
      'Removed Chips column',
    ],
  },
  {
    version: '2.5.1',
    date: '2024-12-15',
    changes: [
      'Profit column no wrap',
    ],
  },
  {
    version: '2.5.0',
    date: '2024-12-15',
    changes: [
      'Use stored finalValue',
    ],
  },
  {
    version: '2.4.9',
    date: '2024-12-15',
    changes: [
      'Fix: chip display fallback',
    ],
  },
  {
    version: '2.4.8',
    date: '2024-12-15',
    changes: [
      'Game Details: screenshot share',
    ],
  },
  {
    version: '2.4.7',
    date: '2024-12-15',
    changes: [
      'Table width fits container',
    ],
  },
  {
    version: '2.4.6',
    date: '2024-12-15',
    changes: [
      'Chips column: chips not shekels',
    ],
  },
  {
    version: '2.4.5',
    date: '2024-12-15',
    changes: [
      'Historical import: Dec-6 2024',
    ],
  },
  {
    version: '2.4.4',
    date: '2024-12-14',
    changes: [
      'Sort tabs equally spread',
    ],
  },
  {
    version: '2.4.3',
    date: '2024-12-14',
    changes: [
      'Fix: small transfers no double',
      'Settlements + Small Amounts split',
    ],
  },
  {
    version: '2.4.2',
    date: '2024-12-14',
    changes: [
      'Sort buttons layout fix',
    ],
  },
  {
    version: '2.4.1',
    date: '2024-12-14',
    changes: [
      'Stats-only PIN (9876)',
    ],
  },
  {
    version: '2.4.0',
    date: '2024-12-14',
    changes: [
      'Permanent vs guest player types',
      'Settings + game flow toggles',
    ],
  },
  {
    version: '2.3.9',
    date: '2024-12-14',
    changes: [
      'Stats: multi-select player filter',
    ],
  },
  {
    version: '2.3.8',
    date: '2024-12-14',
    changes: [
      'Total Rebuys text in white',
    ],
  },
  {
    version: '2.3.7',
    date: '2024-12-14',
    changes: [
      'Enriched player statistics',
      'Avg performance records',
      'Most/least wins records',
    ],
  },
  {
    version: '2.3.6',
    date: '2024-12-14',
    changes: [
      'Restored progress bar format',
    ],
  },
  {
    version: '2.3.5',
    date: '2024-12-14',
    changes: [
      'Stats: loss colors red',
      'Removed confusing streaks',
      'Cold Streak red color',
    ],
  },
  {
    version: '2.3.4',
    date: '2024-12-14',
    changes: [
      'Chip entry: less empty space',
    ],
  },
  {
    version: '2.3.3',
    date: '2024-12-14',
    changes: [
      'Removed Reset Statistics',
      'Medal + number on same line',
    ],
  },
  {
    version: '2.3.2',
    date: '2024-12-14',
    changes: [
      'Restored Records view',
      'Current streaks',
      'All-time leaders',
      'Individual view trend',
    ],
  },
  {
    version: '2.3.1',
    date: '2024-12-14',
    changes: [
      'Restored chip-page player selector',
      'Done auto-advances',
    ],
  },
  {
    version: '2.3.0',
    date: '2024-12-14',
    changes: [
      'Major fix: Vercel rewrites',
      'Loading states on game screens',
      'Catch-all route',
      '2-column chip grid',
    ],
  },
  {
    version: '2.2.9',
    date: '2024-12-14',
    changes: [
      'Version on PIN screen',
    ],
  },
  {
    version: '2.2.8',
    date: '2024-12-14',
    changes: [
      'Stats: Table + Individual only',
    ],
  },
  {
    version: '2.2.7',
    date: '2024-12-14',
    changes: [
      'Stats: Table is default',
    ],
  },
  {
    version: '2.2.6',
    date: '2024-12-14',
    changes: [
      'Progress bar: 28px + visible bg',
    ],
  },
  {
    version: '2.2.5',
    date: '2024-12-14',
    changes: [
      'Removed Reset All Statistics',
    ],
  },
  {
    version: '2.2.4',
    date: '2024-12-14',
    changes: [
      'Progress bar: 36px + chip count',
    ],
  },
  {
    version: '2.2.3',
    date: '2024-12-14',
    changes: [
      'Bottom bar flows with content',
    ],
  },
  {
    version: '2.2.2',
    date: '2024-12-14',
    changes: [
      'Version on PIN login screen',
    ],
  },
  {
    version: '1.9.4',
    date: '2024-12-14',
    changes: [
      'Summary headers: Chips, Rebuy',
    ],
  },
  {
    version: '1.9.3',
    date: '2024-12-14',
    changes: [
      'Updated chips/rebuy icons',
    ],
  },
  {
    version: '1.9.2',
    date: '2024-12-14',
    changes: [
      'Centered Home + Share buttons',
    ],
  },
  {
    version: '1.9.1',
    date: '2024-12-14',
    changes: [
      'Updated PIN code',
    ],
  },
  {
    version: '1.9.0',
    date: '2024-12-14',
    changes: [
      'PIN lock screen',
      'Session persists until close',
    ],
  },
  {
    version: '1.8.0',
    date: '2024-12-14',
    changes: [
      'Neutral +/- buttons',
      'Cleaner top counter',
    ],
  },
  {
    version: '1.7.8',
    date: '2024-12-14',
    changes: [
      'Changelog: latest only by default',
    ],
  },
  {
    version: '1.7.7',
    date: '2024-12-14',
    changes: [
      'Player tiles: even grid',
    ],
  },
  {
    version: '1.7.6',
    date: '2024-12-14',
    changes: [
      'Larger player tiles',
    ],
  },
  {
    version: '1.7.5',
    date: '2024-12-14',
    changes: [
      'More tile spacing',
    ],
  },
  {
    version: '1.7.4',
    date: '2024-12-14',
    changes: [
      'Progress red/orange longer',
      'Summary card visible early',
    ],
  },
  {
    version: '1.7.3',
    date: '2024-12-14',
    changes: [
      'Done allowed at 0 chips',
      'Removed long-press rapid increment',
    ],
  },
  {
    version: '1.7.2',
    date: '2024-12-14',
    changes: [
      'Progress bar: gradient colors',
    ],
  },
  {
    version: '1.7.1',
    date: '2024-12-14',
    changes: [
      'Progress bar at absolute bottom',
    ],
  },
  {
    version: '1.7.0',
    date: '2024-12-14',
    changes: [
      'Fixed-bottom progress bar',
    ],
  },
  {
    version: '1.6.3',
    date: '2024-12-14',
    changes: [
      'Compact player selection',
      'Start Game button visible',
    ],
  },
  {
    version: '1.6.2',
    date: '2024-12-14',
    changes: [
      'Visible Done button',
    ],
  },
  {
    version: '1.6.1',
    date: '2024-12-14',
    changes: [
      'Fix: chip counting blank screen',
    ],
  },
  {
    version: '1.6.0',
    date: '2024-12-14',
    changes: [
      'Collapsible player cards',
      'Floating progress bar',
    ],
  },
  {
    version: '1.5.1',
    date: '2024-12-14',
    changes: [
      'Removed winner box',
    ],
  },
  {
    version: '1.5.0',
    date: '2024-12-14',
    changes: [
      'Long-press rapid +/-',
      'Numpad modal for chip count',
    ],
  },
  {
    version: '1.4.1',
    date: '2024-12-14',
    changes: [
      'Smaller winner box',
    ],
  },
  {
    version: '1.4.0',
    date: '2024-12-14',
    changes: [
      'WhatsApp share: screenshot',
      'Native share on mobile',
    ],
  },
  {
    version: '1.3.0',
    date: '2024-12-14',
    changes: [
      'Rebuys: count only',
      'Mobile-friendly table',
      'WhatsApp export redesign',
    ],
  },
  {
    version: '1.2.0',
    date: '2024-12-14',
    changes: [
      'Total chips column',
      'Total rebuy column',
      'Both in WhatsApp export',
    ],
  },
  {
    version: '1.1.0',
    date: '2024-12-14',
    changes: [
      'Versioning system',
      'Changelog in Settings',
    ],
  },
  {
    version: '1.0.0',
    date: '2024-12-01',
    changes: [
      'Initial release',
      'Game management',
      'Player tracking',
      'Chip calculations',
      'History and statistics',
    ],
  },
];
