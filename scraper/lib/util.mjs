// Shared helpers for the research engine.

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Polite, jittered delay so we don't hammer search engines.
export function politeDelay(min = 1200, max = 2600) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

const SENIOR_KEYWORDS = [
  'founder', 'co-founder', 'cofounder', 'chairman', 'promoter',
  'ceo', 'cfo', 'coo', 'cto', 'cmo', 'cpo', 'chro', 'chief',
  'managing director', 'president', 'evp', 'svp', 'vp', 'vice president',
  'director', 'head of', 'head,', 'head ', 'principal', 'general manager',
  'national', 'senior manager',
];

export function looksSenior(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return SENIOR_KEYWORDS.some(k => t.includes(k));
}

// Classify seniority from any text (title + snippet). Mirrors the buckets the
// Worker uses so the dashboard score is right even when we can't isolate the
// exact role string. First match wins (highest seniority first).
const SENIORITY_RULES = [
  [/\b(founder|co[-\s]?founder|promoter|chairman|chairperson)\b/i, 'founder'],
  [/\b(ceo|cfo|coo|cto|cmo|cpo|chro|chief|managing director|\bmd\b|president)\b/i, 'clevel'],
  [/\b(evp|svp|\bvp\b|vice president)\b/i, 'vp'],
  [/\b(director|head of|\bhead\b|principal|general manager|\bgm\b|national|regional)\b/i, 'director'],
  [/\b(senior manager|lead|manager)\b/i, 'manager'],
];

export function seniorityOf(text) {
  if (!text) return 'other';
  for (const [re, bucket] of SENIORITY_RULES) {
    if (re.test(text)) return bucket;
  }
  return 'other';
}

// Pull a clean person name out of a LinkedIn result title like
// "Jane Doe - Head of Retail - Reliance | LinkedIn"
export function parseLinkedInTitle(title) {
  if (!title) return null;
  let t = title.replace(/\s*[|\-–]\s*LinkedIn.*$/i, '').trim();
  const parts = t.split(/\s+[-–|]\s+/);
  const name = (parts[0] || '').trim();
  const headline = parts.slice(1).join(' · ').trim();
  // crude sanity check: a name has 1-5 words, letters only-ish
  if (!name || name.length < 3 || name.split(/\s+/).length > 6) return null;
  if (!/[a-zA-Z]/.test(name)) return null;
  return { name, headline };
}

// Normalise a LinkedIn profile URL (strip query, locale prefixes, trailing slash).
export function cleanLinkedInUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/linkedin\.com$/i.test(u.hostname.replace(/^([a-z]{2,3}\.)?/, 'linkedin.com'))
        && !u.hostname.toLowerCase().endsWith('linkedin.com')) return null;
    const m = u.pathname.match(/\/in\/[^/]+/i);
    if (!m) return null;
    return 'https://www.linkedin.com' + m[0].replace(/\/$/, '');
  } catch { return null; }
}

// Try to read the "current employer" from a headline like
// "Head of Retail at Reliance" -> Reliance
export function employerFromHeadline(headline) {
  if (!headline) return null;
  const m = headline.match(/\bat\s+([A-Z][\w&.,'’\- ]{1,60})/);
  if (m) return cleanEmployerName(m[1]);
  // "· Reliance" style
  const dot = headline.split('·').map(s => s.trim()).filter(Boolean);
  if (dot.length >= 2) return cleanEmployerName(dot[dot.length - 1]);
  return null;
}

// Reject leftover "Ex…"/"Former…" fragments and role phrases that aren't a
// real current employer.
export function cleanEmployerName(raw) {
  if (!raw) return null;
  const s = raw.replace(/[.,]\s*$/, '').trim();
  const low = s.toLowerCase();
  if (s.length < 2) return null;
  if (/^(ex(\b|[-\s])|former|formerly|previously|past\b|self\b|freelance|open to|looking|seeking)/i.test(low)) return null;
  if (s.split(/\s+/).length >= 3 &&
      /\b(architect|architecting|manager|director|\bhead\b|officer|engineer|analyst|consultant|specialist|coordinator|associate|intern|professional|logistics|supply\s*chain|operations|marketing|strategy|transformation)\b/i.test(low)) return null;
  if (s.split(/\s+/).length > 6) return null;
  return s;
}
