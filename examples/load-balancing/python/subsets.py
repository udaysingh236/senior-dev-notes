"""Subsetting: each frontend connects to only k of the backends. Two ways to choose the k.

  deterministic  frontends are grouped in rounds; each round shuffles the backend list with the
                 round number as the seed and deals it out in slices of k, so in every round each
                 backend lands in exactly one slice
  rendezvous     each frontend scores every backend with a hash of (frontend, backend) and keeps
                 the k highest scores: a random choice, but a stable one

For each it prints how many frontends each backend gets (the even answer is F * k / M), then
removes one backend and counts the connections frontends must open to new backends.

Run: python subsets.py
"""
F, M, K = 300, 300, 10  # frontends, backends, subset size


class Rng:
    """mulberry32, the same generator as the JavaScript version, so both print the same numbers."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    def shuffle(self, items: list) -> list:
        items = items[:]
        for i in range(len(items) - 1, 0, -1):
            j = int(self.next() * (i + 1))
            items[i], items[j] = items[j], items[i]
        return items


def mix(x: int) -> int:
    """A 32-bit integer hash (the murmur3 finaliser)."""
    x &= 0xFFFFFFFF
    x = ((x ^ (x >> 16)) * 0x85EBCA6B) & 0xFFFFFFFF
    x = ((x ^ (x >> 13)) * 0xC2B2AE35) & 0xFFFFFFFF
    return x ^ (x >> 16)


def deterministic_subset(frontend: int, backends: list[int]) -> set[int]:
    count = len(backends) // K               # slices per round
    round_no, slice_no = divmod(frontend, count)
    dealt = Rng(round_no + 1).shuffle(backends)  # every frontend in a round shuffles the same way
    return set(dealt[slice_no * K:(slice_no + 1) * K])


def rendezvous_subset(frontend: int, backends: list[int]) -> set[int]:
    return set(sorted(backends, key=lambda b: mix(frontend * 100_003 + b), reverse=True)[:K])


def report(name: str, choose) -> None:
    backends = list(range(M))
    before = [choose(f, backends) for f in range(F)]
    load = [0] * M
    for subset in before:
        for b in subset:
            load[b] += 1
    after = [choose(f, backends[1:]) for f in range(F)]  # backend 0 is removed
    opened = sum(len(after[f] - before[f]) for f in range(F))
    print(f"  {name:<14} frontends per backend: min {min(load):>2}  max {max(load):>2}"
          f"   remove one backend: {opened:>4} new connections")


def main() -> None:
    print(f"{F} frontends, {M} backends, each frontend connects to {K} (even answer: {F * K // M} per backend)")
    report("deterministic", deterministic_subset)
    report("rendezvous", rendezvous_subset)


if __name__ == "__main__":
    main()
