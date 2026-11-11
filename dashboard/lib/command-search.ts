/**
 * Ranked, typo-tolerant search for the command reference.
 *
 * Split out of the old `embed-utils` module: that module's iframe/embed helpers
 * had no production callers (only a `LazyEmbed` component that nothing imported),
 * while this ranking is the one piece the command directory actually uses.
 */

/** Characters of `term` appear in `text` in order ("ytb" in "youtube"). */
export function isSubsequence(term: string, text: string): boolean {
  let index = 0;
  for (const character of text) {
    if (character === term[index]) index++;
    if (index === term.length) return true;
  }
  return false;
}

const SCORE = Object.freeze({
  exact: 120,
  prefix: 100,
  includes: 70,
  keywordPrefix: 50,
  keywordIncludes: 35,
  detail: 20,
  subsequence: 10,
});

export interface SearchableCommand {
  name: string;
  aliases: string[];
  summary: string;
  usage: string;
}

/**
 * Every query term must match somewhere in the command. Returns 0 for a
 * non-match and a positive score used to order results. This replaces a plain
 * `includes` filter with ranked, typo-tolerant matching while keeping the same
 * fields searchable.
 */
export function scoreCommandQuery(query: string, command: SearchableCommand): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  const title = command.name.toLowerCase();
  const keywords = command.aliases.map((alias) => alias.toLowerCase());
  const detail = `${command.summary} ${command.usage}`.toLowerCase();

  let total = 0;
  for (const term of terms) {
    let score = 0;
    if (title === term) score = SCORE.exact;
    else if (title.startsWith(term)) score = SCORE.prefix;
    else if (title.includes(term)) score = SCORE.includes;
    else {
      for (const keyword of keywords) {
        if (keyword.startsWith(term)) score = Math.max(score, SCORE.keywordPrefix);
        else if (keyword.includes(term)) score = Math.max(score, SCORE.keywordIncludes);
      }
      if (!score && detail.includes(term)) score = SCORE.detail;
      if (!score && term.length >= 3 && isSubsequence(term, title)) score = SCORE.subsequence;
    }
    if (!score) return 0;
    total += score;
  }
  return total;
}
