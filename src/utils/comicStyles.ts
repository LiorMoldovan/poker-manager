/**
 * Comic style registry for the Game-Night Comic feature.
 *
 * Six curated styles. The art prompt fragment is engineered to lock the
 * model onto a specific, recognizable look — the difference between
 * "AI slop" and a comic that actually feels designed.
 *
 * Each style ships with a matching speech-bubble theme so the DOM
 * overlay looks native to the art (a manga panel gets jagged shout
 * bubbles, a Tintin panel gets clean rounded ovals, etc.).
 *
 * Vibe selection: pickStyleForGame() reads the game's narrative shape
 * (drama, calm, surprise, comeback, etc.) and picks the most fitting
 * style. The user's "Regenerate" button cycles through the list so the
 * admin can audition styles for the same game.
 */

import { ComicStyleKey } from '../types';

export interface ComicStyle {
  key: ComicStyleKey;
  /** Hebrew label shown in the UI badge under the comic. */
  label: string;
  /**
   * Prompt fragment injected into the art prompt. This is the single most
   * important field for quality — it must be specific enough to lock the
   * look without over-constraining composition.
   */
  promptFragment: string;
  /** Negative prompt — explicit don'ts that fight common AI failure modes. */
  negativePrompt: string;
  bubble: BubbleTheme;
  /** Optional global mood guidance fed into the script-stage prompt. */
  scriptVibe: string;
}

export interface BubbleTheme {
  /** Background fill for the bubble box. */
  background: string;
  /** Border style applied to the bubble box. */
  border: string;
  borderRadius: string;
  /** Drop shadow / glow. */
  boxShadow: string;
  /** Text color. */
  color: string;
  /** Web font stack (Hebrew-capable). */
  fontFamily: string;
  /** Font weight. */
  fontWeight: number | string;
  /** Letter spacing — negative tightens, positive opens up. */
  letterSpacing: string;
  /** Padding inside the bubble. */
  padding: string;
  /**
   * Optional tail color for the speech-bubble pointer. If omitted the tail
   * matches the bubble background.
   */
  tailColor?: string;
  /**
   * Optional CSS transform for the bubble box (e.g. slight rotation in
   * manga). Applied per-bubble for kinetic feel.
   */
  transform?: string;
  /** Caption-strip styling (narrator captions are always rectangles). */
  caption: {
    background: string;
    color: string;
    border: string;
    fontFamily: string;
    fontWeight: number | string;
  };
}

// ─── Style definitions ─────────────────────────────────────────

const NEWSPAPER: ComicStyle = {
  key: 'newspaper',
  label: 'קומיקס יום ראשון',
  promptFragment: [
    'classic American Sunday newspaper comic strip art style',
    'bold confident black ink lines, clean linework',
    'flat saturated CMYK colors with visible newspaper halftone dot pattern',
    'slight off-register print misalignment for authentic vintage feel',
    'warm cream off-white paper background',
    'thick black panel borders 2x2 grid layout with 12px gutter between panels',
    'characters drawn with expressive caricatured features and dynamic poses',
    'reminiscent of Calvin and Hobbes, Garfield, Sunday FoxTrot — mid-1990s warmth',
  ].join(', '),
  negativePrompt: 'no text, no letters, no speech bubble shapes, no captions, no signatures, no watermarks, no logos, no UI overlays, no panel numbers',
  bubble: {
    background: '#fffdf3',
    border: '2.5px solid #1a1a1a',
    borderRadius: '20px',
    boxShadow: '2px 3px 0 rgba(0,0,0,0.85)',
    color: '#1a1a1a',
    fontFamily: '"Heebo","Assistant","Outfit",sans-serif',
    fontWeight: 700,
    letterSpacing: '0.01em',
    padding: '0.45rem 0.75rem',
    tailColor: '#fffdf3',
    caption: {
      background: '#fff5b8',
      color: '#1a1a1a',
      border: '2.5px solid #1a1a1a',
      fontFamily: '"Heebo","Assistant",sans-serif',
      fontWeight: 800,
    },
  },
  scriptVibe: 'lighthearted Sunday-comic warmth — observational humor, friendly ribbing, a small punchline in the last panel',
};

const MANGA: ComicStyle = {
  key: 'manga',
  label: 'מנגה',
  promptFragment: [
    'high-contrast Japanese seinen manga panel art',
    'crisp black ink with rich screentone shading and dramatic speed lines',
    'sharp angular character design with intense expressive eyes and beads of sweat',
    'Dutch angles, dynamic close-ups and zoom-out wide shots for tension',
    'monochrome black-and-white plus a single muted accent color (deep crimson or cobalt)',
    'thick uneven panel borders 2x2 grid layout with clean gutters',
    'inspired by Naoki Urasawa and Akira Toriyama poker scenes — Kaiji-style tension',
    'dramatic chiaroscuro lighting from a single overhead lamp',
  ].join(', '),
  negativePrompt: 'no text, no Japanese kanji, no English letters, no speech bubble shapes, no captions, no onomatopoeia text, no signatures, no watermarks, no UI',
  bubble: {
    background: '#ffffff',
    border: '2.5px solid #0a0a0a',
    borderRadius: '14px',
    boxShadow: '3px 4px 0 rgba(0,0,0,0.9)',
    color: '#0a0a0a',
    fontFamily: '"Heebo","Assistant","Outfit",sans-serif',
    fontWeight: 800,
    letterSpacing: '0',
    padding: '0.4rem 0.7rem',
    transform: 'rotate(-1.2deg)',
    tailColor: '#ffffff',
    caption: {
      background: '#0a0a0a',
      color: '#ffffff',
      border: '2.5px solid #0a0a0a',
      fontFamily: '"Heebo","Assistant",sans-serif',
      fontWeight: 900,
    },
  },
  scriptVibe: 'high tension, dramatic stakes — every all-in is a duel, every comeback a turning point, narration cuts like a katana',
};

const NOIR: ComicStyle = {
  key: 'noir',
  label: 'נואר',
  promptFragment: [
    'gritty 1940s film noir comic art style',
    'heavy black ink, deep velvet shadows, single-source rim lighting like a smoke-filled bar',
    'desaturated palette of bone-white, charcoal, ash gray, dirty cream and one warm tobacco brown',
    'cigarette smoke curling through every panel, half-shaded faces, fedora hats optional',
    'venetian blind shadows striped across walls and faces',
    'thin clean panel borders 2x2 grid with ample dark negative space',
    'mood reminiscent of Sin City and Blacksad, but with poker chips instead of detectives',
    'cinematic widescreen compositions, rule of thirds, low-key lighting',
  ].join(', '),
  negativePrompt: 'no text, no letters, no speech bubble shapes, no captions, no signatures, no watermarks, no bright saturated colors, no daylight',
  bubble: {
    background: '#f3eedb',
    border: '1.5px solid #1a1612',
    borderRadius: '6px',
    boxShadow: '0 6px 16px rgba(0,0,0,0.75)',
    color: '#1a1612',
    fontFamily: '"Heebo","Assistant","Outfit",serif',
    fontWeight: 600,
    letterSpacing: '0.02em',
    padding: '0.5rem 0.8rem',
    tailColor: '#f3eedb',
    caption: {
      background: '#1a1612',
      color: '#e8d9b0',
      border: '1.5px solid #4a3a2a',
      fontFamily: '"Heebo","Assistant",serif',
      fontWeight: 600,
    },
  },
  scriptVibe: 'fatalistic, brooding — the dealer is fate, the chips are evidence, every winner is haunted, narrator speaks in clipped past-tense',
};

const PIXAR3D: ComicStyle = {
  key: 'pixar3d',
  label: 'תלת-ממד פיקסר',
  promptFragment: [
    'modern Pixar 3D animation style, photorealistic-yet-stylized character design',
    'big expressive eyes, exaggerated friendly proportions, soft subsurface skin shading',
    'warm cinematic lighting with practical lamps over the poker table',
    'rich saturated palette of teal, amber, magenta and cream, depth-of-field bokeh',
    'glossy poker chips with realistic specular highlights, felt table fabric texture',
    'subtle ambient occlusion in corners, volumetric light rays through smoke',
    'thin warm beige panel borders 2x2 grid, slightly rounded panel corners',
    'feel of a still from a Pixar short — Toy Story 4 / Inside Out evening warmth',
  ].join(', '),
  negativePrompt: 'no text, no letters, no speech bubble shapes, no captions, no signatures, no watermarks, no flat 2D shading, no anime style, no horror tone',
  bubble: {
    background: '#fffaf0',
    border: '3px solid #2a2a2a',
    borderRadius: '24px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
    color: '#1a1a1a',
    fontFamily: '"Heebo","Assistant","Outfit",sans-serif',
    fontWeight: 700,
    letterSpacing: '0.005em',
    padding: '0.5rem 0.85rem',
    tailColor: '#fffaf0',
    caption: {
      background: 'linear-gradient(135deg,#ffd166,#ff8c42)',
      color: '#1a1a1a',
      border: '3px solid #2a2a2a',
      fontFamily: '"Heebo","Assistant",sans-serif',
      fontWeight: 800,
    },
  },
  scriptVibe: 'warm, character-driven, optimistic — players have inner lives, lessons are learned, the night ends on a heartfelt beat',
};

const TINTIN: ComicStyle = {
  key: 'tintin',
  label: 'קו ברור',
  promptFragment: [
    'classic Belgian ligne claire comic art style — Hergé Tintin and Edgar P. Jacobs Blake & Mortimer',
    'uniform-weight crisp black ink contour lines, no hatching, perfectly clean linework',
    'flat saturated primary-color fills with no gradients — bright cyan, vermilion red, mustard yellow, kelly green',
    'meticulous architectural backgrounds with deep one-point perspective',
    'reserved restrained character expressions, mid-Atlantic 1950s European elegance',
    'thin black panel borders 2x2 grid layout with generous negative space',
    'feels like a vintage hardcover album you would find in a Brussels bookshop',
  ].join(', '),
  negativePrompt: 'no text, no letters, no speech bubble shapes, no captions, no signatures, no watermarks, no painterly textures, no shading gradients, no hatching, no rough sketches',
  bubble: {
    background: '#fefdf7',
    border: '2px solid #0a0a0a',
    borderRadius: '50% / 40%',
    boxShadow: 'none',
    color: '#0a0a0a',
    fontFamily: '"Heebo","Assistant","Outfit",sans-serif',
    fontWeight: 600,
    letterSpacing: '0.005em',
    padding: '0.4rem 0.85rem',
    tailColor: '#fefdf7',
    caption: {
      background: '#fefdf7',
      color: '#0a0a0a',
      border: '2px solid #0a0a0a',
      fontFamily: '"Heebo","Assistant",sans-serif',
      fontWeight: 700,
    },
  },
  scriptVibe: 'understated, witty, observational — dry European humor, restrained narration, the punchline is a raised eyebrow not a shout',
};

const RETRO70S: ComicStyle = {
  key: 'retro70s',
  label: 'רטרו 70',
  promptFragment: [
    '1970s underground psychedelic comic art style, Robert Crumb meets Heavy Metal magazine',
    'bold black ink with energetic crosshatching and stippling textures',
    'warm vintage palette of mustard yellow, burnt orange, avocado green, brick red, cream',
    'characters with exaggerated wide-eyed expressions, big sideburns, flared collars, kitchen-table-of-the-1970s vibes',
    'visible halftone dots and offset-printing grit overlay',
    'wonky hand-drawn panel borders 2x2 grid, slightly imperfect rectangles',
    'feels printed on cheap newsprint, slightly yellowed with age',
    'cosmic / surreal flourishes — chips becoming planets, smoke forming spirals',
  ].join(', '),
  negativePrompt: 'no text, no letters, no speech bubble shapes, no captions, no signatures, no watermarks, no modern slick rendering, no clean digital lines',
  bubble: {
    background: '#fff7d6',
    border: '2.5px solid #2a1c0a',
    borderRadius: '30px 28px 32px 26px',
    boxShadow: '3px 3px 0 rgba(42,28,10,0.85)',
    color: '#2a1c0a',
    fontFamily: '"Heebo","Assistant","Outfit",sans-serif',
    fontWeight: 700,
    letterSpacing: '0.015em',
    padding: '0.45rem 0.8rem',
    tailColor: '#fff7d6',
    caption: {
      background: '#c84e1a',
      color: '#fff7d6',
      border: '2.5px solid #2a1c0a',
      fontFamily: '"Heebo","Assistant",sans-serif',
      fontWeight: 800,
    },
  },
  scriptVibe: 'kinetic, surreal, slightly stoned — chips orbit, time bends, every win feels cosmic, every loss philosophical',
};

export const COMIC_STYLES: Record<ComicStyleKey, ComicStyle> = {
  newspaper: NEWSPAPER,
  manga: MANGA,
  noir: NOIR,
  pixar3d: PIXAR3D,
  tintin: TINTIN,
  retro70s: RETRO70S,
};

export const COMIC_STYLE_ORDER: ComicStyleKey[] = [
  'newspaper', 'pixar3d', 'manga', 'tintin', 'noir', 'retro70s',
];

export const getComicStyle = (key: ComicStyleKey): ComicStyle =>
  COMIC_STYLES[key] || NEWSPAPER;

// ─── Vibe-based selector ───────────────────────────────────────
// Reads the same shape of payload that drives the AI summary so the
// chosen style matches the night's emotional arc.

export interface ComicVibePayload {
  /** sorted: [winner, ..., biggest loser] tonight */
  tonight: { name: string; profit: number; rebuys: number }[];
  recordsBroken: string[];
  notableStreaks: string[];
  upsets: string[];
  rankingShifts: string[];
}

/**
 * Deterministic style selection based on the game's narrative shape.
 * The same game always picks the same style (so re-rendering is stable);
 * the "Regenerate" button passes a `cycleFrom` to advance to the next
 * one in COMIC_STYLE_ORDER.
 */
export const pickStyleForGame = (
  payload: ComicVibePayload,
  cycleFrom?: ComicStyleKey,
): ComicStyleKey => {
  if (cycleFrom) {
    const idx = COMIC_STYLE_ORDER.indexOf(cycleFrom);
    return COMIC_STYLE_ORDER[(idx + 1) % COMIC_STYLE_ORDER.length];
  }

  if (payload.tonight.length === 0) return 'newspaper';

  const winner = payload.tonight[0];
  const loser = payload.tonight[payload.tonight.length - 1];
  const swing = (winner.profit || 0) - (loser.profit || 0);

  // Big drama / records broken → manga
  if (payload.recordsBroken.length >= 2 || swing >= 1500) return 'manga';

  // Lots of unexpected upsets → retro70s (psychedelic surprise)
  if (payload.upsets.length >= 2 || payload.rankingShifts.length >= 3) return 'retro70s';

  // Heavy losses, brutal night → noir
  if (loser.profit <= -800) return 'noir';

  // Steady winner with long streak → tintin (clean, controlled)
  const longStreak = payload.notableStreaks.find(s => /[3-9]\s*(נצחונות|wins)/.test(s));
  if (longStreak) return 'tintin';

  // Lots of rebuys, comeback / family vibe → pixar3d
  const totalRebuys = payload.tonight.reduce((s, p) => s + p.rebuys, 0);
  if (totalRebuys >= payload.tonight.length * 3) return 'pixar3d';

  // Default cozy weeknight → newspaper Sunday strip
  return 'newspaper';
};
