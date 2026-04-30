/**
 * App Version Management
 * Increment version with each change for tracking purposes
 * Last deploy trigger: 2026-04-20-v2
 */

export const APP_VERSION = '5.29.1';

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '5.29.1',
    date: '2026-04-30',
    changes: [
      '🪪 Confirmation share card collapsed to a single screen: the separate "names manifest" block is gone — confirmed players now live as rows inside the period stats table (rank/medal · name · profit · avg · games · win%). Players who haven\'t played in the current half-year sit at the bottom with em-dashes so the table doubles as the attendee roster.',
      '📝 Admin note moved up to sit right under the boarding-pass hero (instead of trailing the card), so the host\'s message reads as part of the booking.',
      '📊 Table redesigned to mirror the StatisticsScreen share-table format: centered metadata caption (📊 period · X משחקים · ✓ N מגיעים) over a hairline divider, then a clean borderless table with row separators, color-coded profit/avg/win%, and overall period rank with medals for top 3.',
    ],
  },
  {
    version: '5.29.0',
    date: '2026-04-30',
    changes: [
      '📊 Schedule confirmation share card now includes a half-year leaderboard table for the confirmed players: rank · name · profit · avg · games · win%. Pulls from getPlayerStats with the current H1/H2 window so numbers match the Statistics tab exactly. Top-3 ranks get medals (🥇🥈🥉). Auto-hides when the period has no completed games or no confirmed player has played yet.',
      '🔍 Rank shown is the OVERALL period rank (not 1..N within attendees) so each confirmed player is positioned in the broader half-year season.',
      '📐 Share card upsized 720→900 px wide with proportional typography across all three modes (confirmation, invitation, cancellation): title 26→34, hero values 22→28, manifest names 17→22, voter chips 15→18, all paddings/radii/badges scaled. At html2canvas scale: 2 the rendered PNG is 1800 px wide for crisper readability without breaking the WhatsApp size budget.',
      '🔢 Profit/avg sign formatting now wraps the entire signed run in a single LRM mark (matching formatCurrency), so the +/- sits on the correct side of the number in RTL.',
    ],
  },
  {
    version: '5.28.1',
    date: '2026-04-30',
    changes: [
      '🎫 Schedule share-card polish: removed redundant status pill ("✓ סגור" / "🗳 הצביעו" / "⊘ בוטל") that just doubled what the title already says — colored emoji badge alone now carries the mode.',
      '🔧 Fixed English key leakage ("schedule.share.headerSubtitleConfirmation") on the confirmation share image — root cause was the t() fallback treating `\'\'` as missing; switched to dropping the subtitle field entirely on confirmation. Cleaned up 5 dead translation keys.',
      '📱 Share card upsized 520→720 px wide with proportionally scaled paddings and font sizes (titles, hero values, manifest names, notes, voter chips, all of it). At default scale: 2 the rendered PNG is 1440 px wide — sharper preview in WhatsApp without quality loss.',
      '🎨 Comic bubbles: capped maxWidth at 55% (78%→55%) and minWidth at 22% so bubbles no longer cover the character art beneath. Caption width capped at 70%. Font-size clamps tightened to keep 2-line wraps with the new narrower bubbles.',
      '🤖 Comic prompt rework: panel scenes now lead with character + action ("Yossi slams cards down with a triumphant grin") instead of cinematic environment; explicit ban on photo / cinematic / depth-of-field / wide-shot language so FLUX returns illustrated character close-ups instead of empty rooms.',
    ],
  },
  {
    version: '5.28.0',
    date: '2026-04-30',
    changes: [
      '🎨 Game-Night Comic — drastic quality rework. Image generation moved off Gemini (paid-tier only) to Pollinations.ai FLUX, free anonymous tier. Each of the 4 panels is now generated separately at 1024×1024 with a focused single-scene prompt that aggressively forbids text, then composited client-side onto a 2068×2068 canvas with hairline gutters. Hybrid parallel-then-sequential-retry strategy with 429 backoff handles the anonymous-tier concurrent-request limit gracefully. Result: zero text leakage, sharper composition, clean Hebrew DOM bubbles on top.',
      '📊 Comic art progress is reported per-panel ("Drawing panel 2 of 4…") so the ~4–6 minute generation feels measurable instead of hung. Localized in HE + EN.',
      '💬 Comic speech bubbles widened (maxWidth 60% → 78%, minWidth 20% → 38%) with overflowWrap instead of wordBreak, fixing awkward narrow Hebrew column wrapping on mobile.',
      '🎫 Schedule confirmation hero (boarding-pass strip) redesigned with four uniform segments — day · date · time · location — same typographic weight, accent stripe carries the color. Reads as a single horizontal strip instead of competing focal points. Hebrew weekday now renders as "שבת" instead of redundant "יום שבת".',
      '🔧 Postgres trigger fix (035-fix-zero-sum-trigger.sql): check_game_zero_sum no longer fires on the BEFORE-INSERT phase of upserts of already-completed games, eliminating the spurious "Game profits must sum to zero" toast when saving AI summaries, comics, paid settlements, etc. on historically drifted games.',
    ],
  },
  {
    version: '5.27.6',
    date: '2026-04-30',
    changes: [
      '📦 Consolidated push of accumulated multi-agent work (5.27.0 → 5.27.5): training-report notifications, Activity weekly trend metric fix, expanded member-card split, Training Engagement last-session column + sort + green weekly count.',
    ],
  },
  {
    version: '5.27.5',
    date: '2026-04-30',
    changes: [
      '🎨 Activity > Training Engagement — per-row weekly questions count (e.g. `8 שאלות`) is now emerald green (`#10B981`) instead of indigo, so it visually separates from the indigo `2/8 פעילים` summary count in the card header. Easier to scan: header = summary, row = individual achievement.',
    ],
  },
  {
    version: '5.27.4',
    date: '2026-04-30',
    changes: [
      '🎯 Activity > Training Engagement card — rows are now sorted by most-recent training session first (descending by `lastSession.date`), so the player who trained most recently always appears at the top regardless of whether they hit their weekly goal. Players who never trained sink to the bottom. Tiebreaker is `weekQs` desc, then name for stable ordering.',
    ],
  },
  {
    version: '5.27.3',
    date: '2026-04-30',
    changes: [
      '👤 Activity > expanded member card now splits into two clearly-separated sections: 🎯 ביקור אחרון (last session date+time, that session\'s duration in minutes, and the screens visited only in that visit — no ×counts since it\'s a single session) and 📈 סה"כ (30 ימים) (active days, total session count, total minutes, and the cumulative screen chips with ×counts). A faint divider sits between them. Previously everything was bundled into one ambiguous row and the screens chip list mixed last-visit with all-time data.',
    ],
  },
  {
    version: '5.27.2',
    date: '2026-04-30',
    changes: [
      '🎯 Activity > Training Engagement card — each row now shows the player\'s last training date + time (e.g. `30/4 21:30`) alongside accuracy / total sessions, so you can see at a glance when each player last trained without needing to expand them. Date is bidi-isolated (`dir="ltr"`) so the digits render correctly inside the RTL row.',
    ],
  },
  {
    version: '5.27.1',
    date: '2026-04-30',
    changes: [
      '📊 Activity weekly trend chart — bars now represent total visits (user-days) instead of unique users, matching the "ביקורים השבוע" stat above. The number on top of each bar, the bar height, the gradient intensity, and the ▲/▼ delta vs last week are all driven by `sessions` (user-days). Unique-user count is still shown in the bottom-left legend (`משתמשים השבוע`), so both metrics remain visible — just no longer disagree silently.',
    ],
  },
  {
    version: '5.27.0',
    date: '2026-04-30',
    changes: [
      '🔔 Training reports — auto-notify the reporter when admin resolves a flagged question. Both push notification (short summary) AND email (full nicely-formatted message) are sent automatically when admin clicks Remove / Dismiss / Apply Fix.',
      '🤖 If admin used AI to analyze the report, the rich `acceptText` / `rejectText` (with thanks + detailed explanation) is included in the email — same content quality as the manual WhatsApp share. If admin acted without AI, a generic outcome message is built per action: removed / fixed / kept.',
      '📨 Email is personalized per reporter (greeting with their name, question context with cards/board/situation/correct answer, their own original comment, then the verdict + explanation).',
      '🛠️ New `src/utils/trainingReportNotifications.ts` helper centralizes the dispatch (best-effort, never blocks/throws). Wired into `handleRemoveFlagged`, `handleDismissFlagged`, and `confirmAIFix`. `fixPreview` now carries the captured `reports[]` so the post-save notification has access to the original reporters even after the flagReports are cleared from training_answers.',
    ],
  },
  {
    version: '5.26.4',
    date: '2026-04-30',
    changes: [
      '🛡️ Multi-device save safety: gameToRow() now omits optional fields (aiSummary, comic_*, forecast_*, location, chip_gap, etc.) when undefined locally instead of writing null. A stale cache on another device/tab can no longer clobber a freshly-saved AI summary just by upserting an unrelated game change — postgres on-conflict update only touches columns present in the payload.',
      '🐛 Fixes the overnight regression where the AI summary would disappear after another device had loaded the game prior to summary generation and then made any unrelated change.',
    ],
  },
  {
    version: '5.26.3',
    date: '2026-04-30',
    changes: [
      '🐛 Fix: AI summary / comic regenerations no longer revert to the previous (or empty) state when realtime echoes race the debounced sync — supabaseCache now tracks per-game pending writes and preserves local copies during refreshGroups for a 15s window',
      '🚨 Sync errors are now visible: failing Supabase upserts dispatch a `supabase-sync-error` event that App.tsx surfaces as an error toast (throttled), so silent failures (missing columns, RLS, network) can never again let writes evaporate after the next realtime refresh',
      '🧹 markGameLocallyWritten() called from saveGameAiSummary, saveGameComic, clearGameComic, saveForecastAccuracy, saveForecastComment, updateGame, updateGameStatus — and cleared automatically when the games upsert succeeds',
    ],
  },
  {
    version: '5.26.2',
    date: '2026-04-30',
    changes: [
      '🩺 Comic generation error: surfaces the raw upstream error message inline (collapsible "Technical details") so failures can be diagnosed on mobile without devtools',
      '🔁 Comic art fallback: try the canonical `gemini-2.5-flash-image-preview` alias first (broader regional availability) and `gemini-2.5-flash-image` as backup',
      '📐 Schedule tab header: title no longer truncates on narrow viewports — buttons wrap to a new line instead',
    ],
  },
  {
    version: '5.26.1',
    date: '2026-04-29',
    changes: [
      '🎨 Comic pipeline: stage-tagged errors (ComicStageError) surface which step failed (script/art/upload) in the UI instead of a generic message',
      '🔄 Comic art: multi-model fallback chain — tries each IMAGE_MODEL in order on 429/404/503/empty-image, with per-attempt console logging',
      '📊 Comic pipeline: structured console logging at every stage (start, style, script, art, bbox, upload, success/fail) for easier debugging',
      '📐 Schedule tab header: flex-wrap layout so action buttons wrap gracefully on narrow viewports instead of title truncation',
    ],
  },
  {
    version: '5.26.0',
    date: '2026-04-29',
    changes: [
      '🎨 Game-Night Comic: admin can generate a one-page Hebrew comic of any completed game and share it to WhatsApp — three-stage AI pipeline (script → art → face-bbox) using Gemini 2.5 Flash Image, with DOM-rendered Hebrew bubbles for crisp typography',
      '🖼️ Six comic styles auto-picked by game vibe (Sunday strip, Manga, Noir, Pixar 3D, Tintin ligne claire, Retro 70s) with style-matched bubble themes; "Try another style" cycles through them, capped at 3 regenerations per game',
      '🗄️ New supabase/033 migration: game-comics Storage bucket (admin-write RLS, public-read) + 4 new columns on games — fail-silent, all members see the same comic via existing realtime',
      '🗳️ Schedule polls — major upgrade: admins can delete (027) and edit (028) polls; per-vote history (029) shows when each vote was cast or changed',
      '🔔 Schedule polls — vote-change notifications (030, 031, 032): voters learn when participants change their RSVP after confirmation; admins can opt out per-poll, change-window controls',
      '📲 Vote reminder banner: floating banner nudges members with unanswered open polls, with one-tap deep link to vote',
      '🔡 Loaded Heebo font alongside Outfit so Hebrew renders cleanly inside the comic speech bubbles',
    ],
  },
  {
    version: '5.25.0',
    date: '2026-04-28',
    changes: [
      '📅 Schedule (Next Game): full date-poll feature — admins propose dates, members RSVP, auto-confirm on target, expansion delay, WhatsApp share, proxy votes',
      '⚙️ Schedule create-poll: removed 2–5 date limit — start with one auto-filled date (next game-night day from settings), add more as needed',
      '🧭 Settings: moved “המשחק הבא” tab to the end (after “אודות”) for less prominent placement',
      '🗓️ Activity heatmap: added date range header (e.g. 21/4–28/4) and highlight today\'s row for clarity',
    ],
  },
  {
    version: '5.24.4',
    date: '2026-04-28',
    changes: [
      '🗓️ Activity heatmap: added date range header (e.g. 21/4–28/4) and highlight today\'s row for clarity',
    ],
  },
  {
    version: '5.24.3',
    date: '2026-04-28',
    changes: [
      '🎯 Pool generation prompt: aligned with quality-scan checks (hand recognition, no spoilers in situation, bluff = wrong, unique cards, no placeholders)',
      '✅ Generation now includes self-check checklist before returning JSON — fewer questions need fixing on scan',
      '🛡 Local validation tightened: rejects scenarios with duplicate cards, placeholder text, or hand spoilers in situation',
    ],
  },
  {
    version: '5.24.2',
    date: '2026-04-28',
    changes: [
      '⚡ Quality scan: smaller batches (4 vs 10) and tokens (4096 vs 8192) to avoid Vercel Edge timeout (504)',
      '🔄 Quality scan: prefer stable gemini-2.5-flash over preview models (avoid 503 high-demand errors)',
      '🔁 Quality scan: retry once on 429/503/504 before falling back to next model',
    ],
  },
  {
    version: '5.24.1',
    date: '2026-04-28',
    changes: [
      '⚡ Pool generation: split into small batches (6 questions each) to avoid Vercel Edge timeout (was 35 in one call → 504)',
      '🔄 Pool generation: prefer stable gemini-2.5-flash over preview models (avoid 503 high-demand errors)',
      '🔁 Pool generation: retry on 504 too, shorter 5s backoff between retries',
    ],
  },
  {
    version: '5.24.0',
    date: '2026-04-28',
    changes: [
      '🤖 Pool generation: try all 3 Gemini models with fallback (was hard-coded to flash-3 only)',
      '🔍 Per-category diagnostics: see exactly which model failed and why (HTTP status, JSON parse errors, validation reasons)',
      '💬 Training fix preview: WhatsApp share to reporter now visible in fix preview modal (regression after AI flow migration)',
    ],
  },
  {
    version: '5.23.4',
    date: '2026-04-26',
    changes: [
      '📱 Group wizard: mobile-first layout — centered column (26rem), safe-area padding, aligned header/footer',
      '📱 Add-players step: full-width name field, gender + add row below, hint card, improved empty/chips spacing',
    ],
  },
  {
    version: '5.23.3',
    date: '2026-04-26',
    changes: [
      '📱 Group wizard: fix scroll so header/footer stay reachable on small screens (flex minHeight + iOS touch scroll)',
    ],
  },
  {
    version: '5.23.2',
    date: '2026-04-26',
    changes: [
      '📱 Live game: align rebuy count and buy-in label in a fixed column across player rows',
    ],
  },
  {
    version: '5.23.1',
    date: '2026-04-26',
    changes: [
      '📱 Statistics table mode bar: flex-wrap and slightly tighter controls for small screens',
    ],
  },
  {
    version: '5.23.0',
    date: '2026-04-26',
    changes: [
      '✅ Add/remove players during live game (admin/owner/superadmin)',
      '📱 Compact single-line player rows in live game — less scrolling with 7-8 players',
      '📱 Player count added to live game summary card',
      '📱 Recent actions collapsed by default with expand toggle',
      '🔧 ROI division-by-zero guard in game summary highlights',
      '✅ GroupWizard: editable chip values, flow arrows, auto-focus player input',
      '✅ GroupWizard: features & game flow modals reused from Settings',
      '📱 Wizard done step cleanup, WhatsApp share container styled consistently',
      '📱 Settings: unified button styles, version badge simplified',
      '📊 Statistics: reordered table mode buttons, fixed avg column label',
      '🔧 SuperAdmin/Owner now inherit admin permissions across all screens',
    ],
  },
  {
    version: '5.22.6',
    date: '2026-04-21',
    changes: [
      '🎨 Split push/email test into separate buttons',
      '🎨 Group info card: added total players, games count, active since date',
      '🎨 Members sorting: owner first, then admins, then by player type',
      '🎨 Invite code merged into group info card with LTR layout fix',
      '🎨 Game flow guide modal with 5 steps + AI disclaimer',
      '🎨 Settings cleanup: removed unused cards, compacted heatmap & member cards',
      '🎨 Buyin value setting now shows helper explanation',
      '🃏 Board cards visible in training issue reports and shared screenshots',
    ]
  },
  {
    version: '5.22.5',
    date: '2026-04-21',
    changes: [
      '🔧 Exclude super admin from activity dashboard',
      '🔧 Activity member table sorted by last login (most recent first)',
      '🔧 Fix resolve email notification, improved email messages',
    ]
  },
  {
    version: '5.22.0',
    date: '2026-04-21',
    changes: [
      '✅ דיווח בעיה: new Settings tab for members to report bugs/issues with categories and free text',
      '✅ Owner gets email notification on new reports, reporter gets email when resolved',
      '✅ Super admin sees reports from all groups with group name labels',
      '🔧 Activity monitoring center: fixed inflated session counts, accurate unique user-day metrics',
      '🔧 Activity monitoring: calendar-date "active today", screen visit data in member cards',
      '🔧 Activity monitoring: owner included in dashboard, accurate identified user counts',
    ]
  },
  {
    version: '5.21.0',
    date: '2026-04-21',
    changes: [
      'Push notifications: recipient filter by player type (permanent, guests, occasional, manual)',
      'Push notifications: send via Push, Email, or both channels',
      'Push notifications: self-test button (Push + Email to yourself)',
      'Push notifications: auto-refresh subscriber list after send, stale endpoint cleanup',
      'Push API: removed verbose debug logs, clean per-player result chips',
      'Email API: broadcast mode for generic messages (separate from settlement emails)',
      'Fixed player type label mapping in push filter to match Players tab',
    ],
  },
  {
    version: '5.20.0',
    date: '2026-04-20',
    changes: [
      'Setup wizard: chip values step, invite players step, welcome summary modal, About tab shortcut',
      'Setup wizard: RTL-correct navigation arrows, step descriptions, skip optional steps',
      'Push notifications: aggressive cleanup for dead endpoints, auto-recover stale subscriptions',
      'Push tab: cleaned up debug UI, simplified test button',
      'Training analysis: share as image instead of text (html2canvas)',
      'Game navigation: fixed route paths for game details (/game/:id)',
      'ElevenLabs TTS card: super admin only, graceful fallback on API error',
    ],
  },
  {
    version: '5.19.0',
    date: '2026-04-20',
    changes: [
      'Training system refactor: direct Supabase writes, realtime sync, removed GitHub-era workarounds',
      'Activity tracking: reduced cooldown to 2min, immediate screen push on navigation',
      'Activity tab: popular screens card, training engagement card, feature adoption card',
      'Activity tab: show today active user names, weekly trend, improved member cards with screen data',
      'Super admin dashboard: premium redesign, per-group activity/training/feature adoption stats',
      'Super admin: weekly trainers from actual session dates, auto-scroll expanded groups',
      'Supabase optimizations: parallel player_traits loading, batched game child sync, scoped realtime refresh',
      'Training pool: replaced localStorage cache with in-memory cache',
      'Training writes: only upsert changed rows, delete removed players',
      'Group management: removed redundant member count badge, consistent role alignment',
      'SQL migrations 015-018: training realtime, group member counts, global stats with activity data',
    ],
  },
  {
    version: '5.18.0',
    date: '2026-04-20',
    changes: [
      '✨ Premium UI animations: smooth page transitions, card entrances, button feedback, shimmer loading',
      '👥 Redesigned group members list with avatars, staggered animations, inline controls',
      '🔔 Settlement notifications: email + in-app alerts when payments are marked or disputed',
      '🔧 Push notifications: DER-to-P1363 signature fix, per-device diagnostics, stale subscription cleanup',
      '📸 Screenshot fix: freeze animations before html2canvas capture for correct rendering',
      '🧹 Removed redundant "Unlink Player" button — use Remove for cleaner group management',
    ],
  },
  {
    version: '5.17.4',
    date: '2026-04-20',
    changes: [
      '👥 Fix: group members can now see all other members (was only showing self)',
      '🔒 Members see names and roles but not emails — admin controls remain restricted',
    ],
  },
  {
    version: '5.17.3',
    date: '2026-04-20',
    changes: [
      '🔔 Fix push notifications: VAPID key consistency, JWK import, detailed error reporting',
      '🎯 Test Push button now respects player selection',
      '📝 Dynamic helper text reflects send target',
    ],
  },
  {
    version: '5.17.2',
    date: '2026-04-20',
    changes: [
      '🔐 Fix auth: use JWKS for ES256 JWT verification (was failing with raw bytes)',
      '🔄 Unified auth across all API routes (github-backup now uses shared JWKS auth)',
      '🔑 Robust token refresh in backup and proxy auth headers',
      '🩺 Added /api/health diagnostic endpoint with selftest mode',
    ],
  },
  {
    version: '5.17.1',
    date: '2026-04-20',
    changes: [
      '🔧 Fix push notifications: corrected VAPID JWT signature format (P1363 instead of DER)',
      '📧 Fix email: added EmailJS private key (accessToken) for server-side calls',
      '🗄️ Fix push subscription upsert: added missing UPDATE RLS policy',
      '✏️ Fix player traits editor: commas and spaces now work in style/quirks fields',
    ],
  },
  {
    version: '5.17.0',
    date: '2026-04-19',
    changes: [
      '🔔 Push notifications — admins can send real push notifications to players (even when app is closed)',
      '📧 Settlement email switched from Resend to EmailJS (free, no domain needed)',
      '🔧 Service Worker + Web Push API with zero third-party dependencies',
      '💬 Notification templates: poker night, pay reminder, game cancelled, game starting',
      '🎯 Recipient picker: send to all players or select specific ones',
    ],
  },
  {
    version: '5.16.1',
    date: '2026-04-19',
    changes: [
      '🔧 Fix Vercel build — remove invalid toolbar property from vercel.json',
    ],
  },
  {
    version: '5.16.0',
    date: '2026-04-19',
    changes: [
      '✅ Multi-group support — switch between groups, create/join new groups without leaving current one',
      '📦 Full backup & restore — download all 19 tables as JSON, auto-push to GitHub (keeps 3 per group)',
      '📦 Backup tab in Settings — status indicator, restore from file or GitHub, 30-day reminder banner',
      '🌐 i18n audit — fixed 50+ hardcoded Hebrew strings across all screens for proper bilingual support',
      '🤖 AI features restricted to group owner only (forecasts, summaries, chronicles, insights)',
      '🔧 TTS pool auto-cleanup — free DB space by deleting voice data when game ends',
      '🔧 Enhanced auto game-end backup — now includes chronicle profiles and graph insights',
      '🔧 Vercel toolbar disabled — removed floating debug icon from deployed site',
    ]
  },
  {
    version: '5.15.1',
    date: '2026-04-19',
    changes: [
      '✅ Cache isolation fix — reset cache on logout, prevent stale data across sessions',
      '✅ Graphs & Statistics preserve player selection on realtime data refresh',
      '✅ Game summary share button Hebrew localization',
      '✅ Removed legacy storage event listeners',
    ]
  },
  {
    version: '5.15.0',
    date: '2026-04-19',
    changes: [
      '✅ Permissions overhaul — removed viewer role, simplified to admin + member',
      '✅ Super Admin dashboard — global stats, training toggle, orphaned group detection',
      '✅ New group setup wizard for owners — guided players + API key setup',
      '✅ AI key onboarding guide for group owners',
      '✅ Member read-only views on all game screens (live, chip entry, summary)',
      '✅ Training access control — per-group training_enabled flag',
      '✅ Removed backup tab — Supabase handles all data storage',
      '✅ Settlement toggle now works for admins + participants',
      '✅ Permission hardening — members cannot undo rebuys, edit expenses, or abandon games',
      '✅ Hebrew localization fixes across activity log and settings',
    ]
  },
  {
    version: '5.14.0',
    date: '2026-04-18',
    changes: [
      '✅ Personal player invites — send unique invite codes that auto-link players on join',
      '✅ Add member by email — owner can add registered users directly from Group tab',
      '✅ Nice shareable invite messages with WhatsApp support',
      '✅ Join flow supports both personal (8-char) and generic (6-char) invite codes',
    ]
  },
  {
    version: '5.13.0',
    date: '2026-04-17',
    changes: [
      '✅ Group Management tab in Settings — view members, change roles, invite code, transfer ownership',
      '✅ Per-group API keys — each group configures its own Gemini & ElevenLabs keys',
      '✅ Post-creation invite code screen with copy/share',
      '✅ Self-create player flow for new users not in the player list',
      '🔧 Owner-aware security in all management RPCs — admins cannot modify the owner',
      '🔧 Player delete guard — blocks deletion if player has game history',
      '🔧 Player linking uniqueness — prevents two members linking to the same player',
      '🔧 Removed deprecated memberSync role',
    ]
  },
  {
    version: '5.12.6',
    date: '2026-04-12',
    changes: [
      '🔄 Fix stale training data — fetch remote before flushing pending uploads, preventing deleted/stale data resurrection',
      '🧹 Admin deletion clears pending upload buffer for deleted player',
      '⏱️ Stale buffer safety — pending uploads older than 30min won\'t recreate removed players',
      '📊 Play screen rebuilds progress from remote on load, fixing nearMiss accuracy mismatch (53% → 74%)',
    ]
  },
  {
    version: '5.12.5',
    date: '2026-04-12',
    changes: [
      '🔄 Training progress — remote cloud data is now always authoritative, fixing stale local progress after session deletions',
    ]
  },
  {
    version: '5.12.4',
    date: '2026-04-12',
    changes: [
      '🧹 Per-player cloud data management — admin can delete all data or select specific sessions per player from GitHub',
      '📊 Insight generation stats — admin sees date, sessions, questions, accuracy at insight generation time',
      '🗑️ Removed hardcoded leaderboard exclusion — replaced with admin-controlled per-player deletion tool',
    ]
  },
  {
    version: '5.12.3',
    date: '2026-04-12',
    changes: [
      '🔄 Cloud sync merge — local-only completed games preserved during sync instead of being deleted, auto-pushed back to cloud',
      '🔑 Authenticated GitHub reads — all fetch calls now use embedded token to avoid rate limits',
      '📋 Training fix format rules — shared TRAINING_SCENARIO_FIX_FORMAT_RULES constant for consistent AI fix output',
      '🎯 Training leaderboard exclusion — admin can hide specific players from the shared leaderboard',
      '📊 getTrainingSessionCounts utility — centralized scoring with neutralized answer support',
      '🗂️ History screen improvements — stable game sort, useCallback optimization, route-aware reload',
      '⚙️ runGeminiTextPrompt extended — responseMimeType, topP, topK parameters for structured output',
    ]
  },
  {
    version: '5.12.2',
    date: '2026-04-09',
    changes: [
      '📤 Friends can share published forecasts — share button on published forecast card, works without admin/API key',
      '🖼️ WebP forecast images — smaller files for faster WhatsApp sharing, PNG fallback',
      '📱 Sequential WhatsApp sharing — multi-image forecasts sent one-by-one for better device compatibility',
      '⚡ Optimized capture scale (1.7x) — smaller upload size while staying sharp on mobile',
    ]
  },
  {
    version: '5.12.1',
    date: '2026-04-09',
    changes: [
      '📅 Custom date range filter in Graphs — same free-form date picker now available on graphs screen',
      '🧠 Smarter insight staleness — auto-detects stale coaching (3+ sessions since last), legacy name alias resolution',
      '✨ Batch insights button always visible — shows "up to date" when all fresh, count when updates needed',
      '🏷️ Needs-insight badge on player rows — visual indicator for players requiring coaching update',
    ]
  },
  {
    version: '5.12.0',
    date: '2026-04-09',
    changes: [
      '📅 Custom date range filter in Statistics — free-form start/end date picker alongside existing period filters',
      '🎯 Forecast tone/highlight validation — blocks optimistic text for negative predictions and vice versa, with hedge detection',
      '📎 Roster impact in AI forecast prompts — historical avg profit when playing with/without tonight\'s opponents',
      '🃏 Board cards separated from situation text — new boardCards field prevents info leaks in training questions',
      '🔧 runGeminiTextPrompt shared utility — coaching now uses callWithFallback with model rotation and MAX_TOKENS recovery',
      '📊 Forecast accuracy: direction-correct predictions now get partial credit (~) instead of miss (✗)',
      '🧹 Cleaned up pool generation prompt — shorter, structured format with strict field separation rules',
      '⚡ Pool fetch timeout — 3.5s timeout prevents slow GitHub responses from blocking training start',
      '🔇 Neutralized answer support — faulty questions can be marked without deleting player history',
    ]
  },
  {
    version: '5.11.5',
    date: '2026-04-06',
    changes: [
      '🎯 Holistic player coaching — replaces per-milestone reports with rich AI coaching using training + real game data',
      '📊 Real game stats in AI prompts — profit, win rate, streaks, and ranking integrated into coaching and insights',
      '🤖 Auto-generate coaching for eligible players — triggers on admin tab open for 100+ question players',
      '💬 Personal coach card on training hub — shareable coaching insight with stats header',
      '📈 Improved insights — stronger/weakest categories with sample counts, 70% threshold, better tiebreaking',
      '🔧 Milestone bundled with session upload — single atomic write instead of separate calls',
    ]
  },
  {
    version: '5.11.4',
    date: '2026-04-06',
    changes: [
      '🎨 Training mode buttons — stacked layout with icon and question count on top, label below',
    ]
  },
  {
    version: '5.11.3',
    date: '2026-04-06',
    changes: [
      '➕ Force expand pool — admin can add questions even when pool is healthy',
      '🔍 Auto quality scan after generation completes',
      '📊 Pool question counts shown on training mode buttons and category picker',
      '💬 Richer WhatsApp flag responses — includes question context, reporter name, and original comment',
      '🛡️ Robust AI review error handling — detailed per-model error logging, JSON parse recovery',
    ]
  },
  {
    version: '5.11.2',
    date: '2026-04-05',
    changes: [
      '🔍 AI flag report analysis — analyze flagged questions with AI verdict (accept/reject/partial), refinement chat, and WhatsApp share',
      '📊 Shared training analytics — analyzePlayerTraining and formatAnalysisForPrompt used by reports and admin insights',
      '🏠 Home-game reasoning enforcement — prompts forbid isolation/fold-equity logic, require home-game explanations',
      '📝 Richer personal reports — trend analysis, comparison to previous report, consistent weakness detection',
    ]
  },
  {
    version: '5.11.1',
    date: '2026-04-05',
    changes: [
      '🔧 GitHub large file support — Blob API fallback for files >1MB without inline content',
      '📋 AI report milestone teaser — shows remaining questions until next personal report',
      '🃏 Hebrew poker terminology enforcement — correct terms in AI generation and fix prompts, pot odds clarity',
    ]
  },
  {
    version: '5.11.0',
    date: '2026-04-05',
    changes: [
      '🎯 Player styles and game context — training prompts now include real player behaviors and table dynamics',
      '📝 Personal training reports — AI-generated analysis at milestone intervals with strengths and weaknesses',
      '💬 Answer reactions — fun Hebrew responses for correct and wrong answers',
      '🔄 Identity switch requires admin PIN for security',
      '🗣️ Game night summary prompt rewritten for better accuracy and record emphasis',
      '🃏 Inline card coloring in explanations, new odds/math training categories',
    ]
  },
  {
    version: '5.10.9',
    date: '2026-03-11',
    changes: [
      '🛠️ Training admin cleanup — simplified alerts, removed unused imports, memoized computations',
      '⬅️ Settlement arrows fixed to ← for correct RTL payment direction',
    ]
  },
  {
    version: '5.10.8',
    date: '2026-03-11',
    changes: [
      '📸 Shared captureAndSplit utility — auto-splits tall screenshots for sharing across all screens',
      '🚩 Rich flag reports — players can specify reason and comment when flagging questions',
      '🛠️ Admin flag management — dismiss flags, AI-fix questions, preview before saving',
      '🎯 Near-miss answers excluded from accuracy calculations across leaderboard and progress',
      '🗣️ TTS now includes training data per player for contextual commentary',
      '🃏 Card BiDi fix — playing cards render correctly in RTL text',
    ]
  },
  {
    version: '5.10.7',
    date: '2026-03-11',
    changes: [
      '⚡ Drastically reduce GitHub auto-commits to prevent Vercel deploy cancellation',
      '🔄 Pool generation: single upload at the end instead of per-category (47→1 commits)',
      '⏱️ Training answers: 10-min cooldown between GitHub pushes, buffer locally',
      '📊 Activity logger: 15-min cooldown between session updates, buffer in localStorage',
    ]
  },
  {
    version: '5.10.6',
    date: '2026-03-11',
    changes: [
      '🔄 Fix mobile cache — no-cache headers now apply to all SPA routes, not just /index.html',
    ]
  },
  {
    version: '5.10.5',
    date: '2026-03-11',
    changes: [
      '🤖 AI pool review — admin can scan entire training pool for logic, language, and nearMiss issues',
      '💾 Partial session save — training progress saved on navigate-away, not just on completion',
      '🪪 Identity by player ID — resolves name changes and legacy name corrections automatically',
      '🎨 Standings screenshot hardcoded dark theme — consistent look for sharing regardless of user theme',
      '📊 Top wins filter respects selected players, not just player types',
      '🔧 Training banner text wrapping enabled, tip icon alignment fix',
    ]
  },
  {
    version: '5.10.4',
    date: '2026-03-11',
    changes: [
      '🚩 Flagged question removal — loading state, error handling, uses local cache to avoid stale GitHub reads',
      '🎯 Near-miss icon changed from ½ to ~, cleaner near-miss label text',
    ]
  },
  {
    version: '5.10.3',
    date: '2026-03-11',
    changes: [
      '📸 Image-based sharing for training results and leaderboard via html2canvas',
      '🔄 Rebuild local progress from remote data when switching devices',
      '🎯 Near-miss tracking — marks GTO-valid answers that are suboptimal for home games',
      '💰 Added ₪/שקלים currency context to all AI prompts for accurate output',
      '📋 Training admin generation log with per-category status and counts',
      '🔧 Forecast state updates immediately after generation, local cache updated on flagged removal',
    ]
  },
  {
    version: '5.10.2',
    date: '2026-03-11',
    changes: [
      '🔄 Fix cloud sync skipping updates when remote has more completed games than local',
    ]
  },
  {
    version: '5.10.1',
    date: '2026-03-11',
    changes: [
      '🎯 Personalized training banner — dynamic messages based on player stats, streak, accuracy, and activity',
      '🛡️ Pool generation crash recovery — auto-saves draft and resumes from where it left off',
      '🤖 Pool gen uses best model only with retry-on-rate-limit instead of falling back to lite',
      '🔧 Truncated JSON salvage — recovers partial scenarios from cut-off AI responses',
      '♾️ Unlimited mode score display — compact counter replaces dots when >20 scenarios',
    ]
  },
  {
    version: '5.10.0',
    date: '2026-03-11',
    changes: [
      '🎯 Shared Training — pool-based poker training accessible to all players with progress tracking and badges',
      '🛠️ Training Admin tab in Settings for managing training pool generation',
      '☁️ Forecast publish/unpublish/delete now auto-syncs to cloud',
      '🔄 Cloud forecast is authoritative — always syncs from remote',
      '💱 Removed ₪ currency symbol across all screens for cleaner display',
    ]
  },
  {
    version: '5.9.8',
    date: '2026-03-11',
    changes: [
      '🔄 Forecast refresh keeps original players and location context',
      '📍 Location saved with pending forecast for accurate regeneration',
    ]
  },
  {
    version: '5.9.7',
    date: '2026-03-11',
    changes: [
      '🧪 Smart global insights — detects dependency, consistency, and profitability patterns across all players',
      '🔮 Forecast card redesign — collapsible, colored by profit/surprise, crown for top player',
      '📢 Unpublished forecast visible to admin with publish/hide controls',
      '📊 Exact win counts in insights (no rounding), game count labels on With/Without bars',
      '🎯 Dynamic veteran threshold in AI forecast angle assignment',
    ]
  },
  {
    version: '5.9.6',
    date: '2026-03-11',
    changes: [
      '📱 Mobile-friendly insight layout — text moved below name row to prevent wrapping',
      '🔤 Larger insight text (0.7rem) for better readability on phones',
      '🎨 Key Insights section with header, consistent card styling',
    ]
  },
  {
    version: '5.9.5',
    date: '2026-03-11',
    changes: [
      '🧪 Massively enriched Chemistry insights — diverse, non-repetitive per-player observations',
      '🔍 New Key Insights headline section with deduplicated top findings',
      '🎯 Every player row now always shows at least one insight with total profit/loss',
      '🧹 Removed duplicated summary layer — insights are the single source of truth',
    ]
  },
  {
    version: '5.9.4',
    date: '2026-03-30',
    changes: [
      '✨ Settlement UX improvements and personal highlighting across summary/statistics',
      '📱 History and statistics polish updates',
    ]
  },
  {
    version: '5.9.3',
    date: '2026-03-26',
    changes: [
      '🔄 Merged latest app improvements across gameplay, screens, and AI/TTS utilities',
    ]
  },
  {
    version: '5.9.2',
    date: '2026-03-25',
    changes: [
      '📅 Monthly summary table on last game of the month',
      '🚫 Date-based blocked transfers in settlement algorithm',
      '📊 Combo history hidden when only 1 shared game',
      '💬 ElevenLabs test text minimized to save quota',
      '🗑️ Delete confirmation + icon for TTS game entries',
      '📱 Activity log shows only meaningful sessions',
    ]
  },
  {
    version: '5.9.1',
    date: '2026-03-11',
    changes: [
      '⚡ TTS latency optimization — AudioContext playback, aggressive silence trim, faster cascade',
      '🗑️ Delete individual device activity records',
      '🗑️ Delete individual ElevenLabs TTS game usage entries',
      '📱 Activity log session path text wrapping fix',
    ]
  },
  {
    version: '5.9.0',
    date: '2026-03-11',
    changes: [
      '🎙️ TTS prompt refined — prioritize dynamic game stats over personal facts',
      '📅 Period marker detection uses next game night date instead of today',
      '🔇 Removed auto-announce timer from live game',
    ]
  },
  {
    version: '5.8.9',
    date: '2026-03-11',
    changes: [
      '💸 Settlement blocked transfers — prevent specific player-to-player payments',
    ]
  },
  {
    version: '5.8.8',
    date: '2026-03-11',
    changes: [
      '☁️ Pending forecast cloud sync between devices',
      '📊 Combo history insights deduplication and refinements',
      '🌐 Hebrew labels for graph period selectors',
      '🎮 Larger social action buttons in live game',
      '📱 Activity log device display cleanup',
    ]
  },
  {
    version: '5.8.7',
    date: '2026-03-19',
    changes: [
      '📋 Game summary screen cleanup and refinements',
    ]
  },
  {
    version: '5.8.6',
    date: '2026-03-19',
    changes: [
      '🔊 TTS engine major upgrade — improved voice quality and reliability',
      '⚙️ Settings TTS configuration and testing panel',
      '🎮 Live game TTS refinements',
    ]
  },
  {
    version: '5.8.5',
    date: '2026-03-19',
    changes: [
      '🔊 Edge TTS integration for higher quality Hebrew voice',
      '⚙️ Settings screen overhaul with improved layout and controls',
      '🎮 Live game cleanup and refinements',
      '📊 Statistics and graphs minor fixes',
    ]
  },
  {
    version: '5.8.4',
    date: '2026-03-18',
    changes: [
      '🤖 Background AI processing for game-end summaries',
      '📊 AI usage tracker enhancements with detailed metrics',
      '🔊 TTS engine improvements and reliability fixes',
      '🎮 Live game and game summary UI refinements',
      '📝 Dev server port 3000 documented in project rules',
    ]
  },
  {
    version: '5.8.3',
    date: '2026-03-18',
    changes: [
      '📊 AI usage tracker — monitor Gemini API calls and token consumption',
      '⚙️ Settings screen enhancements and AI usage dashboard',
    ]
  },
  {
    version: '5.8.2',
    date: '2026-03-18',
    changes: [
      '🔧 Storage, AI, and UI refinements across screens',
    ]
  },
  {
    version: '5.8.1',
    date: '2026-03-18',
    changes: [
      '🎙️ Enhanced TTS — Hebrew ordinals, construct forms, and richer rebuy announcements',
      '🏆 Record tracking — once-per-session announcements for personal and group rebuy records',
      '⏱️ AI progress bar component with timing estimates',
      '🎭 Player traits and gender-aware Hebrew throughout live game',
      '📊 2026 stats scoping for TTS pool generation',
      '🔧 AI model display names and timing instrumentation',
    ]
  },
  {
    version: '5.8.0',
    date: '2026-03-17',
    changes: [
      '🎙️ AI TTS pool — pre-generated contextual voice messages during live games',
      '🎭 Player traits system — personality-based commentary and reactions',
      '🏆 Rebuy records tracking with personal and group records',
      '📣 Social actions — bad beat and big hand announcements',
      '🎪 Awards ceremony at game end',
      '🔄 Cursor rules migrated to .mdc format with AGENTS.md',
    ]
  },
  {
    version: '5.7.3',
    date: '2026-03-16',
    changes: [
      '🔍 Device fingerprinting — GPU, canvas hash, and hardware info for activity tracking',
      '📱 Activity log redesigned with device-grouped view and profiles',
    ]
  },
  {
    version: '5.7.2',
    date: '2026-03-16',
    changes: [
      '🏠 Refined location insights and AI prompt improvements',
    ]
  },
  {
    version: '5.7.1',
    date: '2026-03-16',
    changes: [
      '🏠 Location insights — per-player performance analysis by game location',
      '🤝 Combo history UI polish — improved layout with date headers and color-coded results',
      '📍 Location data integrated into game summary AI narratives',
    ]
  },
  {
    version: '5.7.0',
    date: '2026-03-16',
    changes: [
      '📊 AI graph insights — trend analysis and narratives on the graphs screen',
      '🤝 Combo history — track results for specific player group combinations',
      '📱 Activity logger — session tracking with device info and screen visits',
      '🎯 Unified surprise system — code-controlled, tighter thresholds, max 2 per forecast',
      '📄 Forecast pages split to 4 players each for better readability',
      '💬 H2H storylines rewritten with accurate profit-gap language',
      '📋 Game summary collapsible sections and deep-link navigation',
      '🔊 TTS only on game end, not when browsing history',
    ]
  },
  {
    version: '5.6.0',
    date: '2026-03-15',
    changes: [
      '📖 Player chronicles — AI-generated per-player stories on statistics screen',
      '🏷️ Period markers — auto-detect and manually tag first/last game of month, half, year',
      '🎭 Pre-game teaser — AI narrative before the game starts',
      '🏆 Milestones engine refactored into dedicated module with new categories',
      '🤖 Gemini model cascade updated — Gemini 3 Flash + 3.1 Flash Lite',
      '📊 Statistics screen overhaul with chronicle sharing and period filtering',
      '🎮 New game screen: location and period type selectors',
      '📜 Game summary deep-linking from statistics and history',
    ]
  },
  {
    version: '5.5.3',
    date: '2026-03-13',
    changes: [
      '⚠️ AI summary error handling with user-friendly Hebrew messages',
      '📜 History screen button layout and styling improvements',
    ]
  },
  {
    version: '5.5.2',
    date: '2026-03-13',
    changes: [
      '🔄 Regenerate AI summary button for admins on game summary screen',
      '🔮 Robust forecast algorithm — median-based magnitude with group-level clamping',
      '📜 History screen UI enhancements with action buttons',
    ]
  },
  {
    version: '5.5.1',
    date: '2026-03-13',
    changes: [
      '🔊 TTS engine refactored into dedicated module with Hebrew number pronunciation',
      '🧮 Optimized settlement algorithm for fewer transfers',
      '🎙️ AI summary caching fix — regenerates truncated summaries',
      '📉 Graphs & Statistics screens cleanup and streamlining',
      '🎮 LiveGame screen simplified with shared TTS utility',
    ]
  },
  {
    version: '5.5.0',
    date: '2026-03-13',
    changes: [
      '🤖 AI game night summary with head-to-head storylines and group narratives',
      '📊 Half-year standings table on game summary screen',
      '☁️ Restore from cloud backup button in settings',
      '🔮 Simplified forecast algorithm — cleaner direction + magnitude logic',
      '⚡ Smart deploy: data syncs no longer trigger Vercel rebuilds',
      '💾 Training sync reduced to once every 3 days with minimum threshold',
    ]
  },
  {
    version: '5.4.2',
    date: '2026-03-12',
    changes: [
      '🔄 Training UI refinements and prompt improvements',
    ]
  },
  {
    version: '5.4.1',
    date: '2026-03-11',
    changes: [
      '⚡ Quick Training mode — fast text-based poker quiz with batch generation',
      '🗺️ Table position map — visual seating layout with position labels',
      '🇮🇱 Full Hebrew localization for all scenario categories and AI prompts',
      '🃏 Card validation — duplicate/invalid card detection in generated hands',
      '📝 Improved AI prompt with stricter card-context consistency rules',
    ]
  },
  {
    version: '5.4.0',
    date: '2026-03-11',
    changes: [
      '🎯 Poker Training — AI-powered training scenarios tailored to your table dynamics',
      '🧠 24 scenario categories covering draws, hand strength, bet sizing, reads, and structure',
      '📊 Training progress tracking with accuracy trends, session history, and weak spot detection',
      '☁️ Training data cloud sync to GitHub (admin only)',
      '🔧 Fix FullBackupData type mismatch in cloud sync',
      '🧹 Remove unused handlePlayerTypeChange from Settings',
    ]
  },
  {
    version: '5.2.6',
    date: '2026-02-26',
    changes: [
      '🐛 Fix Insights blank screen — variable used before definition',
      '🔊 Fix rebuy sound stopping after multiple rebuys — reuse AudioContext',
      '🎤 Added 80+ new rebuy voice messages for variety',
      '🖥️ Fix all dropdown menus for PC — explicit colors for dark theme',
      '🎨 Redesign Impact cards (With vs Without) — cleaner modern layout',
      '🎭 Redesign "Moments of the Night" — single line per row, card style',
      '🧹 Remove redundant arrows from impact badges',
    ]
  },
  {
    version: '5.2.0',
    date: '2026-02-26',
    changes: [
      '🎙️ TTS game summary announcement — winner & loser announced when game ends',
      '📊 Pot milestone TTS — announces when total buyins cross 5/10/15/20+ milestones',
      '🏆 Last man standing — announces the last player still on their first buyin',
      '🎯 Improved quick rebuy messages — personalized with player stats',
      '📋 Game highlights redesign — combines multiple players per line, exactly 10 highlights',
      '🔥 Streaks simplified to 4+ only, hot & cold combined in one line',
      '🎯 Upsets merged into single highlight (win & loss together)',
      '👑 Rebuy King & Comeback thresholds raised to 5+ buyins',
      '🧹 Removed unused state, fixed all lint warnings in GameSummaryScreen',
    ]
  },
  {
    version: '5.1.0',
    date: '2026-02-05',
    changes: [
      '🎭 Highlights now match assigned angle (no more repetitive "פורמה" for everyone)',
      '📊 Stat cards label rankings clearly (⭐ period table vs all-time) to prevent AI confusion',
      '🚫 Stronger no-negative-numbers rule + post-processing strips negative ₪ amounts from sentences',
      '🎯 Rankings instruction: AI only says "מוביל" if player is actually #1 in period table',
      '⚡ Surprise flag only when forecast is +40₪ or more',
      '🔙 Comeback threshold lowered from 30 to 20 days',
    ]
  },
  {
    version: '5.0.0',
    date: '2026-02-05',
    changes: [
      '🤖 AI Forecast Complete Overhaul - AI generates both profit prediction AND narrative sentences',
      '📝 Rich prompt with structured stat cards, role, rules, good/bad examples in Hebrew',
      '🎭 Unique narrative angle per player (streak, ranking battle, comeback, milestone, form, veteran, dark horse)',
      '⚡ Quality-first model order: gemini-2.5-flash > 2.0-flash > lite variants',
      '🎨 Higher creativity settings (temperature 0.7, topK 40, topP 0.95)',
      '🧹 Removed 300+ lines of code-generated sentence templates',
      '🛡️ Fallback sentence from stat card if AI returns empty/short response',
      '✅ Code-generated highlights kept for factual accuracy',
    ]
  },
  {
    version: '4.63.0',
    date: '2026-02-05',
    changes: [
      '📊 Every sentence now includes 2-3 real stats (ranking, win%, average, profit)',
      '🎯 Stat-rich sentence filter: prefers sentences with 3+ numbers over generic ones',
      '🚫 Removed all generic filler sentences (no more "X games of experience" without stats)',
      '🔗 Forecast correlation now includes win%, ranking, and period average',
    ]
  },
  {
    version: '4.61.0',
    date: '2026-02-05',
    changes: [
      '🔗 Forecast correlation: Sentence tone matches AI prediction (optimistic/cautious)',
      '🚫 No redundancy: Forecast number not repeated in sentences - just matching tone',
      '✅ Tested on 8 real permanent players (ליאור, אייל, ארז, אורן, ליכטר, סגל, תומר, פיליפ)',
      '📊 99% pass rate: Statistics accuracy verified against real player data',
    ]
  },
  {
    version: '4.60.0',
    date: '2026-02-05',
    changes: [
      '💪 Encouraging tone: All sentences focus on potential and comeback, not losses',
      '🚫 No negative records: Removed all mentions of loss amounts and negative totals',
      '🎯 Smart conditionals: Sentences only show positive stats when they exist',
      '😊 Adult humor: Light, encouraging tone without being childish',
      '📊 99% quality pass rate: Deep tested across 10 player scenarios',
    ]
  },
  {
    version: '4.59.0',
    date: '2026-02-05',
    changes: [
      '🎰 MASSIVE variety: 10-26 sentence options per player (tested across 12 scenarios)',
      '📊 100% factual: Every sentence includes real numbers - averages, streaks, profits, rankings',
      '🔥 New sentence types: win rate, streak momentum, milestone proximity, ranking gaps',
      '♀️ Gender-correct: Proper Hebrew for male/female players throughout',
      '✨ Unique highlights: Priority-based selection ensures no two players get same highlight',
      '🎯 AI simplified: Only predicts profit - all sentences generated with verified statistics',
    ]
  },
  {
    version: '4.58.0',
    date: '2026-02-05',
    changes: [
      '📊 Rich sentences: Every sentence now includes actual statistics (averages, profits, rankings)',
      '🎯 Highlight improvement: Shows most important fact with numbers (streak, last game, rank gap, etc.)',
      '📈 Context-aware: Sentences include period stats, historical comparison, gaps to other players',
      '🔢 Examples: "3 נצחונות ברצף! ממוצע +45₪ ב-5 משחקים אחרונים. מי יעצור אותו?"',
    ]
  },
  {
    version: '4.48.0',
    date: '2026-02-05',
    changes: [
      '⏪ Rollback: Restored v4.43.9 AI prompt (proven working version)',
      '🗑️ Removed experimental code-generated sentences',
      '✅ Back to AI-generated content with proper constraints',
    ]
  },
  {
    version: '4.46.0',
    date: '2026-02-05',
    changes: [
      '🎨 Rewrite: Clean AI prompt with few-shot examples',
      '✨ Creative: AI generates engaging highlight + sentence',
      '📊 Clear data: Clean player stats format for AI',
      '🌡️ Temperature 0.9 for varied, creative output',
      '💾 Backup: v4.43.9 saved as geminiAI.backup.v4.43.9.ts',
    ]
  },
  {
    version: '4.45.0',
    date: '2026-02-05',
    changes: [
      '🏗️ Major: 100% code-generated sentences - AI only balances profits',
      '✨ Diverse: 7 unique sentence patterns based on player index',
      '🎯 Accurate: All facts computed in code, not AI interpretation',
      '🚀 Faster: Simplified AI prompt, reduced token usage',
    ]
  },
  {
    version: '4.44.3',
    date: '2026-02-05',
    changes: [
      '🇮🇱 Hebrew: WON/LOST → רווח/הפסד',
      '✅ Pre-built highlight + sentence (no duplication)',
      '🎨 7 unique patterns with separate highlight and sentence',
      '📝 AI just polishes, not generates'
    ]
  },
  {
    version: '4.44.2',
    date: '2026-02-05',
    changes: [
      '🐛 FIX: Switch statement instead of arrow functions array',
      '✅ Safer pattern selection - no minification issues',
      '🔧 Added null safety for periodGames'
    ]
  },
  {
    version: '4.44.1',
    date: '2026-02-05',
    changes: [
      '🎨 CODE generates 7 different sentence patterns per player index',
      '✅ AI just polishes the pre-built sentences - variety guaranteed',
      '📝 Each player gets unique opening based on position',
      '🔧 Sentences built in code, not by AI interpretation'
    ]
  },
  {
    version: '4.44.0',
    date: '2026-02-05',
    changes: [
      '🔧 REFACTOR: Pre-computed fact sheets - AI copies exact phrases',
      '✅ Ranking phrase pre-built in code (מוביל only for #1)',
      '📝 Simplified prompt - AI assembles, not interprets',
      '🎯 Temperature 0.7 for accuracy with variety'
    ]
  },
  {
    version: '4.43.11',
    date: '2026-02-22',
    changes: [
      '🎰 Rebuy Stats table in Statistics page (avg, total, max, invested, ROI)',
      '🔢 Rebuy sentences now match announced total buyins count',
      '🗑️ Removed redundant/confusing rebuy sentences'
    ]
  },
  {
    version: '4.43.10',
    date: '2026-02-05',
    changes: [
      '🔧 Temperature 0.95 → 0.9 to reduce hallucinations',
      '✅ highlight and sentence must match (same ranking/facts)',
      '🚫 Stricter rule: use only facts from data, don\'t invent'
    ]
  },
  {
    version: '4.43.9',
    date: '2026-02-05',
    changes: [
      '🎲 Random seed + player order in prompt for unique outputs each run',
      '🔥 Temperature 0.85 → 0.95 for maximum variety',
      '✅ Each forecast request now truly different'
    ]
  },
  {
    version: '4.43.8',
    date: '2026-02-05',
    changes: [
      '🚨 CRITICAL: Each sentence MUST start with different word',
      '✍️ Explicit opening patterns per player (1-7)',
      '🎨 Stronger variety enforcement in prompt'
    ]
  },
  {
    version: '4.43.7',
    date: '2026-02-05',
    changes: [
      '🔧 Single game says "במשחק היחיד" not "ממוצע"',
      '🔢 Whole numbers only (no decimals)',
      '📈 Trend must show comparison: historical X₪ vs recent Y₪'
    ]
  },
  {
    version: '4.43.6',
    date: '2026-02-05',
    changes: [
      '🎨 Forecast sentence variety: 7 different opening patterns',
      '🎲 Temperature 0.6 → 0.85 for more creative variety between runs',
      '✅ Positive prompt instructions instead of "don\'t do" rules'
    ]
  },
  {
    version: '4.43.5',
    date: '2026-02-05',
    changes: [
      '🔧 FIX: Ranking now uses GLOBAL half-year ranking (matches visible table)',
      '✅ Uses rank among ALL active players, not just tonight\'s players',
      '✅ Shows "X שחקנים פעילים" when using global rank',
      '✅ Falls back to tonight\'s players ranking if global not available'
    ]
  },
  {
    version: '4.43.4',
    date: '2026-02-05',
    changes: [
      '🔧 FIX: Now uses CURRENT PERIOD (H1/H2) not just year',
      '✅ H1 2026 = Jan-Jun, H2 2026 = Jul-Dec',
      '✅ If no games in current half, falls back to previous half WITH NOTE',
      '✅ Player data shows period label (e.g., "H1 2026")',
      '✅ If using previous period, marked as "(מתקופה קודמת)"'
    ]
  },
  {
    version: '4.43.3',
    date: '2026-02-05',
    changes: [
      '🔧 CRITICAL FIX: "Recent" now means CURRENT YEAR (matches visible table!)',
      '✅ No more confusion: AI uses 2026 games only for averages',
      '✅ Player data shows all current year games, not "last 5"',
      '✅ Suggestion calculation uses current year performance',
      '✅ Surprise detection uses current year vs all-time comparison'
    ]
  },
  {
    version: '4.43.2',
    date: '2026-02-05',
    changes: [
      '📊 FORECAST RANGE FIX: Predictions now more meaningful (±50-150₪ typical)',
      '✅ Amplified predictions by 2.5x for realistic game swings',
      '✅ Minimum threshold: ±25₪ (no more +1₪ predictions)',
      '🎲 SURPRISE FIX: Now only for players with bad history + good recent form',
      '✅ Surprise always means POSITIVE prediction (unexpected win)',
      '✅ Surprise player boosted to at least +50₪'
    ]
  },
  {
    version: '4.43.0',
    date: '2026-02-05',
    changes: [
      '🔄 COMPLETE PROMPT REWRITE - clean, focused, Hebrew-first',
      '📈 Trend analysis now HIGH PRIORITY with clear Hebrew labels',
      '✅ Player data in Hebrew, concise format',
      '✅ Clear rules: tone matching, specific facts required',
      '✅ Fixed: no more "הלילה" (using "השחקנים")',
      '✅ Fixed: comeback players properly marked',
      '❌ Removed: redundant rules, confusing English/Hebrew mix'
    ]
  },
  {
    version: '4.42.5',
    date: '2026-02-05',
    changes: [
      '📈 Added TREND ANALYSIS: AI compares recent vs all-time performance',
      '✅ IMPROVING: "history bad but recent good" → optimistic forecast',
      '✅ DECLINING: "usually good but recent slump" → cautious forecast',
      '✅ Player data now shows both recent avg AND all-time avg for comparison',
      '✅ AI instructed to mention trend contrasts in sentences'
    ]
  },
  {
    version: '4.42.4',
    date: '2026-02-05',
    changes: [
      '🔧 CRITICAL: Enforced 3-way alignment between expectedProfit, highlight, and sentence',
      '✅ Added explicit alignment table: positive profit → optimistic text',
      '✅ Added forbidden combinations to prevent contradictions',
      '✅ isSurprise=true now requires POSITIVE expectedProfit',
      '✅ Added verification checklist at end of prompt'
    ]
  },
  {
    version: '4.42.3',
    date: '2026-02-05',
    changes: [
      '🔧 Fixed: Restored critical prompt rules lost in over-optimization',
      '✅ "DON\'T mention expectedProfit number in sentence" rule restored',
      '✅ Tone/profit correlation enforced (positive→optimistic, negative→hopeful)',
      '✅ Current ranking (2026) made more prominent, all-time only if notable',
      '✅ Player data restructured - clearer hierarchy',
      '❌ No more highlighting big losses'
    ]
  },
  {
    version: '4.42.2',
    date: '2026-02-05',
    changes: [
      '✅ Fixed: Comeback players now mentioned (was missing)',
      'Prompt optimized: ~60% shorter, clearer structure',
      'Player data more compact but complete'
    ]
  },
  {
    version: '4.41.5',
    date: '2026-02-05',
    changes: [
      '✅ Fixed Hebrew text - changed "/משחק" to "למשחק" (proper Hebrew grammar)',
      'Applied to all milestone descriptions'
    ]
  },
  {
    version: '4.41.4',
    date: '2026-02-05',
    changes: [
      '✅ Fixed "2026 מתחילה" milestone showing incorrectly after games were played',
      'New year milestone now only shows in January with 0-1 games played',
      'Added "Early Year Leader" milestone for Jan/Feb with actual 2026 standings'
    ]
  },
  {
    version: '4.41.3',
    date: '2026-02-05',
    changes: [
      '✅ Fixed forecast tone mismatch - sentence now matches prediction direction',
      '✅ Fixed milestone deduplication - same player no longer appears twice as main subject',
      'Strengthened AI prompt rules for tone/prediction alignment'
    ]
  },
  {
    version: '4.41.2',
    date: '2026-02-05',
    changes: [
      '✅ Fixed Vercel caching - mobile will now always get latest version',
      'Added cache-busting headers to vercel.json'
    ]
  },
  {
    version: '4.41.1',
    date: '2026-02-05',
    changes: [
      '✅ Fixed milestone distance rounding (no more decimal values like 69.75₪)',
      'Added comprehensive validation scripts for all features',
      'All 49 validation tests passing at 100%'
    ]
  },
  {
    version: '4.41.0',
    date: '2026-02-05',
    changes: [
      '✅ Major AI forecast improvements - optimized prompts for accuracy and engagement',
      '✅ Completely rewrote milestone/insight generation with 7 professional categories',
      'New categories: battles, streaks, milestones, form, drama, records, season',
      'Smart deduplication ensures diverse, high-quality insights (5-8 per game)',
      'Implemented GlobalRankingContext for precise active player rankings (33% threshold)',
      'Improved Hebrew text quality with punchy titles and exact statistics'
    ]
  },
  {
    version: '4.40.46',
    date: '2026-01-19',
    changes: [
      '✅ CRITICAL: Hall of Fame 2026 now uses SAME data as Season Podium 2026',
      'Fixed: Current year was being calculated twice with different thresholds',
      'Now guaranteed to show identical names for current year in both sections'
    ]
  },
  {
    version: '4.40.45',
    date: '2026-01-19',
    changes: [
      '✅ Season Podium now shows ALL player types (highest profit regardless of type)',
      'Both Hall of Fame and Season Podium now rank by profit only, not player type',
      'Fixed: Season Podium was incorrectly filtering to permanent players only'
    ]
  },
  {
    version: '4.40.44',
    date: '2026-01-19',
    changes: [
      '✅ Reverted v4.40.43 - Hall of Fame correctly shows ALL player types',
      'Hall of Fame = historical records (all players), Season Podium = competition (permanent only)',
      'Real fix from v4.40.42: proper data loading and name updates from current state'
    ]
  },
  {
    version: '4.40.42',
    date: '2026-01-19',
    changes: [
      '✅ PROPER FIX: Added initial data load on mount + storage change listener',
      'Fixed: podiumData was calculating with empty players array on first render',
      'Fixed: No listener for GitHub sync storage changes - data never reloaded',
      'Now Hall of Fame recalculates with correct data on mount and after syncs'
    ]
  },
  {
    version: '4.40.41',
    date: '2026-01-19',
    changes: [
      '✅ REAL FIX: Hall of Fame now uses players STATE instead of calling getAllPlayers()',
      'The memo was fetching stale data from storage instead of using React state',
      'Now correctly shows current player names matching Season Podium'
    ]
  },
  {
    version: '4.40.40',
    date: '2026-01-19',
    changes: [
      '✅ CRITICAL FIX: Hall of Fame now recalculates when player data changes',
      'Fixed podiumData useMemo to depend on players state instead of empty array',
      'This ensures Hall of Fame shows current player names after syncs/updates'
    ]
  },
  {
    version: '4.40.39',
    date: '2026-01-19',
    changes: [
      '🔍 Added debug logging to compare Season Podium vs Hall of Fame calculations',
      'Identified root cause: useMemo was returning stale cached data'
    ]
  },
  {
    version: '4.40.38',
    date: '2026-01-19',
    changes: [
      '🔍 Enhanced debugging: Now showing all database players at podium calculation time',
      'Check console to see player database state vs what Hall of Fame shows'
    ]
  },
  {
    version: '4.40.37',
    date: '2026-01-19',
    changes: [
      '🐛 Debug version: Added console logging to diagnose Hall of Fame name issue',
      'Check browser console (F12) to see if player names are being updated'
    ]
  },
  {
    version: '4.40.36',
    date: '2026-01-19',
    changes: [
      '🔧 Fixed Season Podium (H1/H2/Yearly) showing incorrect player names',
      '📊 Fixed Biggest Wins leaderboard showing historical names instead of current names',
      'All player name displays now use current database names across the app',
      'Complete fix for player name consistency in all statistics sections'
    ]
  },
  {
    version: '4.40.35',
    date: '2026-01-19',
    changes: [
      '🏆 Fixed Hall of Fame displaying incorrect player names',
      'Player names now always show current database names, not historical game record names',
      'Affects all years in Hall of Fame table including 2026',
      'Ensures name changes are reflected correctly in historical records'
    ]
  },
  {
    version: '4.40.34',
    date: '2026-01-19',
    changes: [
      '✨ Unified Leaders section format to match other record sections',
      'Leaders now display in 2-column grid layout with center alignment',
      '🔧 Fixed Best Avg/Game sign handling - now correctly shows + or - based on value',
      'Consistent visual styling across all record sections'
    ]
  },
  {
    version: '4.40.33',
    date: '2026-01-19',
    changes: [
      '📊 Statistics records now align with applied filters',
      'Removed minimum games requirement for win rate records',
      'Removed minimum games requirement for average profit records',
      'Fixed Hebrew translation: Buyin King record now shows "רכישות" instead of "כל המשחקים"',
      'All records now respect your selected time period filters'
    ]
  },
  {
    version: '4.40.32',
    date: '2026-01-05',
    changes: [
      '🔊 Voice notification on Undo rebuy!',
      'When you undo a rebuy, you hear: "ביטול. [שם] מינוס אחד. סך הכל [X]"',
      'Same Hebrew voice as rebuy announcements',
      'Works for both full and half buyins'
    ]
  },
  {
    version: '4.40.31',
    date: '2026-01-05',
    changes: [
      '👋 Remove player after game started!',
      'If a player doesn\'t show up, click ✕ to remove them',
      'Only works before they rebuy (initial buyin only)',
      'Admin-only feature with confirmation dialog',
      'No more stuck with missing players!'
    ]
  },
  {
    version: '4.40.30',
    date: '2026-01-04',
    changes: [
      '🧹 Milestone DEDUPLICATION - no more repetition!',
      'Each player appears in max 2 milestones',
      'Each theme (streak, form, comeback) only once',
      'Hot streak + Form comparison = picks best one only',
      'Reduced from 10 to 8 max milestones (quality > quantity)',
      'Smarter theme detection to avoid similar messages'
    ]
  },
  {
    version: '4.40.29',
    date: '2026-01-04',
    changes: [
      '🗑️ Removed chatbot feature',
      'Cleaner app without the chat button'
    ]
  },
  {
    version: '4.40.26',
    date: '2026-01-04',
    changes: [
      '🌟 DRAMATIC MILESTONES - The stories that matter!',
      '"מהפסיד למנצח" - player who usually loses but just won!',
      '"מנצח לנפגע" - star player who unexpectedly lost',
      '"מלחמת הרצפים" - hot streak vs cold streak clash',
      '"הרים רוסיים" - biggest swings in recent games',
      '"המקום האחרון עולה" - bottom player showing comeback',
      '"המוביל מאבד אחיזה" - leader losing momentum',
      '2025 champion: First week only (high priority), second week (low), then GONE!',
      'Focus on current dynamics, not old history!'
    ]
  },
  {
    version: '4.40.25',
    date: '2026-01-04',
    changes: [
      '🤖 ULTIMATE POKER CHATBOT!',
      '⚔️ Head-to-head: "X נגד Y" - full rivalry stats',
      '😈 Nemesis: "מי הנמסיס של X?" - who beats you most',
      '🎯 Victim: "מי הקורבן של X?" - who you beat most',
      '📈 Trends: "מי משתפר?" - who is improving/declining',
      '🏠 Location stats: "מי מנצח אצל X?" - performance by venue',
      '🎢 Volatility: "מי הכי תנודתי?" - consistent vs wild players',
      '👥 Lineups: "מי משחק הכי הרבה ביחד?" - common pairs',
      '🔮 Predictions: "תחזית להערב" - smart betting tips',
      '💬 Follow-ups: "ומה איתו?" - remembers context',
      'AI gets enhanced data: trends, h2h, locations',
      '30+ new question patterns supported!'
    ]
  },
  {
    version: '4.40.24',
    date: '2026-01-04',
    changes: [
      '🔥 Streaks now span across years!',
      'Win in Dec 2025 + Win in Jan 2026 = 2-game streak',
      'AI forecasts use the TRUE continuous streak',
      'Milestones correctly show cross-year streaks',
      'Fact-checking uses actual streak (not year-limited)',
      'More accurate streak reporting in all views'
    ]
  },
  {
    version: '4.40.23',
    date: '2026-01-04',
    changes: [
      '📅 Chatbot now understands DATE-BASED questions!',
      '"מי ניצח בנובמבר?" - who won in November',
      '"מה היה לפני חודש?" - what happened a month ago',
      '"כמה משחקים היו ב-2025?" - games count in 2025',
      '"תוצאות בדצמבר" - December results',
      'Supports Hebrew & English month names',
      'Supports: לפני חודש, לפני שבוע, החודש, השנה',
      'Filters ALL games by date range automatically'
    ]
  },
  {
    version: '4.40.22',
    date: '2026-01-04',
    changes: [
      '💬 Smarter chatbot fallback - never says "I don\'t understand"',
      'Unknown questions now show interesting facts instead of error',
      'Added 10+ more question patterns (average, win rate, summary, predictions)',
      '"עזרה" / "help" shows what you can ask',
      '"סיכום" shows quick group overview',
      '"על מי להמר?" gives fun prediction based on streaks',
      '"עובדות מעניינות" shows fun stats',
      'Always gives useful info, even for unexpected questions'
    ]
  },
  {
    version: '4.40.21',
    date: '2026-01-04',
    changes: [
      '🔍 AI Forecast FACT-CHECKING system!',
      'Auto-detects and corrects wrong streak claims (e.g., "4 wins" when actually 1)',
      'Auto-detects and corrects wrong game counts (e.g., "2 games in Jan" when 1)',
      'Replaces broken/incorrect sentences with factual fallbacks',
      'Fixes Hebrew patterns like "רצף X נצחונות" and "X משחקים בינואר"',
      'Logs all corrections to console for debugging',
      'No more AI hallucinations in forecast text!'
    ]
  },
  {
    version: '4.40.20',
    date: '2026-01-04',
    changes: [
      '💬 BULLETPROOF Chatbot - always works!',
      'Smart local answers for 20+ question types',
      'AI enhancement when available (not required)',
      'No more "can\'t connect" errors - graceful fallback',
      'Questions about: last game, players, leaderboard, records, streaks',
      'Works offline with local data intelligence',
      'Timeout handling and retry logic for AI',
      'Better loading animation'
    ]
  },
  {
    version: '4.40.19',
    date: '2026-01-04',
    changes: [
      '🎯 MUCH more dynamic milestones in New Game!',
      'NEW: "Last Game Hero" - who won last time?',
      'NEW: "Looking for Comeback" - redemption stories',
      'NEW: "Hot Form" / "Cold Form" - recent performance vs average',
      'NEW: Monthly position changes - who is climbing?',
      'NEW: Fun rotating facts that change by day',
      'REMOVED: Static "Consistency King" (same player every week)',
      'REDUCED: "2025 Champion" priority after first 2 weeks of January',
      'IMPROVED: Half-year leader only high priority if close race'
    ]
  },
  {
    version: '4.40.18',
    date: '2026-01-04',
    changes: [
      '🎯 MUCH better player insights for low-data periods!',
      'Single game: Dramatic, engaging sentences with personality',
      'Two games: Pattern-based narratives (streak detection, comebacks)',
      '3 unique sentences per player even with 1-2 games',
      'Fun predictions, comparisons, and call-to-actions',
      'No more boring "Player won X in his only game" statements',
      'Hebrew insights with variety and humor'
    ]
  },
  {
    version: '4.40.17',
    date: '2026-01-04',
    changes: [
      '🤖 MAJOR: Complete AI chatbot rewrite!',
      'Now uses TRUE natural language understanding - ask ANYTHING',
      'AI receives ALL your data: every game, every player, every stat',
      'No more pattern matching - AI understands context and nuance',
      'Ask in Hebrew or English, get answers in Hebrew',
      'Examples: "מי הכי מצליח בחצי שנה האחרונה?", "תספר לי על ליאור"',
      '"מי ניצח הכי הרבה פעמים?", "איפה שיחקנו לאחרונה?"',
      'Beautiful new chat UI with purple theme',
      'Dynamic suggested questions based on your data'
    ]
  },
  {
    version: '4.40.16',
    date: '2026-01-04',
    changes: [
      '💬 Chat is now a floating button (bottom-right corner)',
      'Cleaner navigation bar - back to 5 icons',
      '🔧 MAJOR FIX: Chatbot now actually works!',
      'Answers questions about last game location, who finished last, who won',
      'Supports Hebrew questions about players, leaderboard, records',
      'Much better question understanding and responses',
      'Improved header text in chat modal'
    ]
  },
  {
    version: '4.40.15',
    date: '2026-01-04',
    changes: [
      '🔧 FIX: Navigation bar - all 6 icons now fit on screen',
      'Reduced icon and text size for compact navigation',
      'Settings icon visible again alongside Chat icon'
    ]
  },
  {
    version: '4.40.14',
    date: '2026-01-21',
    changes: [
      '🐛 FIX: Player profile sentences for low data (1-2 games)',
      'Removed meaningless generic statements for players with few games',
      'Now shows simple factual statements: "Player won/lost X in game"',
      'For 2 games: Shows both results clearly',
      'Complex analysis only appears for 5+ games',
      'Much more meaningful and accurate profiles'
    ]
  },
  {
    version: '4.40.13',
    date: '2026-01-21',
    changes: [
      '💬 NEW: AI Chatbot feature!',
      'Ask questions in natural language about players, games, and statistics',
      'Uses local data for answers - works offline',
      'AI enhancement available when Gemini API key is configured',
      'Smart fallback: local answers when AI unavailable',
      'Accessible from navigation menu',
      'Supports questions about wins, losses, streaks, leaderboards, and more'
    ]
  },
  {
    version: '4.40.12',
    date: '2026-01-04',
    changes: [
      '🎯 Milestones: Focus on recent insights and interesting findings',
      'Removed repetitive consistency/stability milestone (always same player)',
      'Reduced routine "leader is leading" messages when gap is large',
      'Added recent form changes milestone (improving/declining trends)',
      'Added pattern-breaking milestone (players breaking their usual pattern)',
      'Streak milestones now only show current active streaks, not old records',
      'Focus on current period dynamics instead of historical champions'
    ]
  },
  {
    version: '4.40.11',
    date: '2026-01-04',
    changes: [
      '🎯 Milestones: Fixed leaderboard battles to use actual overall rankings',
      'Milestones now only show "can pass" when both players are actually adjacent in overall ranking',
      'Prevents incorrect milestones when filtered players skip over missing players',
      'Uses actual rank numbers from all players, not just filtered set',
      'Podium battles and close battles also check overall ranking positions'
    ]
  },
  {
    version: '4.40.10',
    date: '2026-01-04',
    changes: [
      '🤖 AI Forecast: Fixed streak calculation for year-specific periods',
      'Streaks now calculated only from games in the current year (2026)',
      'Prevents incorrect "2-game streak in 2026" when only 1 game played',
      'Year-specific streak shown in CURRENT YEAR section of AI prompt',
      'All-time streaks still shown separately in ALL-TIME section'
    ]
  },
  {
    version: '4.40.9',
    date: '2026-01-04',
    changes: [
      '👤 Player Profiles: Improved low-data scenarios (1-2 games)',
      'Lowered thresholds for player classification and narrative generation',
      'Player profiles now show meaningful insights even with 1 game',
      'Style classification works with single games (profitable/losing/average)',
      'Sentences focus on available data instead of requiring many games'
    ]
  },
  {
    version: '4.40.8',
    date: '2026-01-04',
    changes: [
      '🔧 Streaks: Break-even games (0 profit) now break streaks',
      'Games ending with 0 profit reset both win and loss streaks',
      'Affects current streaks, longest streaks, and milestone calculations',
      'Consistent behavior across Statistics, Graphs, and AI Forecast'
    ]
  },
  {
    version: '4.40.7',
    date: '2026-01-04',
    changes: [
      '🎯 Milestones: Improved low-data scenarios (1-2 games)',
      'Lowered thresholds for milestones when period has few games',
      'Added simple milestones that work with 1 game (leader, winner, close battles)',
      'Focus on available data instead of "no data" messages',
      'Milestones now meaningful even in early periods of the year'
    ]
  },
  {
    version: '4.40.6',
    date: '2026-01-04',
    changes: [
      '🎯 Milestones: Added variety to consistency/stability descriptions',
      'Consistency milestone now has 5 different description variations',
      'Each player gets a consistent but unique description (based on name hash)',
      'Fixes repetitive "עקביות מרשימה" sentence for stable players like Lior'
    ]
  },
  {
    version: '4.40.5',
    date: '2026-01-04',
    changes: [
      '🤖 AI Forecast: Improved sentence quality',
      'AI no longer redundantly mentions profit numbers (already shown in header)',
      'Sentences now focus on stats, streaks, milestones, and interesting stories',
      'Fixed mismatch issue - AI warned not to mention numbers that don\'t match expectedProfit'
    ]
  },
  {
    version: '4.40.4',
    date: '2026-01-04',
    changes: [
      '📊 Graphs: Aligned filters UI to match Statistics screen',
      'Combined filters into single card with consistent styling',
      'Time period filter now matches Statistics exactly',
      'Player filter matches Statistics layout and behavior'
    ]
  },
  {
    version: '4.40.3',
    date: '2026-01-04',
    changes: [
      '🔧 Fixed: Build error in StatisticsScreen (mismatched JSX tags)',
      'Fixed Vercel deployment issue - removed extra closing fragment tag',
      'Build now succeeds successfully'
    ]
  },
  {
    version: '4.40.2',
    date: '2026-01-04',
    changes: [
      '📊 Statistics: Removed player type filter (redundant with active players filter)',
      'All player types now included by default',
      'Cleaner, simpler filter interface'
    ]
  },
  {
    version: '4.40.1',
    date: '2026-01-04',
    changes: [
      '📊 Statistics: Filters now always visible even with no data',
      'Can change time period when selected period has no games',
      'Helpful message in Hebrew when no stats for selected period'
    ]
  },
  {
    version: '4.40.0',
    date: '2025-12-28',
    changes: [
      '🔄 New MemberSync role (PIN: 0852)',
      'Has all Member permissions plus automatic cloud sync',
      'Uses embedded token - no configuration needed',
      'Games sync to GitHub automatically when finished'
    ]
  },
  {
    version: '4.39.12',
    date: '2025-12-28',
    changes: [
      '🍕 Compact shared expenses box in rebuy screen',
      'Reduced padding, smaller fonts, tighter layout'
    ]
  },
  {
    version: '4.39.11',
    date: '2025-12-28',
    changes: [
      '🍕 Show full expense details in settlement table',
      'Displays description, amount, payer and eaters for each expense'
    ]
  },
  {
    version: '4.39.10',
    date: '2025-12-28',
    changes: [
      '🍕 Added legend for pizza icons in settlements',
      'Big pizza = שילם (paid), Small pizza = אכל (ate)'
    ]
  },
  {
    version: '4.39.9',
    date: '2025-12-28',
    changes: [
      '🍕 Expense display shows payer and eater names',
      'Big pizza icon for payer, small for eaters',
      'Hebrew labels: שילם (paid), אכלו (ate)'
    ]
  },
  {
    version: '4.39.8',
    date: '2025-12-28',
    changes: [
      '🍕 Compact expense modal - fits on one screen',
      'Description and amount on same row',
      'Smaller buttons and reduced spacing'
    ]
  },
  {
    version: '4.39.7',
    date: '2025-12-28',
    changes: [
      '📊 Historical periods: Insights now show past tense for completed periods',
      'H1 2024, Year 2023 etc. show "סיים במקום ראשון" not "האם יצליח?"',
      'Skips speculative milestones (passing, approaching milestones) for history',
      'Current periods still show future-oriented language'
    ]
  },
  {
    version: '4.39.6',
    date: '2025-12-28',
    changes: [
      '🍕 Settlement icons: Big pizza next to food buyer name',
      'Small pizza icon next to food eaters',
      'Easy to see who paid for food vs who ate'
    ]
  },
  {
    version: '4.39.5',
    date: '2025-12-28',
    changes: [
      '🔀 Combined settlements: Poker + Expenses in ONE transfer list!',
      'No more separate expense settlements - all merged together',
      'Minimizes number of transfers between players',
      'Poker profit/loss still shown separately in results table',
      'Settlements header shows (+ 🍕) when expenses are included'
    ]
  },
  {
    version: '4.39.4',
    date: '2025-12-28',
    changes: [
      '✏️ Shared Expenses: Edit existing expenses',
      'Click the pencil icon to modify any expense',
      'Update description, amount, payer, or participants'
    ]
  },
  {
    version: '4.39.3',
    date: '2025-12-28',
    changes: [
      '🔙 AI Forecast: Added "comeback after absence" indicator',
      'Shows when player returns after 30/60/90+ days',
      'AI can mention long breaks in forecast sentences'
    ]
  },
  {
    version: '4.39.2',
    date: '2025-12-28',
    changes: [
      '🍕 Simplified expense modal: default is "פיצה", free text for other'
    ]
  },
  {
    version: '4.39.1',
    date: '2025-12-28',
    changes: [
      '🔧 Fixed AI forecast accuracy: now shows explicit last game result to prevent AI from making up data',
      'Added "LAST GAME: WON/LOST X₪" to each player in AI prompt',
      'Made factual accuracy the #1 writing rule for AI',
      'Added strong warnings against AI inventing win/loss data'
    ]
  },
  {
    version: '4.39.0',
    date: '2025-12-28',
    changes: [
      '🍕 NEW: Shared Expenses feature!',
      'Track food/pizza purchases during games',
      'Mark who paid and who participated',
      'Cost split equally among participants',
      'Separate from poker profit/loss calculations',
      'Shows in settlement with clear indication',
      'Visible in game summary, details, and history'
    ]
  },
  {
    version: '4.38.22',
    date: '2025-12-28',
    changes: [
      '📅 AI Prompt: Focus on YEAR/HALF, not all-time!',
      'Reordered player data: Year → Half → Recent → All-time',
      'Added Current Half (H1/H2) stats for each player',
      'Fixed: Streak of 1 now says "Won/Lost last game" not "streak"',
      'All-time section marked as "only for dramatic milestones"',
      'Added rule 6: Focus on current year/half in sentences'
    ]
  },
  {
    version: '4.38.21',
    date: '2025-12-28',
    changes: [
      '🎲 AI Prompt: Pre-select surprise candidates!',
      'Added TL;DR with 5 key rules at top of prompt',
      'Surprise players now pre-calculated and named in prompt',
      'AI told exactly who to mark as surprise',
      'Simplified surprise instructions (was 10 lines, now 2)'
    ]
  },
  {
    version: '4.38.20',
    date: '2025-12-28',
    changes: [
      '🧹 AI Prompt: Removed redundancy and simplified!',
      'Removed player dynamics/rivalries section (low impact)',
      'Removed duplicate accuracy warnings',
      'Consolidated sentence matching rules',
      'Prompt is now ~20% shorter and clearer'
    ]
  },
  {
    version: '4.38.19',
    date: '2025-12-28',
    changes: [
      '🎲 AI Forecast: Added MANDATORY surprise requirement!',
      'AI must now include at least 1 surprise prediction',
      'Added examples of when to use surprises',
      'Maximum 35% of players can be surprises'
    ]
  },
  {
    version: '4.38.18',
    date: '2025-12-28',
    changes: [
      '🤖 AI Forecast: Major improvements!',
      'Added SUGGESTED expected profit to guide AI',
      'AI now uses 70% recent + 30% overall weighting',
      'Added RECENT FORM section with trend indicator',
      'Lowered AI temperature from 0.75 to 0.6 (more accurate)',
      'AI told to stay close to suggested profits (±30₪)'
    ]
  },
  {
    version: '4.38.17',
    date: '2025-12-28',
    changes: [
      '🎯 Forecast: Major accuracy improvements!',
      'Reduced random variance (was ±₪20, now ±₪10)',
      'Increased recent weight (70% recent, 30% overall)',
      'Stronger streak modifiers (up to 50% bonus/penalty)',
      'Adjusted thresholds based on actual player data',
      'Guaranteed 1 surprise if eligible players exist',
      'Increased max surprises from 25% to 35%'
    ]
  },
  {
    version: '4.38.16',
    date: '2025-12-28',
    changes: [
      '🎙️ Voice: Quick rebuy now says ONLY the quick message (not both)'
    ]
  },
  {
    version: '4.38.15',
    date: '2025-12-28',
    changes: [
      '📍 Moved location to display next to date in History cards'
    ]
  },
  {
    version: '4.38.14',
    date: '2025-12-28',
    changes: [
      '🎙️ Voice: Fixed Hebrew numbers to feminine forms (אחת, שתיים, שלוש...)',
      '🔊 Sound: Added AudioContext resume for suspended state fix'
    ]
  },
  {
    version: '4.38.13',
    date: '2025-12-28',
    changes: [
      '📍 Location is now mandatory to start a game',
      '📍 Game location now displayed in History cards',
      '🔧 Updated Dec 27 game location to "ליאור"'
    ]
  },
  {
    version: '4.38.12',
    date: '2025-12-28',
    changes: [
      '🎙️ Voice: Added more rebuy sentences',
      '1st rebuy: +4 new encouraging messages',
      '2nd rebuy: +4 new positive messages',
      '3rd rebuy: +4 new mild concern messages'
    ]
  },
  {
    version: '4.38.11',
    date: '2025-12-28',
    changes: [
      '🎙️ Voice: Updated quick rebuy messages',
      'Changed "מהר חזרו" to "תנשום קצת בין הקניות"',
      'Changed "עוד פעם? כבר?" to "תזכור שזה על כסף אמיתי"'
    ]
  },
  {
    version: '4.38.10',
    date: '2025-12-28',
    changes: [
      'Hall of Fame: Now includes ALL player types who were active in each year',
      'Activity = played at least 20% of games in the period (min 3 games)',
      'Guests who played a lot in 2023 will appear in 2023 Hall of Fame'
    ]
  },
  {
    version: '4.38.9',
    date: '2025-12-28',
    changes: [
      'Hall of Fame: Now shows only permanent players (same as Season Podium)',
      'Guests and occasional players excluded from Hall of Fame'
    ]
  },
  {
    version: '4.38.8',
    date: '2025-12-28',
    changes: [
      '🐛 FIX: Hall of Fame and Season Podium now show current player names',
      'Was using old names from game records, now uses current player names',
      'Fixed for both Season Podium (permanent) and Hall of Fame (all players)'
    ]
  },
  {
    version: '4.38.7',
    date: '2025-12-28',
    changes: [
      '🎙️ Voice: Fixed all rebuy sentences to be gender-neutral',
      'Voice: Changed "קנה" to "עוד" for natural female voice',
      'Voice: Removed all male "אתה" forms from sentences',
      'Voice: Improved Hebrew pronunciation with better spelling',
      'Voice: Natural female voice settings (rate 0.9, pitch 1.0)'
    ]
  },
  {
    version: '4.38.6',
    date: '2025-12-28',
    changes: [
      'UI: Removed + signs from Season Podium and Hall of Fame for cleaner look'
    ]
  },
  {
    version: '4.38.5',
    date: '2025-12-28',
    changes: [
      '🏅 Hall of Fame: Fixed to show ALL players (not just permanent)',
      'No player type filter - shows the absolute best performers',
      'Reduced min games threshold to 20% (min 3 games) for qualification'
    ]
  },
  {
    version: '4.38.4',
    date: '2025-12-28',
    changes: [
      '🥇🥈🥉 Hall of Fame: Now shows top 3 places for each period',
      'Shows 1st, 2nd, and 3rd place winners for H1, H2, and Full Year',
      'Each place shows player name with their profit'
    ]
  },
  {
    version: '4.38.3',
    date: '2025-12-28',
    changes: [
      '📤 Hall of Fame: Added screenshot sharing button',
      'Share "היכל התהילה" table to WhatsApp'
    ]
  },
  {
    version: '4.38.2',
    date: '2025-12-28',
    changes: [
      'Hall of Fame now includes current year (2025)',
      'Automatically adds new years - in 2026 it will show 2026, 2025, etc.'
    ]
  },
  {
    version: '4.38.1',
    date: '2025-12-28',
    changes: [
      '🏅 NEW: Hall of Fame - Historical champions table showing H1, H2, and Yearly winners',
      'Covers all years from 2021 to present in one view',
      'Clean table layout with champions and their winning profits'
    ]
  },
  {
    version: '4.38.0',
    date: '2025-12-28',
    changes: [
      '🏆 NEW: Season Podium showing top 3 players for H1, H2, and Full Year',
      'Podium is independent of filters - always shows current year standings',
      'Share podium as screenshot to WhatsApp',
      'Beautiful visual design with medals and colored sections'
    ]
  },
  {
    version: '4.37.11',
    date: '2025-12-25',
    changes: [
      'UI: Fixed last 6 games display to show the actual latest games'
    ]
  },
  {
    version: '4.37.10',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Player games modal now shows ALL games (was limited to 20)',
      '🐛 FIX: Rebuy data correctly hidden for "All Time" view (mixed pre-2026 data)',
      'Added scrollable container for player games modal',
      'Comprehensive regression testing completed'
    ]
  },
  {
    version: '4.37.9',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Player Insights now shows ALL players (was limited to 10)',
      'ליכטר and any other players beyond 10 will now appear'
    ]
  },
  {
    version: '4.37.8',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Double minus sign in recovery/loser milestones',
      '🐛 FIX: Group games milestone now correctly shows "participations" not "games"',
      'Tested milestone logic across different periods and player combinations'
    ]
  },
  {
    version: '4.37.7',
    date: '2025-12-25',
    changes: [
      'UI: Fixed menu cards to fit container properly with minWidth:0 and consistent sizing'
    ]
  },
  {
    version: '4.37.6',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Duplicate milestones showing same player battles',
      'Added deduplication logic - same player pair now only appears in ONE milestone',
      'Champion battle, Leaderboard battles, Podium battle, and Close battle tracked'
    ]
  },
  {
    version: '4.37.5',
    date: '2025-12-25',
    changes: [
      'UI: Limit player stats to show only last 6 games (display only)'
    ]
  },
  {
    version: '4.37.4',
    date: '2025-12-25',
    changes: [
      'UI: Aligned menu card sizes across Statistics, Graphs, and Settings screens'
    ]
  },
  {
    version: '4.37.3',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Null safety for empty player list',
      'Fixed: Potential crash when no players have data'
    ]
  },
  {
    version: '4.37.2',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Critical bugs in milestones and player profiles',
      'Fixed: biggestLoss was treated as positive but is stored as negative',
      'Fixed: Comeback King milestone now correctly identifies players with big losses',
      'Fixed: Volatility display now shows correct negative loss values',
      'Fixed: Player profile sentences now correctly format loss amounts',
      'Fixed: Array mutation bug in most games calculation',
      'Fixed: Record sentences now handle edge cases properly'
    ]
  },
  {
    version: '4.37.1',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Build error - duplicate variable declaration',
      'Fixed: currentMonth was declared twice in milestones section',
      'Vercel deployment should now succeed'
    ]
  },
  {
    version: '4.37.0',
    date: '2025-12-25',
    changes: [
      '🏷️ PLAYER STYLES: Completely rewritten for clarity!',
      'Removed abstract "כריש" style - now uses clear labels',
      'Removed misleading "מאוזן" for losing players',
      'NEW: רווחי (Profitable), מפסיד (Losing), חם (Hot), קר (Cold)',
      'NEW: תנודתי (Volatile), יציב (Stable), משתפר (Improving), יורד (Declining)',
      'NEW: מתקשה (Struggling) for negative players instead of "balanced"',
      'Streak-based styles (חם/קר) take priority when on 3+ streak',
      'Each style now clearly reflects player performance'
    ]
  },
  {
    version: '4.36.0',
    date: '2025-12-25',
    changes: [
      '🎯 MILESTONE VARIETY: Added 8 more milestone types! (Now 20 total)',
      'NEW: Win rate milestone (approaching 60%)',
      'NEW: Biggest loser (struggling player)',
      'NEW: Volatility king (biggest swings)',
      'NEW: Group total games milestone',
      'NEW: Longest win streak record holder',
      'NEW: Close battle (30₪ or less gap)',
      'NEW: Iron player (most games played)',
      'NEW: Best average profit',
      'All 20 milestones sorted by priority, top 8 shown'
    ]
  },
  {
    version: '4.35.0',
    date: '2025-12-25',
    changes: [
      '🏆 DRAMATIC MILESTONES: End-of-year/half-year special titles!',
      'NEW: "אלוף שנת 2025?" with dramatic end-of-year messaging',
      'NEW: "אלוף H2?" for half-year championships',
      'Exciting questions: "האם מישהו יצליח לעקוף אותו?"',
      'Restored 150-200₪ gap thresholds for more milestone variety',
      'NEW: "מרדף על מקום 2!" for podium battles',
      'All milestones now ask dramatic questions',
      'Rebuy data still only for 2026+'
    ]
  },
  {
    version: '4.34.0',
    date: '2025-12-25',
    changes: [
      '🔧 REBUY DATA: Only used for 2026+ (data collection started late 2025)',
      'Player styles using rebuys only apply when viewing 2026+ data',
      'Rebuy sentences only shown for 2026+ timeframes',
      '🎯 REALISTIC MILESTONES: Gap thresholds reduced to 80₪ max',
      'Only show "can pass" if gap is achievable in one game',
      'Fixed hardcoded player name in milestone title',
      'Recovery milestone reduced to 80₪ realistic gap',
      'Round number milestone reduced to 80₪ gap',
      '✅ Data accuracy improvements across all filters'
    ]
  },
  {
    version: '4.33.0',
    date: '2025-12-25',
    changes: [
      '🎨 PLAYER STYLES: Completely rewritten multi-factor classification!',
      'NEW STYLES: כריש, מהמר, רכבת הרים, שמרן, יעיל, מנצל הזדמנויות, לוחם',
      'Classification uses: win rate, avg profit, rebuys, volatility, win/loss ratio',
      '📝 NARRATIVE VARIETY: 60+ unique sentences in 12 categories!',
      'Categories: Champions, Big Winners, Unlucky, Strugglers, Streaks, Rebuys, etc.',
      'Each player gets different sentences - no more repetitive feedback',
      'Sentences include actual data: rebuys, exact profits, streaks, recent form',
      'Random selection from pools ensures variety on each view'
    ]
  },
  {
    version: '4.32.0',
    date: '2025-12-25',
    changes: [
      '🎯 INSIGHTS REDESIGN: Milestones now have creative variety!',
      'NEW: Champion title battles, recovery stories, consistency kings',
      'NEW: Biggest win records, comeback kings, player of the period',
      'Milestones sorted by priority - most interesting shown first',
      '👤 PLAYER PROFILES: Replaced split boxes with flowing narrative',
      'Each player gets 2-3 natural sentences describing their performance',
      'Narrative includes stats, streaks, playing style, and suggestions',
      'Much cleaner and more readable player summaries'
    ]
  },
  {
    version: '4.31.4',
    date: '2025-12-25',
    changes: [
      '🐛 MAJOR FIX: No more duplicate milestones!',
      'FIXED: Lose streaks - only worst player shown',
      'FIXED: Recovery to positive - only closest to 0 shown',
      'FIXED: Year-end redemption - only best candidate shown',
      'FIXED: Hot year - only biggest improvement shown',
      'FIXED: Round numbers - only closest player shown',
      'FIXED: Win rate 60% - only best candidate shown',
      'FIXED: Volatility - only most volatile shown',
      'FIXED: Consistency - only most consistent shown',
      'All milestone categories now show ONE best candidate only'
    ]
  },
  {
    version: '4.31.3',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Lose streak duplicates removed!',
      'Now only shows ONE lose streak milestone (the worst one)',
      'Removed redundant Section 21 (covered by Section 2)',
      'Section 12 (comeback) only triggers for exactly -2 streaks',
      '26 tests now pass including new lose streak test'
    ]
  },
  {
    version: '4.31.2',
    date: '2025-12-25',
    changes: [
      '🧪 COMPREHENSIVE TEST SUITE: 25 tests across 8 categories!',
      'NEW: Duplicate prevention tests (record chase, streaks)',
      'NEW: Data integrity tests (zero values, rankings, negative profits)',
      'NEW: Forecast accuracy tests (year vs all-time, streak validation)',
      'All tests pass - milestone logic verified and working correctly'
    ]
  },
  {
    version: '4.31.1',
    date: '2025-12-25',
    changes: [
      '🐛 FIX: Duplicate milestones removed!',
      'Record-breaking milestones now show only 1 candidate (the best one)',
      'Fixed: Players with 0 wins no longer appear in record chase',
      'Section 11 and 19 now complement each other (no overlap)',
      'Cleaner milestone list with no repetition'
    ]
  },
  {
    version: '4.31.0',
    date: '2025-12-25',
    changes: [
      '🎯 NEW: Insights tab in Statistics page!',
      'Shows potential milestones based on selected filters',
      'Player profiles with playing style analysis',
      'Strengths, weaknesses, and personalized suggestions',
      'Stats-driven insights: volatility, consistency, trends',
      'All filters (period, player type) apply to insights'
    ]
  },
  {
    version: '4.30.0',
    date: '2025-12-25',
    changes: [
      '🎆 NEW: "Fresh Start" milestones for new year/half!',
      'Shows "שנת 2026 מתחילה!" when year has few games',
      'Shows "H2 מתחיל!" when half has few games',
      'All-time milestones still show when year/half is empty',
      'Graceful handling of empty period data',
      'All 20 tests passing!'
    ]
  },
  {
    version: '4.29.0',
    date: '2025-12-25',
    changes: [
      '🗓️ YEAR TRANSITION: Automatic handling of 2025→2026!',
      '🏆 NEW: "2025 Final Results" summary in January',
      '🥈🥉 NEW: Shows who finished 2nd, 3rd last year',
      '📊 NEW: "H1 Final Results" summary in July',
      'All dates/years calculated dynamically (no hardcoding)',
      'All 20 tests still passing!'
    ]
  },
  {
    version: '4.28.0',
    date: '2025-12-25',
    changes: [
      '📊 NEW: H2 (Half-Year) tracking milestones!',
      '🏆 NEW: Year-end special milestones (December)!',
      '⏰ NEW: "Last chance for 2025" battles',
      '🎢 NEW: Volatility alerts for big-swing players',
      '👑 NEW: Half-year leader highlights',
      '⚔️ NEW: Historical rivalry detection',
      '🎊 NEW: Group total games milestones',
      'All 20 tests passing!'
    ]
  },
  {
    version: '4.27.0',
    date: '2025-12-25',
    changes: [
      '🧪 EXTENSIVE TEST SUITE: 20+ tests across 6 categories',
      '🐛 FIX: AI forecast now also converts dates to DD/MM/YYYY',
      'Test categories: Streaks, Year Profits, Leaderboard, Round Numbers, Games, Dates',
      'Added verifyPlayerData() for individual player inspection',
      'Run window.runAllTests() in console to verify all logic',
      'Each test shows severity: critical/high/medium/low'
    ]
  },
  {
    version: '4.26.0',
    date: '2025-12-25',
    changes: [
      '🐛 CRITICAL: Game history was limited to 6 games - now includes ALL games!',
      'This was causing wrong year profit calculations (missing games)',
      'Comprehensive test suite added (14 tests)',
      'Date parsing improved to handle slashes, dots, and ISO formats',
      'Added verifyForecastData() function for data inspection',
      'Run window.testMilestones() in console to verify'
    ]
  },
  {
    version: '4.25.0',
    date: '2025-12-25',
    changes: [
      '🐛 CRITICAL BUG FIX: Date format mismatch causing wrong year profits!',
      'Fixed: Dates were formatted with dots (25.12.2025) but parser expected slashes (25/12/2025)',
      'parseGameDate now handles both dot and slash formats',
      'Milestone dates now explicitly use DD/MM/YYYY format',
      'Year table milestones require 5+ games (was 2)',
      'Added test suite for milestone accuracy verification'
    ]
  },
  {
    version: '4.24.1',
    date: '2025-12-25',
    changes: [
      '🔍 DEBUG: Added logging for year profit calculations',
      'Year table milestones now require 5+ games (was 2)',
      'Investigating Tomer year profit discrepancy'
    ]
  },
  {
    version: '4.24.0',
    date: '2025-12-25',
    changes: [
      '🎨 MAJOR: Mandatory sentence variety - no more boring repetition!',
      'BANNED: "במקום ה-X הכללי" as sentence opener',
      'Each player MUST start with a different style (name+verb, question, stat, metaphor, etc.)',
      '7 distinct opening patterns enforced in prompt',
      'Examples rewritten to show variety (rivalry, milestone, comeback, metaphor)',
      'AI must read all sentences aloud before submitting to check similarity'
    ]
  },
  {
    version: '4.23.1',
    date: '2025-12-25',
    changes: [
      '🎯 Tomer fix: Be kind but NEVER invent positive facts!',
      'Removed "optimistic" instruction that caused false data',
      'Milestones: 7-10 interesting ones only (not forced 10)',
      'Removed boring filler milestones (player stats, year summaries)',
      'Only show milestones with priority 50+ (truly interesting)',
      'Priority threshold ensures quality over quantity'
    ]
  },
  {
    version: '4.23.0',
    date: '2025-12-25',
    changes: [
      '🚨 CRITICAL ACCURACY FIX - Complete rewrite!',
      'Added YEAR stats section for each player (games, profit, avg)',
      'Added explicit RANK field for each player',
      'Added HUGE accuracy warning with common errors to avoid',
      'Examples: dont claim streaks that dont exist!',
      'Examples: dont say #1 wants to reach first place!',
      'Examples: dont mix year profit with all-time!',
      'Verification checklist before each sentence',
      'Clearer data formatting with headers'
    ]
  },
  {
    version: '4.22.0',
    date: '2025-12-25',
    changes: [
      '📸 Milestones: Split into multiple screenshots (5 per page)',
      '🎯 More accurate milestones - no false record claims!',
      'Removed "שיא קבוצתי" claims (only current player data)',
      'Added player stats (rank, total, avg, win%) as fallback',
      'Added year performance summaries for each player',
      'Added personal best records (factual)',
      'Guaranteed 10 milestones with accurate data'
    ]
  },
  {
    version: '4.21.1',
    date: '2025-12-25',
    changes: [
      '🚨 EVERY number in forecast must have context!',
      'Must specify: בטבלה הכללית / בטבלת 2025 / החודש',
      'Examples: "2000₪ בטבלה הכללית", "ממוצע -7₪ (כל הזמנים)"',
      'Forbidden: vague references like "רף ה-2000₪" without table',
      'AI prompt now has strict rules with wrong/right examples',
      'Fixes: Lior 2000₪, Erez 500₪, Lichter -7₪ context issues'
    ]
  },
  {
    version: '4.21.0',
    date: '2025-12-25',
    changes: [
      '📝 Much longer, clearer milestone descriptions!',
      'Every milestone specifies WHICH TABLE (כללית/שנתית/חודשית)',
      'Full context: current position, exact amounts, what needs to happen',
      'Explains why milestone matters and what it means',
      'Game milestones include player stats summary',
      'All sentences are now detailed and informative'
    ]
  },
  {
    version: '4.20.4',
    date: '2025-12-25',
    changes: [
      '🔤 Milestones: RTL Hebrew alignment (right-to-left)',
      '🔢 Clean numbers only - no decimals (87.5 → 88)',
      '🎯 Always show exactly 10 most interesting milestones',
      'All profit values rounded with Math.round()',
      'Better Hebrew text flow in milestone cards'
    ]
  },
  {
    version: '4.20.3',
    date: '2025-12-25',
    changes: [
      '📝 Clarified: No need to repeat profit number in sentence',
      'Focus on interesting story (streaks, milestones, rivalries)',
      'Only use number if it adds value to the point',
      'But IF you use a number → must match exactly',
      'Better examples showing story-focused sentences'
    ]
  },
  {
    version: '4.20.2',
    date: '2025-12-25',
    changes: [
      '🔢 NUMBER MATCH: If sentence mentions profit, must equal expectedProfit!',
      'Header shows +100 → sentence must say +100 (not +70)',
      'Added clear examples of correct number matching',
      'Option to write sentence without profit number (stats/streaks)',
      'Double check: tone AND number must both match'
    ]
  },
  {
    version: '4.20.1',
    date: '2025-12-25',
    changes: [
      '🔗 CRITICAL: Sentence must match expectedProfit!',
      'Positive profit = positive/optimistic sentence',
      'Negative profit = cautious/warning sentence',
      'Added correlation examples in prompt',
      'Forbidden: contradicting tone vs prediction',
      'AI now has clear rules for matching sentiment'
    ]
  },
  {
    version: '4.20.0',
    date: '2025-12-25',
    changes: [
      '🎯 NEW: Dedicated Milestones Button!',
      'Orange "Milestones" button next to Forecast',
      'Shows top 7-10 most interesting highlights for tonight',
      'Share to WhatsApp as screenshot',
      'Includes: streaks, leaderboard races, close battles, records',
      'Round numbers, win rates, comebacks, and more!',
      'All milestones ranked by "interestingness"'
    ]
  },
  {
    version: '4.19.1',
    date: '2025-12-25',
    changes: [
      '🎯 10 MORE milestone types added!',
      '📅 Yearly participation: "10th game of 2025!"',
      '🎯 Win rate milestones: "One win from 60% win rate!"',
      '⚔️ Close battles: "Only 25₪ apart - tonight decides!"',
      '🚀 Jump positions: "Can jump 2 places with a big win!"',
      '🔄 Recovery: "Back to positive for the year with +80₪"',
      '🏆 Personal best month potential',
      '🤝 Exact ties: "Tied at +450₪ - tonight breaks it!"',
      '🎯 Attendance streaks: "5 of last 5 games!"',
      '📅 Monthly game counts: "3rd game this December!"'
    ]
  },
  {
    version: '4.19.0',
    date: '2025-12-25',
    changes: [
      '🎯 Multi-timeframe milestones! Not just all-time anymore:',
      '📅 This Year leaderboard passing opportunities',
      '📊 This Half (H1/H2) rankings and milestones',
      '🗓️ Monthly "Player of the Month" competition',
      '📈 Form comparison: "Best year ever?" vs historical',
      '🎮 Games milestones: "50th game tonight!"',
      'All milestones labeled clearly with timeframe'
    ]
  },
  {
    version: '4.18.2',
    date: '2025-12-25',
    changes: [
      '📊 Clearer milestone descriptions with explicit context!',
      'All milestones now specify "ALL-TIME" or "בסך הכל"',
      'Leaderboard shows current rank and exact amounts',
      'Examples show correct vs incorrect milestone phrasing',
      'AI instructed to always clarify what numbers mean'
    ]
  },
  {
    version: '4.18.1',
    date: '2025-12-25',
    changes: [
      '🎰 NEW: 20 random casino sounds for rebuys!',
      'Hero Returns, Monster Pot, All-In Victory, Ship It!',
      'Chip sounds, jackpot celebrations, money drops',
      'Different sound plays randomly each rebuy'
    ]
  },
  {
    version: '4.18.0',
    date: '2025-12-25',
    changes: [
      '🎯 NEW: Milestones & Records at Stake!',
      '📈 Leaderboard passing: "If X wins +80₪, they\'ll pass Y!"',
      '🔥 Streak records: "One more win = new group record!"',
      '💰 Round numbers: "Only 65₪ from crossing 1000₪ all-time!"',
      '⚠️ Danger zones: "Close to dropping below -500₪!"',
      '💪 Comeback tracking: "3 losses but still +400₪ overall"',
      'AI now weaves milestones into sentences automatically!'
    ]
  },
  {
    version: '4.17.2',
    date: '2025-12-25',
    changes: [
      '📊 Shows AI the ACTUAL game statistics (avg profit, median, etc.)',
      '📋 Shows recent game examples to AI (how games REALLY end)',
      '✅ Hard constraints: minimum profit values, spread requirements',
      '❌ Explicit wrong vs correct examples for profit ranges'
    ]
  },
  {
    version: '4.17.1',
    date: '2025-12-25',
    changes: [
      '🎯 Realistic profit ranges - based on actual game history!',
      '💚 Special handling for Tomer - always optimistic and encouraging',
      '🚫 Stronger anti-repetition rules - each player gets unique angle',
      'Calibrated expectedProfit to each player\'s historical range'
    ]
  },
  {
    version: '4.17.0',
    date: '2025-12-25',
    changes: [
      '🤖 AI Forecast v3.0 - New English prompt with Legacy Factor!',
      'All-Time Records included: profit leader, biggest win/loss, best win rate',
      'Cross-references current form with historical records',
      'The "Nemesis" angle - highlights player rivalries',
      'Data-Backed Insights - specific dates, percentages, amounts',
      'Output still in Hebrew, but AI reasons in English for better logic'
    ]
  },
  {
    version: '4.16.24',
    date: '2025-12-22',
    changes: [
      'Fixed: Statistics page blank due to code ordering issue'
    ]
  },
  {
    version: '4.16.23',
    date: '2025-12-22',
    changes: [
      'Top 20 Wins: Now filtered by time period and player types',
      'Shows timeframe label below the title'
    ]
  },
  {
    version: '4.16.22',
    date: '2025-12-22',
    changes: [
      'Graphs: Removed emoji from page title for consistency'
    ]
  },
  {
    version: '4.16.21',
    date: '2025-12-22',
    changes: [
      'Statistics: Compact sort dropdown + Gain/Loss toggle button',
      'Gain/Loss mode shows Total Gain and Total Loss columns',
      'Replaces Profit and Avg columns when enabled'
    ]
  },
  {
    version: '4.16.20',
    date: '2025-12-22',
    changes: [
      'Statistics: Sort option is now a dropdown selector',
      'Default sort is Profit, can select Games or Win%'
    ]
  },
  {
    version: '4.16.19',
    date: '2025-12-22',
    changes: [
      'Statistics: Combined sort buttons into single cycling button',
      'Click to cycle: Profit → Games → Win% → Profit'
    ]
  },
  {
    version: '4.16.18',
    date: '2025-12-21',
    changes: [
      'Voice: Reverted quick rebuy messages'
    ]
  },
  {
    version: '4.16.17',
    date: '2025-12-21',
    changes: [
      'Voice: Simplified quick rebuy message'
    ]
  },
  {
    version: '4.16.16',
    date: '2025-12-21',
    changes: [
      'Voice: Updated rebuy sentences per feedback'
    ]
  },
  {
    version: '4.16.15',
    date: '2025-12-21',
    changes: [
      'Graphs: Now accessible to both Admin and Member roles'
    ]
  },
  {
    version: '4.16.14',
    date: '2025-12-21',
    changes: [
      'H2H: Changed Big Win/Loss threshold from ₪200 to ₪150'
    ]
  },
  {
    version: '4.16.13',
    date: '2025-12-21',
    changes: [
      'Voice: Updated 1st rebuy sentences per feedback',
      'Voice: Fixed 3rd rebuy sentence'
    ]
  },
  {
    version: '4.16.12',
    date: '2025-12-21',
    changes: [
      'Voice: Rewrote all sentences to be complete, natural Hebrew phrases'
    ]
  },
  {
    version: '4.16.11',
    date: '2025-12-21',
    changes: [
      'H2H: Added legend to Play Style comparison (Big Win >₪200, etc.)'
    ]
  },
  {
    version: '4.16.10',
    date: '2025-12-21',
    changes: [
      'Voice: Quick rebuy threshold changed from 10 min to 5 min'
    ]
  },
  {
    version: '4.16.9',
    date: '2025-12-21',
    changes: [
      'Voice: Messages now based on REBUY count (not total buyins)',
      'Voice: First rebuy = first rebuy message (was off by one)',
      'Voice: Simplified all Hebrew sentences - short and natural'
    ]
  },
  {
    version: '4.16.8',
    date: '2025-12-21',
    changes: [
      'Fixed: Graphs blank screen (moved streak calculation after dependencies)'
    ]
  },
  {
    version: '4.16.7',
    date: '2025-12-21',
    changes: [
      'Sound: Changed to "ching-ching" coin sound (like cash register)',
      'Display: Rebuy counter now shows 1.5, 2.5, etc properly!',
      'Voice: Now says "קנה אחד" for 1 buyin'
    ]
  },
  {
    version: '4.16.6',
    date: '2025-12-21',
    changes: [
      'Fixed: H2H blank screen (restored cumulative comparison chart)',
      'Profit: Added 🔥 Streaks & Recent Form visualization',
      'Shows current streak, best/worst streaks, last 5 game results (W/L/T)'
    ]
  },
  {
    version: '4.16.5',
    date: '2025-12-21',
    changes: [
      'Voice: Changed back to "קָנָה" with niqqud for better pronunciation',
      'Voice: Updated all sentences per user feedback',
      'Voice: Fixed 0.5 counter display',
      'Voice: Improved sentence variety and tone'
    ]
  },
  {
    version: '4.16.4',
    date: '2025-12-21',
    changes: [
      'H2H: 🏆 Direct Battles - who outperforms whom more often',
      'H2H: 🔥 Recent Form - last 5 shared games results',
      'H2H: 📊 Play Style - session distribution (big/small wins/losses)',
      'H2H: 🎲 Volatility comparison - who is more consistent'
    ]
  },
  {
    version: '4.16.3',
    date: '2025-12-21',
    changes: [
      'Voice: Cash drawer opening sound (mechanical slide + click)',
      'Voice: Changed "קנה" to "נכנס" for better pronunciation',
      'Voice: Fixed 0.5 detection (floating point fix)',
      'Voice: Hebrew numbers for totals (אחד, שתיים, שלוש...)',
      'Voice: Lower pitch for male voice'
    ]
  },
  {
    version: '4.16.2',
    date: '2025-12-21',
    changes: [
      'Voice: Fixed half-buyin announcement (says "קנה חצי" properly)',
      'Voice: 3 cash register sound variations (ka-ching, coins, bell)',
      'Voice: Better Hebrew pronunciation, male voice preference',
      'Voice: Shorter, more natural sentences',
      'Voice: Total buyins spoken in Hebrew (אחד וחצי, שניים וחצי)'
    ]
  },
  {
    version: '4.16.1',
    date: '2025-12-21',
    changes: [
      'NEW: Monthly Profit bar chart in Graphs 📊',
      'Shows profit/loss per month with green/red bars',
      'Includes Best Month, Worst Month, and Average stats'
    ]
  },
  {
    version: '4.16.0',
    date: '2025-12-21',
    changes: [
      'NEW: Month filter in Statistics and Graphs 📅',
      'Filter data by specific month (in addition to H1/H2/Year)',
      'Select any month from any year for detailed analysis'
    ]
  },
  {
    version: '4.15.1',
    date: '2025-12-21',
    changes: [
      'Sync Protection: Only COMPLETED games are uploaded to cloud',
      'Incomplete/live games stay local and won\'t be synced',
      'Removed 7 stale incomplete games from cloud data'
    ]
  },
  {
    version: '4.15.0',
    date: '2025-12-21',
    changes: [
      '🤖 AI Forecast v2.0 - Complete prompt rewrite!',
      'Concrete good/bad examples for AI to learn from',
      'Player archetypes: Consistent, Volatile, Phoenix, Hunter...',
      'Emotional hooks: Every sentence must be share-worthy',
      'Lower temperature (0.75) for data-focused responses',
      'Simplified to 5 clear rules + inspiration section'
    ]
  },
  {
    version: '4.14.4',
    date: '2025-12-21',
    changes: [
      'H2H: Show shared games out of total games in selected period'
    ]
  },
  {
    version: '4.14.3',
    date: '2025-12-21',
    changes: [
      'Graphs: Removed tooltip completely for cleaner chart experience'
    ]
  },
  {
    version: '4.14.2',
    date: '2025-12-21',
    changes: [
      'Graphs: Fixed tooltip - now shows in a panel below the chart instead of overlaying it',
      'Graphs: Tap any point on the chart to see detailed values'
    ]
  },
  {
    version: '4.14.1',
    date: '2025-12-21',
    changes: [
      'Graphs: Removed Race chart (wasn\'t useful)',
      'Graphs: Added time period filter (H1/H2/Year/All)',
      'Graphs: Player names in legend match their line colors',
      'Graphs: Stable color assignment per player'
    ]
  },
  {
    version: '4.14.0',
    date: '2025-12-21',
    changes: [
      '🔄 NEW: Resume interrupted games!',
      'If app closes mid-game, see "המשך משחק" banner on home',
      'Auto-save chip counts during entry (no data loss!)',
      'Option to abandon incomplete game if needed',
      'Works for both Live Game and Chip Entry stages'
    ]
  },
  {
    version: '4.13.3',
    date: '2025-12-21',
    changes: [
      '💸 Settlements: NO more tiny transfers!',
      'Small creditors paid by larger debtors (both parts substantial)',
      'Example: תומר pays ספי ₪36 + אייל ₪84 (not סגל→ספי ₪30 + ₪6 split)',
      'All transfers now ≥ minTransfer threshold'
    ]
  },
  {
    version: '4.13.0',
    date: '2025-12-21',
    changes: [
      '🔮 NEW: Forecast flow redesigned!',
      'Forecast now only in New Game (before game starts)',
      'Pending forecast saved and linked to game',
      'Mismatch dialog when players change',
      'Option to update forecast or keep existing',
      'Forecast comparison shows at game end',
      'Removed forecast from Live Game (Rebuy page)'
    ]
  },
  {
    version: '4.11.9',
    date: '2025-12-18',
    changes: [
      'NEW: Top 20 Single Night Wins table 🏆',
      'Shows rank, player, amount, players count, date',
      'All-time records (no filter restrictions)',
      'Clickable rows to view game details',
      'Share button for screenshot'
    ]
  },
  {
    version: '4.11.8',
    date: '2025-12-18',
    changes: [
      'Live Game forecast: Split sharing like New Game 📱',
      '5 players per screenshot page',
      'Multiple images shared together for large groups'
    ]
  },
  {
    version: '4.11.6',
    date: '2025-12-18',
    changes: [
      'Forecast vs Reality: Compact table fits screen 📱',
      'Shorter column headers (Fcst, Real, Gap)',
      'Smaller fonts and tighter spacing',
      'AI summary always visible (shows loading or fallback)'
    ]
  },
  {
    version: '4.11.5',
    date: '2025-12-18',
    changes: [
      'Player stats: Fixed to show last 6 games (was 15)'
    ]
  },
  {
    version: '4.11.4',
    date: '2025-12-18',
    changes: [
      'Chip Count: Player name shown in numpad header 👤',
      'Green banner at top of numpad shows current player',
      'No auto-open on screen entry - you choose the player',
      'Fixed deployment caching issues'
    ]
  },
  {
    version: '4.11.3',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Final polished prompt 🎯',
      'Guidelines not strict rules - AI uses common sense',
      'Sentence 25-35 words - players will love to read & share',
      'Milestones, streaks, trend changes, volatility analysis',
      'Unique story for each player - unforgettable forecasts!'
    ]
  },
  {
    version: '4.11.2',
    date: '2025-12-18',
    changes: [
      'Forecast comparison: AI summary includes overall rating 📊',
      'Score system: Accurate=2pts, Close=1pt, Missed=0pts',
      'Rating levels: מעולה (≥80%), טוב (≥60%), סביר (≥40%), חלש (<40%)',
      'AI summary now includes the rating and key insights'
    ]
  },
  {
    version: '4.11.1',
    date: '2025-12-18',
    changes: [
      'Chip Count: User-controlled flow 🎰',
      'No auto-select on screen entry - you choose the player',
      'Numpad opens when YOU select a player',
      'Auto-advances through chip colors after each confirm',
      'After last chip OR Done button → back to player selection',
      'You choose the next player yourself'
    ]
  },
  {
    version: '4.11.0',
    date: '2025-12-18',
    changes: [
      'Forecast comparison: New gap-based accuracy 🎯',
      '✓ = Gap ≤30 (accurate), ~ = Gap 31-60 (close), ✗ = Gap >60 (missed)',
      'Gap column shows absolute distance only (no +/-)',
      'Legend added above comparison table',
      'AI summary: Relevant insights (not jokes)',
      'Forecast button: Admin only on Live Game screen'
    ]
  },
  {
    version: '4.10.8',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Balanced prompt - stats + creativity 📊',
      'expectedProfit now based on player historical average',
      'highlight must include specific numbers from data',
      'sentence creative but grounded in real statistics',
      'Proper weight to recent games performance'
    ]
  },
  {
    version: '4.10.7',
    date: '2025-12-18',
    changes: [
      'Forecast button on Live Game: Admin only 🔐',
      'Non-admin users won\'t see the forecast generation button',
      'Game summary works normally if no forecast was generated'
    ]
  },
  {
    version: '4.10.6',
    date: '2025-12-18',
    changes: [
      'NEW: Generate & Share Forecast from Live Game page 🔮',
      'Purple button at top of rebuy screen to generate AI forecast',
      'Can generate forecast anytime during the game',
      'Forecast is saved to game for later comparison',
      'Share directly to WhatsApp from the modal'
    ]
  },
  {
    version: '4.10.5',
    date: '2025-12-18',
    changes: [
      'NEW: Share forecast prompt when starting game 📤',
      'After clicking Start Game, prompts to share forecast first',
      'Forecast vs Reality now included in shared screenshots',
      'AI funny comment about accuracy in the screenshot',
      'Full flow: Share forecast → Play → Share results with comparison'
    ]
  },
  {
    version: '4.10.4',
    date: '2025-12-18',
    changes: [
      'NEW: Forecast vs Reality comparison at game end 🎯',
      'Shows table comparing predictions to actual results',
      'AI generates a short comment about forecast accuracy',
      'Direction accuracy displayed (✓/✗ per player)',
      'Forecasts are saved with the game when it starts'
    ]
  },
  {
    version: '4.10.3',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Smarter, cleaner prompt 🧠',
      'No more repetitive "loses to X" for every player',
      'Each player gets unique highlight - different angle',
      'Common sense: dominant player mentioned once, not everywhere',
      'Shorter, punchier sentences'
    ]
  },
  {
    version: '4.10.2',
    date: '2025-12-18',
    changes: [
      'Forecast screenshot: Fixed sort order (highest to lowest)',
      'Forecast screenshot: Shows minus sign for negative amounts',
      'Screenshot now matches on-screen display order'
    ]
  },
  {
    version: '4.10.1',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Rate limit countdown timer ⏳',
      'Shows 60-second countdown when rate limited',
      'Option to use static forecast while waiting',
      'Notifies when ready to retry'
    ]
  },
  {
    version: '4.10.0',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Player dynamics analysis 🤝',
      'Analyzes how players perform when playing TOGETHER',
      'Finds rivalries and patterns between specific players',
      'Sentences reference the actual group dynamics',
      'More game history (15 games) for better analysis'
    ]
  },
  {
    version: '4.9.9',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Enhanced creativity and variety 🎲',
      'Random seed + timestamp ensures different results each time',
      'Prompt emphasizes: surprise, originality, varied styles',
      'Never boring or repetitive - even with same players!'
    ]
  },
  {
    version: '4.9.8',
    date: '2025-12-18',
    changes: [
      'Data Fix: Corrected all player types (permanent/guest/occasional)',
      '11 permanent, 5 permanent_guest, 24 guest players',
      'Synced to all users via cloud sync'
    ]
  },
  {
    version: '4.9.7',
    date: '2025-12-18',
    changes: [
      'Forecast: Sorted by expected profit (highest first) 📊',
      'Winners at the top, losers at the bottom'
    ]
  },
  {
    version: '4.9.6',
    date: '2025-12-18',
    changes: [
      'Forecast: Split into multiple screenshots for many players 📸',
      '5 players per screenshot to fit WhatsApp better',
      'Page numbers shown when multiple screenshots (1/2, 2/2)',
      'All screenshots shared in one click'
    ]
  },
  {
    version: '4.9.4',
    date: '2025-12-18',
    changes: [
      'UI: Aligned medal positions across all tables 🏅',
      'Medals now appear AFTER player name everywhere',
      'Game Summary, Game Details, WhatsApp sharing - all consistent'
    ]
  },
  {
    version: '4.9.2',
    date: '2025-12-18',
    changes: [
      'Voice: Improved English voice - prefers female voices 🎙️',
      'Tries Samantha, Zira, Susan, Karen voices',
      'Console logs available voices for debugging',
      'Natural pace and pitch settings'
    ]
  },
  {
    version: '4.9.1',
    date: '2025-12-18',
    changes: [
      'Voice: Better English voice selection 🎙️',
      'Prefers Google/Enhanced/Premium voices',
      'Falls back to British English for clarity',
      'Pre-loads voices on page load'
    ]
  },
  {
    version: '4.9.0',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Complete API diagnostic rewrite',
      'First lists available models to verify API key access',
      'Tries v1beta AND v1 API versions',
      'Detailed troubleshooting in console'
    ]
  },
  {
    version: '4.8.11',
    date: '2025-12-18',
    changes: [
      'Voice: Hebrew name + English "buyin" 🗣️',
      'Player name spoken in natural Hebrew',
      'Action spoken in natural English ("buyin" / "half buyin")'
    ]
  },
  {
    version: '4.8.10',
    date: '2025-12-18',
    changes: [
      'Voice: Added alert chime before announcement 🔔',
      'Pleasant ding-dong sound to get attention',
      'Then speaks the player name + action'
    ]
  },
  {
    version: '4.8.9',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Auto-detects working Gemini model',
      'Tries: gemini-pro, gemini-1.5-pro, gemini-1.5-flash, gemini-1.0-pro',
      'Saves working model for future use',
      'Better error logging in console'
    ]
  },
  {
    version: '4.8.8',
    date: '2025-12-18',
    changes: [
      'Voice: Changed to natural Hebrew - "קנה" / "קנה חצי"',
      'Sounds better than English "buyin" transliteration'
    ]
  },
  {
    version: '4.8.7',
    date: '2025-12-18',
    changes: [
      'NEW: Voice announcement for buyins! 🔊',
      'Says player name + action in Hebrew',
      'Helps prevent mistakes during the game'
    ]
  },
  {
    version: '4.8.6',
    date: '2024-12-18',
    changes: [
      'Fixed: AI API model endpoint (was 404)',
      'Now using gemini-pro model'
    ]
  },
  {
    version: '4.8.5',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Dynamic profit range per player',
      'Based on player historical range (best win to worst loss)',
      'High variance players get more extreme forecasts',
      'Low variance players get moderate forecasts'
    ]
  },
  {
    version: '4.8.4',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Enhanced prompt with better rules',
      'Highlight now explains the REASON for the forecast',
      'Extra weight given to recent games',
      'Detects patterns: gaps, streaks, trend changes',
      'If forecast goes against history - mentions it'
    ]
  },
  {
    version: '4.8.3',
    date: '2025-12-18',
    changes: [
      'Screenshot: Reverted to original vertical layout on screen',
      'Share now sends 2 separate images (Results + Settlements)',
      'Both images sent in one click via native share'
    ]
  },
  {
    version: '4.8.2',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Fixed API key test function',
      'AI now receives FULL game history (not just last 10)',
      'Data sent only for selected players',
      'Better error logging for debugging'
    ]
  },
  {
    version: '4.8.1',
    date: '2025-12-18',
    changes: [
      'Screenshot: 2-column layout - Results and Settlements side by side',
      'More compact screenshot for sharing with many players',
      'Smaller fonts and tighter spacing in screenshot'
    ]
  },
  {
    version: '4.8.0',
    date: '2024-12-18',
    changes: [
      'NEW: AI-Powered Forecasts! 🤖',
      'Uses Google Gemini AI for creative, personalized predictions',
      'AI receives ALL player data: stats, streaks, recent games, history',
      'Dynamic, unique forecasts every time',
      'Sarcastic comments for inactive players',
      'Free to use - just add your Gemini API key in Settings',
      'Fallback to static forecasts if no API key'
    ]
  },
  {
    version: '4.7.0',
    date: '2025-12-18',
    changes: [
      'NEW: Graphs feature (Admin only) 📊',
      'Cumulative Profit Line Chart - visualize profit trends over time',
      'Head-to-Head Comparison - compare any 2 players side by side',
      'Leaderboard Race - animated ranking progression with replay',
      'Player selector for filtering graphs',
      'Interactive tooltips and legends'
    ]
  },
  {
    version: '4.6.41',
    date: '2025-12-18',
    changes: [
      'Removed "Import Historical Data" feature (replaced by cloud sync)',
      'Cleaned up unused import scripts and files'
    ]
  },
  {
    version: '4.6.40',
    date: '2025-12-18',
    changes: [
      'Fix: CORS error when fetching from GitHub API',
      'Removed Cache-Control header that was blocked'
    ]
  },
  {
    version: '4.6.39',
    date: '2025-12-18',
    changes: [
      'Fix: Proper UTF-8 decoding for Hebrew names in sync',
      'Added sync debugging logs to console'
    ]
  },
  {
    version: '4.6.38',
    date: '2025-12-18',
    changes: [
      'Fix: Sync now uses GitHub API instead of raw CDN (fixes caching issue)',
      'Deletions now properly sync to all devices'
    ]
  },
  {
    version: '4.6.37',
    date: '2025-12-18',
    changes: [
      'Sync: Page now reloads after cloud sync to show new data',
      'New games synced from cloud are now immediately visible'
    ]
  },
  {
    version: '4.6.36',
    date: '2025-12-18',
    changes: [
      'CRITICAL FIX: Statistics now works after sync',
      'Player IDs now correctly matched to game data during sync',
      'Default players no longer conflict with synced data'
    ]
  },
  {
    version: '4.6.35',
    date: '2025-12-18',
    changes: [
      'Player Stats: Arrow (❯) now grey to match Records view'
    ]
  },
  {
    version: '4.6.34',
    date: '2025-12-18',
    changes: [
      'Fix: Synced players now have correct type (permanent/guest)',
      'Statistics now shows synced players correctly'
    ]
  },
  {
    version: '4.6.33',
    date: '2025-12-18',
    changes: [
      'Player Stats: Aligned with Records design - icons + labels above values',
      'Added icons: 💰 Biggest Win, 💸 Biggest Loss, 🏆 Win Streak, 💔 Loss Streak',
      'Changed to 2-column grid layout matching Records view',
      'Values now show "X wins ❯" / "X losses ❯" format'
    ]
  },
  {
    version: '4.6.32',
    date: '2025-12-18',
    changes: [
      'Cloud Sync: Full replacement with version tracking',
      'Sync only happens when cloud data is newer (no redundant syncs)',
      'Game deletion auto-syncs to cloud (admin only)',
      'Players NOT synced - auto-created from game data if missing'
    ]
  },
  {
    version: '4.6.30',
    date: '2025-12-18',
    changes: [
      'Aligned stat-card boxes with Records design (same background, border-radius, padding)',
      'Smaller stat value font size to match Records style'
    ]
  },
  {
    version: '4.6.29',
    date: '2025-12-18',
    changes: [
      'Player Stats: Added timeframe header matching Records view',
      'Aligned player streak badges with Records design style'
    ]
  },
  {
    version: '4.6.28',
    date: '2025-12-18',
    changes: [
      'Current Streaks: Changed "3W" to "3 Wins" and "4L" to "4 Losses" for clarity'
    ]
  },
  {
    version: '4.6.27',
    date: '2025-12-18',
    changes: [
      'Cloud Sync: Delta mode - only adds new games (safe)',
      'Players NOT synced - auto-created from game data if missing',
      'Admin: Force Full Sync button to propagate deletions'
    ]
  },
  {
    version: '4.6.26',
    date: '2025-12-18',
    changes: [
      'Records title now shows filtered timeframe (e.g., "Records (H1 2025)")'
    ]
  },
  {
    version: '4.6.25',
    date: '2025-12-18',
    changes: [
      'Records header: Changed to English only "🏆 Records"',
      'Current Streaks: Compact display "3W" / "4L" instead of long text',
      'Fixed text wrapping in streak cards'
    ]
  },
  {
    version: '4.6.24',
    date: '2025-12-18',
    changes: [
      'Records: Added gray arrow indicator for clickable items',
      'Aligned records and player stats - both now show gray ❯ arrow'
    ]
  },
  {
    version: '4.6.23',
    date: '2025-12-18',
    changes: [
      'Records: Cleaner layout - click row for details, removed green buttons',
      'Player stats: Shorter labels (Best, Worst, W Streak, L Streak)',
      'All labels now prevent text wrapping for better display'
    ]
  },
  {
    version: '4.6.22',
    date: '2025-12-18',
    changes: [
      'Cloud Sync: Full data replacement - admin is master of all data',
      'Deleted games now sync to all users (removes from their devices)',
      'App reloads after sync to show updated data immediately'
    ]
  },
  {
    version: '4.6.21',
    date: '2025-12-18',
    changes: [
      'Records: Fixed layout - details arrow no longer wraps to new line',
      'Compact record display fits screen properly'
    ]
  },
  {
    version: '4.6.20',
    date: '2025-12-18',
    changes: [
      'NEW: GitHub Cloud Sync - games auto-sync to cloud when completed',
      'Admin can upload data to GitHub, other users auto-download on app open',
      'Viewer role excluded from sync (stays isolated)',
      'Sync settings in Backup tab (admin only)'
    ]
  },
  {
    version: '4.6.19',
    date: '2025-12-18',
    changes: [
      'All numbers now display as whole numbers (no decimals)',
      'Cleaner display throughout the app'
    ]
  },
  {
    version: '4.6.18',
    date: '2025-12-18',
    changes: [
      'Numbers with 4+ digits now show thousand separators (e.g., 1,234)',
      'Applied across all screens: Statistics, History, Game Summary, etc.'
    ]
  },
  {
    version: '4.6.17',
    date: '2025-12-18',
    changes: [
      'Player records W/L bar: Latest game now on the right',
      'Player records W/L bar: Date now includes year',
      'Player records W/L bar: Date font slightly larger'
    ]
  },
  {
    version: '4.6.16',
    date: '2025-12-18',
    changes: [
      'Statistics table: Share button NOT included in screenshot (clean table only)'
    ]
  },
  {
    version: '4.6.15',
    date: '2025-12-18',
    changes: [
      'Statistics table: Share button now visible in screenshot'
    ]
  },
  {
    version: '4.6.14',
    date: '2025-12-18',
    changes: [
      'Statistics table: Share button smaller and centered'
    ]
  },
  {
    version: '4.6.13',
    date: '2025-12-18',
    changes: [
      'Fixed: Player games list now respects time period filter',
      'Clicking player name shows only games from selected period'
    ]
  },
  {
    version: '4.6.12',
    date: '2025-12-18',
    changes: [
      'Statistics table: Added share button to send screenshot to WhatsApp',
      'Screenshot includes period info header for context'
    ]
  },
  {
    version: '4.6.11',
    date: '2025-12-18',
    changes: [
      'Fixed: Statistics page crash (missing useRef import)'
    ]
  },
  {
    version: '4.6.10',
    date: '2025-12-18',
    changes: [
      'Import button now shows file preparation date',
      'Dynamic display of games count from import file'
    ]
  },
  {
    version: '4.6.9',
    date: '2025-12-18',
    changes: [
      'Fixed: Time period preserved when navigating from records to game details',
      'Fixed: Record details modal no longer re-opens when changing filters',
      'Navigation now preserves all filter settings (period, year)'
    ]
  },
  {
    version: '4.6.8',
    date: '2025-12-18',
    changes: [
      'Import historical data now shows when the file was prepared',
      'Updated import data with latest games'
    ]
  },
  {
    version: '4.6.7',
    date: '2025-12-18',
    changes: [
      'Statistics table: Better spacing between columns',
      'More balanced distribution of space across the table'
    ]
  },
  {
    version: '4.6.6',
    date: '2025-12-18',
    changes: [
      'Statistics table: Compact layout - no more line wrapping',
      'Shorter column headers (G for Games, W% for Win%)',
      'All cells use nowrap for clean display'
    ]
  },
  {
    version: '4.6.5',
    date: '2025-12-18',
    changes: [
      'Records: Changed Hebrew labels back to English',
      'Leaders section: "Top Earner" and "Biggest Loser" (not all-time)'
    ]
  },
  {
    version: '4.6.4',
    date: '2025-12-18',
    changes: [
      'Statistics table: Added Average (Avg) column',
      'Statistics table: Removed decimal points - whole numbers only',
      'Statistics table: Medals (🥇🥈🥉) now appear after player name'
    ]
  },
  {
    version: '4.6.3',
    date: '2025-12-18',
    changes: [
      'Fixed: Renamed "All-Time Leaders" to "מובילים" (reflects selected period)',
      'Records now correctly show data for the selected time period'
    ]
  },
  {
    version: '4.6.1',
    date: '2025-12-17',
    changes: [
      'Simplified active players formula: 33% of total games in period',
      'Shows "מינימום X הופעות מתוך Y משחקים" (minimum appearances)'
    ]
  },
  {
    version: '4.6.0',
    date: '2024-12-17',
    changes: [
      'Forecast: Gender support only for מור (female)',
      'All other players use male Hebrew forms'
    ]
  },
  {
    version: '4.5.9',
    date: '2025-12-17',
    changes: [
      'Clarified filter explanation: "מעל 33%" (above 33%)'
    ]
  },
  {
    version: '4.5.8',
    date: '2025-12-17',
    changes: [
      'Changed active filter label to "שחקנים פעילים בלבד"',
      'Added explanation: "33% מממוצע המשחקים בתקופה"'
    ]
  },
  {
    version: '4.5.7',
    date: '2025-12-17',
    changes: [
      'Fixed: Filter buttons (H1/H2/Year/etc) no longer trigger game popups',
      'Added type=button and preventDefault to ALL filter buttons',
      'Comprehensive fix for all filter interactions in Statistics page'
    ]
  },
  {
    version: '4.5.6',
    date: '2025-12-17',
    changes: [
      'Fixed: Stat box data now respects the selected time period filter',
      'Fixed: Game details page scrolls to top when opened',
      'Fixed: Back navigation returns to correct view (individual/records/table)',
      'Fixed: Navigation from individual view stays in individual view'
    ]
  },
  {
    version: '4.5.5',
    date: '2024-12-17',
    changes: [
      'Forecast: Gender-aware sentences in Hebrew!',
      'Correct male/female forms (הוא/היא, שלו/שלה, etc.)',
      'Automatic detection of female names (מור, נועה, etc.)',
      'All forecast sentences updated with proper grammar'
    ]
  },
  {
    version: '4.5.4',
    date: '2025-12-17',
    changes: [
      'Individual player view: All stat boxes now clickable (Games, Wins, Losses, Best Win, etc.)',
      'W/L tiles now navigate directly to game details (simpler flow)',
      'Stat box clicks open records-style modal with game list',
      'Clickable stats show ❯ indicator',
      'Aligned UX with records view pattern'
    ]
  },
  {
    version: '4.5.3',
    date: '2024-12-17',
    changes: [
      'Forecast: Sarcastic/cynical sentences for long absences!',
      'Different levels: 3+ months, 6+ months, year+ absence',
      'Highlights also sarcastic for inactive players',
      'More humor and personality in returning player messages'
    ]
  },
  {
    version: '4.5.2',
    date: '2025-12-17',
    changes: [
      'Fixed: Filter buttons (H1/H2/Year) no longer trigger unwanted popups',
      'Table view: Click on any player row to see their game history',
      'Player game history modal shows all games with navigation to full details'
    ]
  },
  {
    version: '4.5.1',
    date: '2025-12-17',
    changes: [
      'Renamed Settings tab from "Backup" to "Backup & Restore"'
    ]
  },
  {
    version: '4.5.0',
    date: '2025-12-17',
    changes: [
      'Individual player stats: Last 6 games only (not 10)',
      'Clickable game tiles in player stats - shows game details modal',
      'Navigate from game modal to full game details with back navigation',
      'Scroll to player card when returning from game details'
    ]
  },
  {
    version: '4.4.0',
    date: '2024-12-17',
    changes: [
      'Forecast: Smart time awareness - checks actual game dates',
      'No more "לאחרונה" for players who havent played in months',
      'Much longer, more engaging forecast sentences',
      'Special handling for returning players after long breaks',
      'Highlights adapted to player activity level'
    ]
  },
  {
    version: '4.3.6',
    date: '2025-12-17',
    changes: [
      'Back button returns to exact record details modal (not just Records page)',
      'Record info is preserved when navigating from game details back to records'
    ]
  },
  {
    version: '4.3.5',
    date: '2024-12-17',
    changes: [
      'Navigation: Back to Records now returns to Records view (not Table)',
      'Preserves the view mode when navigating back from game details'
    ]
  },
  {
    version: '4.3.4',
    date: '2024-12-17',
    changes: [
      'Records: Each tied player now has their own "פרטים ❯" button',
      'Click to see game details for any player sharing a record',
      'Better layout for expanded tied players list'
    ]
  },
  {
    version: '4.3.3',
    date: '2024-12-17',
    changes: [
      'Navigation: "Back to Records" when coming from record drill-down',
      'Bottom button changes to "📊 Records" accordingly',
      'Seamless flow: Records → Game Details → Back to Records'
    ]
  },
  {
    version: '4.3.2',
    date: '2024-12-17',
    changes: [
      'Forecast: Now fully dynamic - different results each time!',
      'Highlights: Random selection from top relevant insights',
      'Sentences: Doubled the variety (10+ options per category)',
      'Expected values: Added significant variance for uniqueness'
    ]
  },
  {
    version: '4.3.1',
    date: '2024-12-17',
    changes: [
      'Records: Fixed date format (DD/MM/YYYY)',
      'Records: Click any game row to see full game details',
      'Hover effect and arrow indicator for clickable games'
    ]
  },
  {
    version: '4.3.0',
    date: '2024-12-17',
    changes: [
      'Forecast: Dynamic personalized highlights for each player',
      'Each player gets unique insight based on their actual data',
      'Detects: streaks, improvement/decline, comebacks, volatility',
      'Compares recent (last 10 games) vs historical performance'
    ]
  },
  {
    version: '4.2.3',
    date: '2024-12-17',
    changes: [
      'Fixed: Records drill-down now shows actual game data',
      'UI: Changed icon to clearer "פרטים ❯" button',
      'Added getAllGamePlayers function for record details'
    ]
  },
  {
    version: '4.2.2',
    date: '2024-12-17',
    changes: [
      'Forecast: Highlights line shows stats from last games (wins, streak, average)',
      'Forecast: Creative fun sentences separate from data',
      'Forecast: Cleaner layout - highlights first, then prediction',
      'Removed formula mention from footer'
    ]
  },
  {
    version: '4.2.1',
    date: '2024-12-17',
    changes: [
      'Records: Click 🔍 to see game details behind any record',
      'Modal shows all relevant games with dates and profits',
      'Works for streaks, wins, losses, biggest games, etc.'
    ]
  },
  {
    version: '4.2.0',
    date: '2024-12-17',
    changes: [
      'Improved: Forecast now weighs recent performance (60%) over overall history (40%)',
      'Improved: Sentences reference actual data (X/Y wins, streak info, averages)',
      'Added: Streak badges show hot/cold streaks (🔥/❄️)',
      'Added: Trend detection - improving vs declining players',
      'Fixed: Smarter surprise predictions based on contradicting trends'
    ]
  },
  {
    version: '4.1.3',
    date: '2024-12-17',
    changes: [
      'Fixed: Forecast button now works correctly',
      'Added missing imports for screenshot sharing'
    ]
  },
  {
    version: '4.1.2',
    date: '2024-12-17',
    changes: [
      'Fixed: אורח filter button now highlights green like others'
    ]
  },
  {
    version: '4.1.1',
    date: '2024-12-17',
    changes: [
      'Forecast: Completely rewritten engaging sentences',
      'Personal, witty predictions with real player stats',
      'Fun commentary players will enjoy sharing',
      'Smart surprise system (up to 30%, not forced)',
      'Screenshot-based WhatsApp sharing',
      'Cleaner UI with RTL support'
    ]
  },
  {
    version: '4.1.0',
    date: '2024-12-17',
    changes: [
      'Role-Based Permissions: Admin, Member, Viewer',
      'Admin (2351): Full control over everything',
      'Member (2580): Can manage games and add players',
      'Viewer (9876): View-only access + backup features',
      'Settings shows current role with emoji indicator',
      'UI adapts based on permissions (hide/disable buttons)',
      'All roles can use Backup & Data features'
    ]
  },
  {
    version: '4.0.0',
    date: '2024-12-17',
    changes: [
      'Forecast 3.0: Complete professional overhaul',
      'Smart surprise system - UP TO 35% (not forced)',
      'Unique sentences per player - no duplicates',
      'Cleaner sentence structure - less repetitive',
      'Screenshot-based WhatsApp sharing',
      'Clear visual legend (green=win, red=loss, purple=surprise)',
      'Better UI with RTL support',
      'Cached forecasts - consistent display'
    ]
  },
  {
    version: '3.9.9',
    date: '2024-12-17',
    changes: [
      'Records: Name and value now side by side',
      'Ties show value once (same for all)',
      'Expanded ties just show additional names'
    ]
  },
  {
    version: '3.9.8',
    date: '2024-12-17',
    changes: [
      'Records: Shows ties with expandable list',
      'Click "+N" badge to see all tied players',
      'Works for all record categories'
    ]
  },
  {
    version: '3.9.7',
    date: '2024-12-17',
    changes: [
      'History: Consistent buyins display for all games'
    ]
  },
  {
    version: '3.9.6',
    date: '2024-12-17',
    changes: [
      'History: Show ALL players sorted by profit (highest first)',
      'History: Added "פרטים מלאים" button for game details',
      'History: Shows total buyins instead of pot for new games',
      'Smaller badges to fit all players in view'
    ]
  },
  {
    version: '3.9.5',
    date: '2024-12-17',
    changes: [
      'Active Players toggle moved to top of filters',
      'Active Players filter ON by default',
      'Better filter organization in Statistics'
    ]
  },
  {
    version: '3.9.4',
    date: '2024-12-17',
    changes: [
      'Statistics defaults to current half year (H1 Jan-Jun, H2 Jul-Dec)',
      'Automatically selects the relevant half based on current date'
    ]
  },
  {
    version: '3.9.3',
    date: '2024-12-17',
    changes: [
      'UI: Active Players filter now uses iOS-style toggle switch',
      'UI: Year selector made more compact and elegant',
      'Cleaner filter section appearance'
    ]
  },
  {
    version: '3.9.2',
    date: '2024-12-17',
    changes: [
      'Bugfix: Fixed JSX syntax error causing Vercel build failure',
      'Statistics time period filter now correctly wrapped'
    ]
  },
  {
    version: '3.8.0',
    date: '2024-12-17',
    changes: [
      'New Game: Added optional location selector',
      'Quick options: ליאור, סגל, ליכטר, אייל',
      'Custom location via free text input',
      'Location stored for future analysis'
    ]
  },
  {
    version: '3.7.2',
    date: '2024-12-17',
    changes: [
      'Removed hardcoded Dec 6 game auto-import',
      'Buyin King only shows with real buyin data'
    ]
  },
  {
    version: '3.7.1',
    date: '2024-12-17',
    changes: [
      'New Game: More compact layout - less scrolling',
      'Smaller tiles, reduced spacing, compact header',
      'All 11 permanent players visible without scroll'
    ]
  },
  {
    version: '3.7.0',
    date: '2024-12-17',
    changes: [
      'Terminology: Changed "Rebuy" to "Buyin" across the app',
      'Buyin = total purchases (initial + additional)',
      'Updated: Settings, Live Game, Summary, Statistics, Sharing'
    ]
  },
  {
    version: '3.6.4',
    date: '2024-12-17',
    changes: [
      'Guest badge now uses grey background (same as Occasional)',
      'Only Permanent uses green highlight'
    ]
  },
  {
    version: '3.6.3',
    date: '2024-12-17',
    changes: [
      'Changed labels: אורח (singular), מזדמן (singular)',
      'New icon for Guest: 🏠 (was 👥)',
      'Occasional keeps: 👤'
    ]
  },
  {
    version: '3.6.2',
    date: '2024-12-17',
    changes: [
      'Settings: Players sorted by type (Permanent → Guests → Occasional)',
      'Alphabetical within each type',
      'Auto-sorts when adding/editing players'
    ]
  },
  {
    version: '3.6.1',
    date: '2024-12-17',
    changes: [
      'Import reads player types from Excel (קבוע/אורח/מזדמן column)',
      '11 Permanent, 5 Guests, 24 Occasional players'
    ]
  },
  {
    version: '3.6.0',
    date: '2024-12-17',
    changes: [
      'Import now REPLACES all data (full reset)',
      'Includes all 217 games from Excel',
      'Warning dialog before import'
    ]
  },
  {
    version: '3.5.0',
    date: '2024-12-16',
    changes: [
      'Renamed player types: קבוע, אורח, מזדמן',
      'New icons: ⭐ Permanent, 🏠 Guest, 👤 Occasional',
      'Hebrew descriptions for player type selection'
    ]
  },
  {
    version: '3.4.3',
    date: '2024-12-16',
    changes: [
      'UI: Unified selection colors across all screens',
      'All selected/active buttons now use consistent green'
    ]
  },
  {
    version: '3.4.2',
    date: '2024-12-16',
    changes: [
      'BUGFIX: Fixed Select/Deselect All in New Game screen',
      'BUGFIX: Fixed Clear button in Statistics screen',
      'Select All now works with visible players only'
    ]
  },
  {
    version: '3.4.1',
    date: '2024-12-16',
    changes: [
      'BUGFIX: Fixed screen freeze when switching tabs',
      'Performance: Added memoization to Statistics screen'
    ]
  },
  {
    version: '3.4.0',
    date: '2024-12-16',
    changes: [
      'Statistics: Player type filter now supports multi-select',
      'Select any combination of Permanent, Permanent Guest, Guest'
    ]
  },
  {
    version: '3.3.0',
    date: '2024-12-16',
    changes: [
      'Statistics: Added minimum games filter',
      'Filter players by games played (All, 5+, 10+, 20+, 50+)'
    ]
  },
  {
    version: '3.2.0',
    date: '2024-12-16',
    changes: [
      'Statistics: Added time period filter (All, Year, H1, H2)',
      'Filter by any year from 2021 to present',
      'H1 = Jan-Jun, H2 = Jul-Dec'
    ]
  },
  {
    version: '3.1.0',
    date: '2024-12-16',
    changes: [
      'Excel Import: Added one-click import for ~213 historical games',
      'Import creates backup before applying',
      'Intelligent merge - avoids duplicate games/players'
    ]
  },
  {
    version: '3.0.0',
    date: '2024-12-16',
    changes: [
      'Player Types: Added 3 categories - Permanent, Permanent Guest, Guest',
      'New Game: 3 collapsible sections for player types',
      'Statistics: Filter by player type',
      'Settings: Edit player type with 3 options',
      'Preparing for Excel history import'
    ]
  },
  {
    version: '2.10.0',
    date: '2024-12-16',
    changes: [
      'Backup: Simplified UI - Download button saves backup file to Downloads'
    ]
  },
  {
    version: '2.9.9',
    date: '2024-12-16',
    changes: [
      'Backup: "Open WhatsApp" button now opens WhatsApp directly after download'
    ]
  },
  {
    version: '2.9.8',
    date: '2024-12-16',
    changes: [
      'Backup: Added step-by-step instructions for sharing backup to WhatsApp'
    ]
  },
  {
    version: '2.9.7',
    date: '2024-12-16',
    changes: [
      'Backup: Improved share - downloads file first if direct file sharing not supported'
    ]
  },
  {
    version: '2.9.6',
    date: '2024-12-16',
    changes: [
      'Backup: Share now sends actual JSON file (not text) for easy restore'
    ]
  },
  {
    version: '2.9.5',
    date: '2024-12-16',
    changes: [
      'Backup: Added "Share to WhatsApp" option for cloud backup via WhatsApp'
    ]
  },
  {
    version: '2.9.4',
    date: '2024-12-16',
    changes: [
      'Statistics: Game tiles now show date below each game (DD/MM format)'
    ]
  },
  {
    version: '2.9.3',
    date: '2024-12-16',
    changes: [
      'Statistics: Changed indicator to "אחרון" label for clarity'
    ]
  },
  {
    version: '2.9.2',
    date: '2024-12-16',
    changes: [
      'Statistics: Added ▲ indicator under the most recent game'
    ]
  },
  {
    version: '2.9.1',
    date: '2024-12-16',
    changes: [
      'Statistics: Last games display now shows 6 games instead of 5',
      'Statistics: Most recent game now appears first (left side)'
    ]
  },
  {
    version: '2.9.0',
    date: '2024-12-16',
    changes: [
      'Forecast 2.0: Complete overhaul of prediction system',
      '40% surprise rate - predictions that go against history',
      '100+ unique Hebrew sentences across all categories',
      'No duplicate sentences in same forecast',
      'Surprise predictions highlighted with 🎲 and purple color',
      'All sentences reference historical data when available'
    ]
  },
  {
    version: '2.8.4',
    date: '2024-12-15',
    changes: [
      'Forecast now balanced: total wins = total losses (zero-sum)',
      'Sentences match the balanced expected values'
    ]
  },
  {
    version: '2.8.3',
    date: '2024-12-15',
    changes: [
      'Auto backup changed from Sunday to Friday'
    ]
  },
  {
    version: '2.8.2',
    date: '2024-12-15',
    changes: [
      'Chip delete icon now matches player delete icon style'
    ]
  },
  {
    version: '2.8.1',
    date: '2024-12-15',
    changes: [
      'Auto backup after each game ends',
      'Backups now show type: Auto (Game End), Auto (Sunday), Manual',
      'Backup list shows trigger information'
    ]
  },
  {
    version: '2.8.0',
    date: '2024-12-15',
    changes: [
      'Delete confirmation dialogs for players and chips',
      'All deletions now require confirmation before proceeding'
    ]
  },
  {
    version: '2.7.9',
    date: '2024-12-15',
    changes: [
      'Forecast: Sentences now match expected profit direction',
      'Forecast: Much longer and more detailed sentences',
      'Forecast: 100+ unique sentences with player name and stats',
      'Forecast: Surprises now also adjust the expected profit'
    ]
  },
  {
    version: '2.7.8',
    date: '2024-12-15',
    changes: [
      'Settings: Unified player edit - name & type in one modal',
      'Settings: Cleaner player buttons (Edit + Delete only)',
      'Settings: Backup section redesigned with grouped actions'
    ]
  },
  {
    version: '2.7.7',
    date: '2024-12-15',
    changes: [
      'Settings: Players tab is now first',
      'Settings: Tabs styled like Statistics page (max 4 per row)',
      'Settings: Tab layout matches Statistics page format'
    ]
  },
  {
    version: '2.7.6',
    date: '2024-12-15',
    changes: [
      'Settings: Can now edit player names with ✏️ button',
      'All historical data and statistics migrate to new name'
    ]
  },
  {
    version: '2.7.5',
    date: '2024-12-15',
    changes: [
      'Forecast: Much more variety in sentences (100+ options)',
      'Forecast: 15% chance for surprise predictions against the data',
      'Forecast: More categories based on stats depth'
    ]
  },
  {
    version: '2.7.4',
    date: '2024-12-15',
    changes: [
      'Settings tabs now wrap to new line instead of scrolling'
    ]
  },
  {
    version: '2.7.3',
    date: '2024-12-15',
    changes: [
      'Settings: Player list now shows type (קבוע/אורח)',
      'Settings: Can choose player type when adding new player',
      'Settings: Can toggle player type for existing players'
    ]
  },
  {
    version: '2.7.2',
    date: '2024-12-15',
    changes: [
      'Forecast sentences now in Hebrew'
    ]
  },
  {
    version: '2.7.1',
    date: '2024-12-15',
    changes: [
      'Settings page now has tabs: Game, Chips, Players, Backup, About',
      'Cleaner navigation between settings sections'
    ]
  },
  {
    version: '2.7.0',
    date: '2024-12-15',
    changes: [
      'Added Forecast feature on New Game screen',
      'Predicts player profit/loss based on history',
      'Generates funny/cynical sentences for each player',
      'Share forecast to WhatsApp'
    ]
  },
  {
    version: '2.6.0',
    date: '2024-12-15',
    changes: [
      'Added Backup & Restore feature in Settings',
      'Auto-backup every Sunday on app open',
      'Manual backup, download, and import options',
      'Keeps last 4 backups (1 month)'
    ]
  },
  {
    version: '2.5.6',
    date: '2024-12-15',
    changes: [
      'Simplified Game Details - removed stat tiles, added Total Rebuys to Results header'
    ]
  },
  {
    version: '2.5.5',
    date: '2024-12-15',
    changes: [
      'Added Total Rebuys display at top of Results table in Game Summary'
    ]
  },
  {
    version: '2.5.4',
    date: '2024-12-15',
    changes: [
      'Fixed Game Details table to fit screen - no horizontal scroll'
    ]
  },
  {
    version: '2.5.3',
    date: '2024-12-15',
    changes: [
      'Fixed Game Details table - restored Chips column with proper calculation'
    ]
  },
  {
    version: '2.5.2',
    date: '2024-12-15',
    changes: [
      'Simplified Game Details table - removed Chips column, fixed value formatting'
    ]
  },
  {
    version: '2.5.1',
    date: '2024-12-15',
    changes: [
      'Fixed table alignment - profit column no longer wraps to new line'
    ]
  },
  {
    version: '2.5.0',
    date: '2024-12-15',
    changes: [
      'Simplified chip display - always uses stored finalValue for reliability'
    ]
  },
  {
    version: '2.4.9',
    date: '2024-12-15',
    changes: [
      'Fixed chip display for games without detailed chip counts'
    ]
  },
  {
    version: '2.4.8',
    date: '2024-12-15',
    changes: [
      'Game Details now uses screenshot sharing like Game Summary'
    ]
  },
  {
    version: '2.4.7',
    date: '2024-12-15',
    changes: [
      'Fixed table width in Game Details to fit container'
    ]
  },
  {
    version: '2.4.6',
    date: '2024-12-15',
    changes: [
      'Fixed Chips column in Game Details - shows chips not shekels'
    ]
  },
  {
    version: '2.4.5',
    date: '2024-12-15',
    changes: [
      'Added historical game import (Dec 6, 2024)',
      'Historical data automatically imported on first load'
    ]
  },
  {
    version: '2.4.4',
    date: '2024-12-14',
    changes: [
      'Sort tabs (Profit/Games/Win Rate) now equally spread'
    ]
  },
  {
    version: '2.4.3',
    date: '2024-12-14',
    changes: [
      'Fixed bug: small transfers no longer displayed twice',
      'Settlements and Small Amounts are now separate lists'
    ]
  },
  {
    version: '2.4.2',
    date: '2024-12-14',
    changes: [
      'Fixed sort buttons layout - icon above text for all tabs'
    ]
  },
  {
    version: '2.4.1',
    date: '2024-12-14',
    changes: [
      'Added stats-only PIN (9876) for view-only access',
      'Stats-only users can only see Statistics page',
      'Full access PIN (2580) unchanged'
    ]
  },
  {
    version: '2.4.0',
    date: '2024-12-14',
    changes: [
      'Added permanent vs guest player types',
      'Settings: new players are permanent by default',
      'New Game: new players are guests by default with toggle',
      'New Game: guests shown in collapsible section',
      'Statistics: toggle to include/exclude guests',
      'Existing players migrated to permanent'
    ]
  },
  {
    version: '2.3.9',
    date: '2024-12-14',
    changes: [
      'Added multi-select player filter to Statistics page',
      'Filter works across Table, Records, and Players views',
      'Select/deselect players to compare stats'
    ]
  },
  {
    version: '2.3.8',
    date: '2024-12-14',
    changes: [
      'Changed Total Rebuys text to white in statistics'
    ]
  },
  {
    version: '2.3.7',
    date: '2024-12-14',
    changes: [
      'Enriched player statistics with more data',
      'Added wins/losses count, avg win/loss, best/worst streak',
      'Added Average Performance records section',
      'Added Most Wins, Most Losses, Worst Win Rate records',
      'Fixed streak calculations in storage'
    ]
  },
  {
    version: '2.3.6',
    date: '2024-12-14',
    changes: [
      'Restored nice progress bar format',
      'Colored border at top, stats row, proper spacing'
    ]
  },
  {
    version: '2.3.5',
    date: '2024-12-14',
    changes: [
      'Fixed Statistics: loss colors now red (not blue)',
      'Removed confusing Best/Worst streak from player cards',
      'Fixed -0 display - shows dash if no value',
      'Streak records only show if > 1 game',
      'Changed Ice Cold to Cold Streak with red color'
    ]
  },
  {
    version: '2.3.4',
    date: '2024-12-14',
    changes: [
      'Fixed chip entry page - reduced empty space',
      'More compact bottom bar with progress overlay'
    ]
  },
  {
    version: '2.3.3',
    date: '2024-12-14',
    changes: [
      'Removed Reset Statistics button',
      'Fixed table: medal and number on same line'
    ]
  },
  {
    version: '2.3.2',
    date: '2024-12-14',
    changes: [
      'Restored Records view in Statistics',
      'Current streaks (On Fire / Ice Cold)',
      'All-time leaders and single game records',
      'Streak records and other achievements',
      'Individual view with last 5 games trend'
    ]
  },
  {
    version: '2.3.1',
    date: '2024-12-14',
    changes: [
      'Restored player selector on chip count page',
      'Select one player at a time to count chips',
      'Done button marks player complete and auto-advances',
      'Tap completed player to edit their count'
    ]
  },
  {
    version: '2.3.0',
    date: '2024-12-14',
    changes: [
      'MAJOR FIX: Restored Vercel rewrites for page refresh',
      'Added loading states to all game screens',
      'Added catch-all route for unknown URLs',
      'Fixed chip grid to always show 2 columns',
      'App initialization loading screen'
    ]
  },
  {
    version: '2.2.9',
    date: '2024-12-14',
    changes: [
      'Restored version display on PIN login screen'
    ]
  },
  {
    version: '2.2.8',
    date: '2024-12-14',
    changes: [
      'Statistics: Simplified to Table and Individual views',
      'Removed Records view',
      'Table is default, no horizontal scroll',
      'Restored Reset Statistics button'
    ]
  },
  {
    version: '2.2.7',
    date: '2024-12-14',
    changes: [
      'Statistics: Table is now default view and first tab',
      'Tabs appear on same line',
      'Table fits in one view'
    ]
  },
  {
    version: '2.2.6',
    date: '2024-12-14',
    changes: [
      'Fixed progress bar - now 28px with visible background',
      'Bottom bar fixed to bottom - no scrolling past it'
    ]
  },
  {
    version: '2.2.5',
    date: '2024-12-14',
    changes: [
      'Removed Reset All Statistics button'
    ]
  },
  {
    version: '2.2.4',
    date: '2024-12-14',
    changes: [
      'Progress bar 36px with chip count overlay'
    ]
  },
  {
    version: '2.2.3',
    date: '2024-12-14',
    changes: [
      'Bottom bar flows with content - no empty space'
    ]
  },
  {
    version: '2.2.2',
    date: '2024-12-14',
    changes: [
      'Added version to PIN login screen'
    ]
  },
  {
    version: '1.9.4',
    date: '2024-12-14',
    changes: [
      'Changed summary table headers to text: Chips, Rebuy'
    ]
  },
  {
    version: '1.9.3',
    date: '2024-12-14',
    changes: [
      'Updated chips and rebuy icons in summary table'
    ]
  },
  {
    version: '1.9.2',
    date: '2024-12-14',
    changes: [
      'Centered Home and Share buttons on summary screen'
    ]
  },
  {
    version: '1.9.1',
    date: '2024-12-14',
    changes: [
      'Updated PIN code'
    ]
  },
  {
    version: '1.9.0',
    date: '2024-12-14',
    changes: [
      'Added PIN lock screen for app access',
      'Session persists until browser is closed'
    ]
  },
  {
    version: '1.8.0',
    date: '2024-12-14',
    changes: [
      'Neutral +/- buttons - no red/green colors',
      'Cleaner top counter design',
      'Simplified Expected vs Counted display'
    ]
  },
  {
    version: '1.7.8',
    date: '2024-12-14',
    changes: [
      'Changelog shows only latest version by default',
      'Click to expand and see full version history'
    ]
  },
  {
    version: '1.7.7',
    date: '2024-12-14',
    changes: [
      'Player tiles now spread evenly using grid layout',
      'Tiles fill the available width edge to edge'
    ]
  },
  {
    version: '1.7.6',
    date: '2024-12-14',
    changes: [
      'Larger player tiles with bigger names',
      'More spacing between tiles'
    ]
  },
  {
    version: '1.7.5',
    date: '2024-12-14',
    changes: [
      'Increased spacing between player selection tiles'
    ]
  },
  {
    version: '1.7.4',
    date: '2024-12-14',
    changes: [
      'Progress stays red/orange longer - only green near 100%',
      'Summary card visible and styled from start',
      'Consistent color scheme using progress color'
    ]
  },
  {
    version: '1.7.3',
    date: '2024-12-14',
    changes: [
      'Players with 0 chips can now be marked as Done',
      'Removed long-press rapid increment feature',
      'Simplified +/- button behavior'
    ]
  },
  {
    version: '1.7.2',
    date: '2024-12-14',
    changes: [
      'Progress bar now uses gradient colors',
      'Red (0%) → Orange → Yellow → Green (100%)',
      'Smooth color transition as you count'
    ]
  },
  {
    version: '1.7.1',
    date: '2024-12-14',
    changes: [
      'Progress bar now at absolute bottom of screen'
    ]
  },
  {
    version: '1.7.0',
    date: '2024-12-14',
    changes: [
      'Progress bar moved to fixed bottom position',
      'Always visible while counting chips',
      'Shows players done, chips remaining, and Calculate button'
    ]
  },
  {
    version: '1.6.3',
    date: '2024-12-14',
    changes: [
      'Compact player selection with pill-style buttons',
      'Reduced page header and spacing for less scrolling',
      'Start Game button now visible without scrolling'
    ]
  },
  {
    version: '1.6.2',
    date: '2024-12-14',
    changes: [
      'Added visible Done button to collapse player after counting',
      'Button turns green when player has chips counted'
    ]
  },
  {
    version: '1.6.1',
    date: '2024-12-14',
    changes: [
      'Fixed chip counting screen blank issue'
    ]
  },
  {
    version: '1.6.0',
    date: '2024-12-14',
    changes: [
      'Added collapsible player cards in chip counting',
      'Added floating progress bar showing count progress',
      'Tap player header to collapse/expand after counting'
    ]
  },
  {
    version: '1.5.1',
    date: '2024-12-14',
    changes: [
      'Removed winner box from summary page'
    ]
  },
  {
    version: '1.5.0',
    date: '2024-12-14',
    changes: [
      'Added long-press rapid increment on +/- buttons',
      'Added numpad modal for quick chip count entry',
      'Tap chip color to open numpad for direct input'
    ]
  },
  {
    version: '1.4.1',
    date: '2024-12-14',
    changes: [
      'Reduced winner box size for better layout'
    ]
  },
  {
    version: '1.4.0',
    date: '2024-12-14',
    changes: [
      'WhatsApp share now sends screenshot of summary',
      'Captures results table and settlements as image',
      'Uses native share on mobile devices'
    ]
  },
  {
    version: '1.3.0',
    date: '2024-12-14',
    changes: [
      'Simplified rebuys column to show only count',
      'Improved table layout for mobile screens',
      'Redesigned WhatsApp export with clean table format'
    ]
  },
  {
    version: '1.2.0',
    date: '2024-12-14',
    changes: [
      'Added total chips column to game summary table',
      'Added total rebuy column to game summary table',
      'Included total chips and rebuys in WhatsApp export message'
    ]
  },
  {
    version: '1.1.0',
    date: '2024-12-14',
    changes: [
      'Added app versioning system',
      'Added changelog tracking in Settings',
      'Version now displayed in Settings screen'
    ]
  },
  {
    version: '1.0.0',
    date: '2024-12-01',
    changes: [
      'Initial release',
      'Poker game management',
      'Player tracking',
      'Chip calculations',
      'Game history and statistics'
    ]
  }
];
