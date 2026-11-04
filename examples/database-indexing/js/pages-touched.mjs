// Why an index stops paying off: the share of pages a query touches, and where a full scan wins.
// Run: node pages-touched.mjs   (Node 20+, nothing to install)

const ROWS_PER_PAGE = 58; // our Postgres orders table: about 58 rows in each 8 KB page
const TABLE_PAGES = 86_168; // 5,000,000 rows

/**
 * Share of pages holding at least one matching row, when the matches are spread at random.
 * A page escapes only if none of its rows match: (1 - selectivity) ** rowsPerPage.
 */
const pagesTouched = (selectivity, rowsPerPage = ROWS_PER_PAGE) => 1 - (1 - selectivity) ** rowsPerPage;

/**
 * Selectivity below which an uncorrelated index scan costs less than reading every page.
 * Index scan: one random heap read per matching row = rows * selectivity * randomPageCost.
 * Full scan:  every page once, in order             = pages * 1 = rows / rowsPerPage.
 * Ignores caching and CPU, so it marks where the index starts to lose, not an exact number.
 */
const crossover = (rowsPerPage, randomPageCost) => 1 / (rowsPerPage * randomPageCost);

const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log('rows matched   pages touched   of 86,168');
for (const p of [0.01, 0.1, 1, 2, 5, 25]) {
  const share = pagesTouched(p / 100);
  const pages = Math.round(share * TABLE_PAGES).toLocaleString('en-US');
  console.log(`${`${p}%`.padStart(12)}   ${pct(share).padStart(12)}   ${pages.padStart(9)}`);
}

console.log('\nrandom_page_cost   index scan loses above');
for (const cost of [4.0, 2.0, 1.1]) {
  const at = `${(crossover(ROWS_PER_PAGE, cost) * 100).toFixed(2)}% of rows`;
  console.log(`${cost.toFixed(1).padStart(16)}   ${at.padStart(28)}`);
}
