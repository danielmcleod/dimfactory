import unittest

from calc import add, mean


class CalcTest(unittest.TestCase):
    def test_add(self) -> None:
        self.assertEqual(add(2, 3), 5)

    def test_mean(self) -> None:
        self.assertEqual(mean([1, 2, 3]), 2)

    def test_mean_empty(self) -> None:
        with self.assertRaises(ValueError):
            mean([])


if __name__ == "__main__":
    unittest.main()
