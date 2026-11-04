"""Writes one pgbench script per loading strategy for "list a page of N orders with their
customer and line items".

pgbench cannot read a column of one result into a loop, so the scripts compute the ids that the
first query returns: the page is orders :o to :o+N-1, and order i belongs to customer
(i * 7919) % 10000 + 1, which is how run.sh generated the data. The SQL sent to the server is
what an ORM sends.

    python3 gen_scripts.py OUT_DIR N
"""

import sys
from pathlib import Path

ORDER_COLS = "o.id, o.customer_id, o.status, o.total_cents, o.created_at"
CUSTOMER_COLS = "c.id, c.name, c.email, c.country"
ITEM_COLS = "i.id, i.order_id, i.sku, i.qty, i.price_cents"


def header(n: int) -> list[str]:
    lines = [f"\\set o random(1, {100_000 - n})"]
    for k in range(n):
        lines.append(f"\\set o{k} :o + {k}")
        lines.append(f"\\set c{k} (:o{k} * 7919) % 10000 + 1")
    return lines


def page_query(n: int) -> str:
    return f"SELECT {ORDER_COLS} FROM orders o WHERE o.id >= :o ORDER BY o.id LIMIT {n};"


def n_plus_one(n: int, pipelined: bool = False) -> str:
    lines = header(n)
    if pipelined:
        lines.append("\\startpipeline")
    lines.append(page_query(n))
    for k in range(n):
        lines.append(f"SELECT {CUSTOMER_COLS} FROM customers c WHERE c.id = :c{k};")
        lines.append(f"SELECT {ITEM_COLS} FROM order_items i WHERE i.order_id = :o{k};")
    if pipelined:
        lines.append("\\endpipeline")
    return "\n".join(lines) + "\n"


def batched(n: int) -> str:
    customers = ", ".join(f":c{k}" for k in range(n))
    orders = ", ".join(f":o{k}" for k in range(n))
    return "\n".join(header(n) + [
        page_query(n),
        f"SELECT {CUSTOMER_COLS} FROM customers c WHERE c.id IN ({customers});",
        f"SELECT {ITEM_COLS} FROM order_items i WHERE i.order_id IN ({orders});",
    ]) + "\n"


def joined(n: int) -> str:
    return "\n".join([
        f"\\set o random(1, {100_000 - n})",
        f"SELECT {ORDER_COLS}, {CUSTOMER_COLS}, {ITEM_COLS}"
        f" FROM (SELECT * FROM orders WHERE id >= :o ORDER BY id LIMIT {n}) o"
        " JOIN customers c ON c.id = o.customer_id"
        " LEFT JOIN order_items i ON i.order_id = o.id ORDER BY o.id, i.id;",
    ]) + "\n"


def json_agg(n: int) -> str:
    return "\n".join([
        f"\\set o random(1, {100_000 - n})",
        f"SELECT {ORDER_COLS}, {CUSTOMER_COLS}, items.list"
        f" FROM (SELECT * FROM orders WHERE id >= :o ORDER BY id LIMIT {n}) o"
        " JOIN customers c ON c.id = o.customer_id"
        " CROSS JOIN LATERAL (SELECT json_agg(json_build_array(i.id, i.sku, i.qty, i.price_cents) ORDER BY i.id) AS list"
        "   FROM order_items i WHERE i.order_id = o.id) items ORDER BY o.id;",
    ]) + "\n"


def two_collections_joined(n: int) -> str:
    """Items and payments in one JOIN: every item row is repeated for every payment."""
    return "\n".join([
        f"\\set o random(1, {100_000 - n})",
        f"SELECT {ORDER_COLS}, {ITEM_COLS}, p.id, p.method, p.amount_cents"
        f" FROM (SELECT * FROM orders WHERE id >= :o ORDER BY id LIMIT {n}) o"
        " LEFT JOIN order_items i ON i.order_id = o.id"
        " LEFT JOIN payments p ON p.order_id = o.id ORDER BY o.id, i.id, p.id;",
    ]) + "\n"


def two_collections_batched(n: int) -> str:
    orders = ", ".join(f":o{k}" for k in range(n))
    return "\n".join(header(n) + [
        page_query(n),
        f"SELECT {ITEM_COLS} FROM order_items i WHERE i.order_id IN ({orders});",
        f"SELECT p.id, p.order_id, p.method, p.amount_cents FROM payments p WHERE p.order_id IN ({orders});",
    ]) + "\n"


if __name__ == "__main__":
    out, n = Path(sys.argv[1]), int(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for name, build in {
        "n_plus_one": n_plus_one,
        "pipelined": lambda n: n_plus_one(n, pipelined=True),
        "batched": batched,
        "joined": joined,
        "json_agg": json_agg,
        "two_joined": two_collections_joined,
        "two_batched": two_collections_batched,
    }.items():
        (out / f"{name}_{n}.sql").write_text(build(n))
