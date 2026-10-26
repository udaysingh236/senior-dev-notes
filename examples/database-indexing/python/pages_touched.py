"""Why an index stops paying off: the share of pages a query touches, and where a full scan wins.

Run: python pages_touched.py   (Python 3.11+, standard library only)
"""

ROWS_PER_PAGE = 58     # our Postgres orders table: about 58 rows in each 8 KB page
TABLE_PAGES = 86_168   # 5,000,000 rows


def pages_touched(selectivity: float, rows_per_page: int = ROWS_PER_PAGE) -> float:
    """Share of pages holding at least one matching row, when the matches are spread at random.

    A page escapes only if none of its rows match: (1 - selectivity) ** rows_per_page.
    """
    return 1 - (1 - selectivity) ** rows_per_page


def crossover(rows_per_page: int, random_page_cost: float) -> float:
    """Selectivity below which an uncorrelated index scan costs less than reading every page.

    Index scan: one random heap read per matching row = rows * selectivity * random_page_cost.
    Full scan:  every page once, in order             = pages * 1 = rows / rows_per_page.
    Ignores caching and CPU, so it marks where the index starts to lose, not an exact number.
    """
    return 1 / (rows_per_page * random_page_cost)


def main() -> None:
    print("rows matched   pages touched   of 86,168")
    for pct in (0.01, 0.1, 1, 2, 5, 25):
        share = pages_touched(pct / 100)
        print(f"{pct:>11}%   {share:>12.1%}   {share * TABLE_PAGES:>9,.0f}")

    print("\nrandom_page_cost   index scan loses above")
    for cost in (4.0, 2.0, 1.1):
        print(f"{cost:>16}   {crossover(ROWS_PER_PAGE, cost):>20.2%} of rows")


if __name__ == "__main__":
    main()
