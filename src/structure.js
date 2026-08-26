/**
 * Structural fingerprinting for change tracking.
 *
 * A signature is deliberately small — the tag vocabulary of a document plus
 * how its elements are distributed by nesting depth — so a caller can store it
 * next to a baseline (the REST API keeps baselines in Redis) instead of
 * keeping the whole DOM around.
 */

/**
 * Reduce a parsed document to a comparable structural signature.
 *
 * Pass `root` to fingerprint one subtree — a caller tracking a CSS selector
 * wants a score for that region, not for edits elsewhere on the page. Depths
 * stay absolute either way, which is harmless because both sides of a
 * comparison are measured the same way.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} [root]
 * @returns {{ tags: string[], depths: Record<string, number> }}
 */
export function structureSignature($, root) {
  const tags = new Set();
  const depths = {};

  (root ? root.find('*') : $('*')).each((_, element) => {
    if (!element.name) return;
    tags.add(element.name);

    // Walked off the node itself rather than through cheerio's parents(),
    // which allocates a wrapper object and an array per element.
    let depth = 0;
    for (let parent = element.parent; parent; parent = parent.parent) depth++;
    depths[depth] = (depths[depth] || 0) + 1;
  });

  return { tags: [...tags].sort(), depths };
}

/**
 * Compare two signatures. 1 means the documents are built from the same tags
 * in the same depth distribution; 0 means they share nothing.
 *
 * @param {{ tags?: string[], depths?: Record<string, number> }} baseline
 * @param {{ tags?: string[], depths?: Record<string, number> }} current
 * @returns {number} 0-1
 */
export function structuralSimilarity(baseline, current) {
  if (!baseline || !current) return 0;

  const baselineTags = baseline.tags ?? [];
  const currentTags = current.tags ?? [];
  if (baselineTags.length === 0 && currentTags.length === 0) return 1;
  if (baselineTags.length === 0 || currentTags.length === 0) return 0;

  const score =
    (tagSimilarity(baselineTags, currentTags) +
      depthSimilarity(baseline.depths, current.depths)) /
    2;

  // Clamp defensively — this is a 0-1 metric and must never leave that range.
  return Math.max(0, Math.min(1, score));
}

/**
 * Jaccard overlap of the two tag vocabularies. Both sides are de-duplicated
 * first: intersecting a duplicate-laden list against a set union let repeated
 * tags inflate the numerator, which is how this once returned 1.05.
 */
function tagSimilarity(baselineTags, currentTags) {
  const baseline = new Set(baselineTags);
  const current = new Set(currentTags);

  let intersection = 0;
  for (const tag of baseline) {
    if (current.has(tag)) intersection++;
  }

  const union = baseline.size + current.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Weighted Jaccard over the depth histograms: how much of the two documents'
 * element mass sits at the same nesting depth.
 *
 * This half used to compare nothing. `hierarchy` was initialised to {} and
 * never written, so the comparison was `0 === 0` and returned a constant 1 —
 * which pinned every structural score at (tagSimilarity + 1) / 2 and meant a
 * page could never score below 0.5 however much its structure changed.
 */
function depthSimilarity(baseline, current) {
  if (!baseline || !current) return 0;

  const depths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  if (depths.size === 0) return 1;

  let shared = 0;
  let total = 0;
  for (const depth of depths) {
    const a = baseline[depth] || 0;
    const b = current[depth] || 0;
    shared += Math.min(a, b);
    total += Math.max(a, b);
  }

  return total === 0 ? 1 : shared / total;
}
