"""Small arithmetic helpers for the py-small sandbox."""


def add(a: float, b: float) -> float:
    return a + b


def mean(values: list[float]) -> float:
    if not values:
        raise ValueError("mean() of an empty list")
    return sum(values) / len(values)
