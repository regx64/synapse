import unittest

from inventory import Inventory, OutOfStock


class InventoryTest(unittest.TestCase):
    def test_add_and_reserve(self):
        inv = Inventory()
        inv.add("tea", 5)
        self.assertEqual(inv.reserve("tea", 2), 2)
        self.assertEqual(inv.available("tea"), 3)

    def test_out_of_stock(self):
        inv = Inventory()
        inv.add("mug", 1)
        with self.assertRaises(OutOfStock):
            inv.reserve("mug", 2)

    def test_rejects_non_positive(self):
        with self.assertRaises(ValueError):
            Inventory().add("tea", 0)


if __name__ == "__main__":
    unittest.main()
