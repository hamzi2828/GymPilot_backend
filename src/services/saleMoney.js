// src/services/saleMoney.js
//
// What a till sale cost the gym and what it made: the one rule behind the
// POS screen's cost and profit and the reports' top products, so the two
// cannot disagree.
//
// Prices include tax, and the tax is not the gym's. A sale's profit is what
// was taken less the tax in it and less the cost -- so a basket discount
// comes off it too, since what was taken is after the discount. The cost is
// the product's cost when it was sold (unitCost is snapshotted on the line).
//
// A product's profit is its lines' part of that: each line's share of the
// sale's takings less tax -- its total over all the lines' totals -- less
// its own cost. Over a sale the shares add back up to the sale's profit. The
// tax is shared over every line of the sale, because a line does not record
// whether its product was taxable; in a basket that is all taxable (the
// usual case) each line's share is exactly its own tax.
//
// A line's margin on a receipt is a different figure, on purpose: its price
// against its cost as rung up, before the tax and any discount.

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** A sale's cost and profit, and each line's cost and margin. */
function saleMoney(s) {
  const lines = (s.items || []).map((i) => {
    const cost = round((i.unitCost || 0) * i.quantity);
    return { unit_cost: i.unitCost || 0, cost, margin: round(i.total - cost) };
  });
  const cost = round(lines.reduce((sum, l) => sum + l.cost, 0));
  return { lines, cost, profit: round((s.total || 0) - (s.taxAmount || 0) - cost) };
}

/**
 * Aggregation stages that turn sales into their lines, one document per
 * line (`items` is the line), each with `lineProfit`: its share of the
 * sale's takings less tax, less its cost -- the profit saleMoney() gives the
 * whole sale, line by line. Unrounded, so a caller adding lines up rounds
 * once.
 */
function saleLineStages() {
  const takings = { $subtract: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$taxAmount', 0] }] };
  return [
    // Read from the lines themselves rather than the stored subtotal, which
    // is the same figure on every receipt the till writes.
    { $addFields: { linesTotal: { $sum: '$items.total' } } },
    { $unwind: '$items' },
    {
      $addFields: {
        lineProfit: {
          $subtract: [
            { $cond: [{ $gt: ['$linesTotal', 0] }, { $multiply: [takings, { $divide: ['$items.total', '$linesTotal'] }] }, 0] },
            { $multiply: ['$items.quantity', { $ifNull: ['$items.unitCost', 0] }] }
          ]
        }
      }
    }
  ];
}

module.exports = { saleMoney, saleLineStages };
