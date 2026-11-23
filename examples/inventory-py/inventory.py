"""A tiny inventory with reservations."""


class OutOfStock(Exception):
    pass


class Inventory:
    def __init__(self):
        self._stock = {}

    def add(self, sku, quantity):
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        self._stock[sku] = self._stock.get(sku, 0) + quantity

    def available(self, sku):
        return self._stock.get(sku, 0)

    def reserve(self, sku, quantity):
        if self.available(sku) < quantity:
            raise OutOfStock(sku)
        self._stock[sku] -= quantity
        return quantity
