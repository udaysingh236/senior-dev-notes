"""Weighted round robin, two ways, for weights a=5, b=1, c=1.

  blocks   send each backend `weight` requests in a row: a a a a a b c
  smooth   nginx's rule: every pick, add each backend's weight to its counter, choose the highest
           counter, and subtract the total weight from the winner. Same shares, spread out.

Run: python weighted.py
"""


def blocks(weights: dict[str, int], picks: int) -> list[str]:
    cycle = [name for name, w in weights.items() for _ in range(w)]
    return [cycle[i % len(cycle)] for i in range(picks)]


def smooth(weights: dict[str, int], picks: int, trace: bool = False) -> list[str]:
    total = sum(weights.values())
    current = {name: 0 for name in weights}
    order = []
    for _ in range(picks):
        for name, w in weights.items():
            current[name] += w
        best = max(current, key=current.get)  # ties go to the first listed
        if trace:
            print("  counters", "  ".join(f"{n}={c:>2}" for n, c in current.items()), " ->", best)
        current[best] -= total
        order.append(best)
    return order


def main() -> None:
    weights = {"a": 5, "b": 1, "c": 1}
    print("blocks:", " ".join(blocks(weights, 7)))
    print("smooth, step by step:")
    print("smooth:", " ".join(smooth(weights, 7, trace=True)))


if __name__ == "__main__":
    main()
