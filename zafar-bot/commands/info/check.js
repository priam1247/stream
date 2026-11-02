'use strict';

const meta = require('./command.json');
const { parseArgs, render, lookup } = require('./lookup');

async function check() {
  // stage 1 — offline: parsing and rendering are pure and must always work
  const movie = parseArgs(['Inception']);
  if (movie.type !== 'movie' || movie.title !== 'Inception') throw new Error('movie parsing broke');

  const series = parseArgs(['series', 'Breaking', 'Bad']);
  if (series.type !== 'series' || series.title !== 'Breaking Bad') throw new Error('series parsing broke');

  const card = render({ type: 'movie', title: 'Inception', year: '2010', rating: '8.8', runtime: '148', genres: ['Action'] });
  if (!card.includes('🎬 *Inception* (2010)')) throw new Error(`card rendering changed: ${card}`);
  if (!card.includes('⭐ 8.8')) throw new Error('card lost the rating line');

  // stage 2 — network: the real lookup
  const item = await lookup(meta.sample, 'movie');
  if (!item) throw new Error(`Cinemeta found nothing for "${meta.sample}"`);
  return `${item.title} (${item.year})`;
}

if (require.main === module) {
  check().then((d) => console.log(`✅ ${meta.name} — ${d}`))
    .catch((e) => { console.log(`❌ ${meta.name} — ${e.code ? e.code + ': ' : ''}${e.message}`); process.exit(1); });
}
module.exports = { check };
