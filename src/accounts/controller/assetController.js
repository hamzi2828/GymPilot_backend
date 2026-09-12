// src/accounts/controller/assetController.js
//
// The equipment register. Two audiences read the same rows: an accountant
// wanting book value, and a manager wanting to know which treadmill is overdue
// a service. Both are served from one list rather than two, because they are
// facts about the same machine.

const mongoose = require('mongoose');

const Asset = require('../models/assetModel');
const Expense = require('../models/expenseModel');
const L = require('../services/ledger');
const T = require('../../attendance/services/timeUtils');

const CONDITIONS = ['new', 'good', 'fair', 'poor', 'unusable'];
const STATUSES = ['active', 'maintenance', 'retired', 'sold', 'lost'];

// AST-0042, printed on the sticker that goes on the machine.
async function nextTag() {
  const last = await Asset.findOne({ tag: /^AST-/ }).sort({ tag: -1 }).select('tag').lean();
  let sequence = 1;
  if (last) {
    const parsed = parseInt(String(last.tag).slice(4), 10);
    if (!Number.isNaN(parsed)) sequence = parsed + 1;
  }
  return 'AST-' + String(sequence).padStart(4, '0');
}

function readDate(value, fallback = null) {
  if (!value) return fallback;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }
  return L.localInstant(text, 12, 0);
}

function shape(asset, now = new Date()) {
  const value = L.depreciate(asset, now);
  const dueDate = asset.nextServiceDue ? new Date(asset.nextServiceDue) : null;
  const daysToService = dueDate ? Math.ceil((dueDate.getTime() - now.getTime()) / L.DAY_MS) : null;

  return {
    id: String(asset._id),
    tag: asset.tag,
    name: asset.name,
    category: asset.category,
    category_label: Asset.CATEGORY_LABELS[asset.category] || asset.category,

    quantity: asset.quantity || 1,
    unit_cost: L.round(asset.unitCost),
    total_cost: value.cost,
    currency: asset.currency,

    purchased_on: asset.purchasedOn,
    purchased_label: asset.purchasedOn ? T.dateLabel(asset.purchasedOn) : null,
    supplier: asset.supplier || '',
    invoice_no: asset.invoiceNo || '',
    serial_number: asset.serialNumber || '',
    warranty_until: asset.warrantyUntil,
    warranty_label: asset.warrantyUntil ? T.dateLabel(asset.warrantyUntil) : null,
    warranty_active: asset.warrantyUntil ? new Date(asset.warrantyUntil) >= now : false,

    location: asset.location || '',
    condition: asset.condition,
    status: asset.status,

    useful_life_years: asset.usefulLifeYears || 0,
    salvage_value: L.round(asset.salvageValue),
    age_years: value.age_years,
    depreciation: value.depreciation,
    book_value: value.book_value,
    fully_depreciated: value.fully_depreciated,

    last_serviced_on: asset.lastServicedOn,
    last_serviced_label: asset.lastServicedOn ? T.dateLabel(asset.lastServicedOn) : null,
    next_service_due: asset.nextServiceDue,
    next_service_label: asset.nextServiceDue ? T.dateLabel(asset.nextServiceDue) : null,
    service_interval_days: asset.serviceIntervalDays || 0,
    days_to_service: daysToService,
    // The flag the floor manager is actually looking for.
    service_overdue: daysToService !== null && daysToService < 0 && asset.status !== 'retired',

    disposed_on: asset.disposedOn,
    disposal_amount: L.round(asset.disposalAmount),
    notes: asset.notes || ''
  };
}

// A text field from the body, or what is stored when the body leaves it out.
function text(value, current) {
  return value !== undefined ? String(value || '').trim() : current || '';
}

// A non-negative number from the body, or what is stored when it is absent
// (an empty string from a cleared input counts as zero, as it always did).
function amount(value, current) {
  return value !== undefined ? Math.max(0, Number(value) || 0) : Number(current) || 0;
}

async function readBody(body, existing = {}) {
  if (!body.name || !String(body.name).trim()) throw new Error('Give the asset a name');

  const category = Asset.CATEGORIES.includes(body.category) ? body.category : 'other';
  const purchasedOn = readDate(body.purchasedOn, existing.purchasedOn || null);

  const patch = {
    name: String(body.name).trim(),
    category,
    quantity: Math.max(1, Number(body.quantity) || 1),
    unitCost: Math.max(0, Number(body.unitCost) || 0),
    currency: String(body.currency || existing.currency || (await L.baseCurrency())).toUpperCase(),
    purchasedOn,
    // Partial-update semantics for the optional details: a body that does
    // not mention a field keeps what is stored, and '' or null clears it --
    // so editing the location cannot wipe the warranty date or invoice
    // number the operator typed in last month.
    supplier: text(body.supplier, existing.supplier),
    invoiceNo: text(body.invoiceNo, existing.invoiceNo),
    serialNumber: text(body.serialNumber, existing.serialNumber),
    warrantyUntil: body.warrantyUntil !== undefined ? readDate(body.warrantyUntil, null) : existing.warrantyUntil || null,
    location: text(body.location, existing.location),
    condition: CONDITIONS.includes(body.condition) ? body.condition : existing.condition || 'good',
    status: STATUSES.includes(body.status) ? body.status : existing.status || 'active',
    // Defaulted from the category rather than left at zero: an asset with no
    // useful life never depreciates, which quietly overstates what the gym owns.
    usefulLifeYears:
      body.usefulLifeYears !== undefined && body.usefulLifeYears !== ''
        ? Math.max(0, Number(body.usefulLifeYears) || 0)
        : existing.usefulLifeYears || Asset.DEFAULT_LIFE_YEARS[category] || 5,
    salvageValue: amount(body.salvageValue, existing.salvageValue),
    serviceIntervalDays: amount(body.serviceIntervalDays, existing.serviceIntervalDays),
    lastServicedOn: readDate(body.lastServicedOn, existing.lastServicedOn || null),
    disposedOn: readDate(body.disposedOn, existing.disposedOn || null),
    disposalAmount: amount(body.disposalAmount, existing.disposalAmount),
    notes: text(body.notes, existing.notes)
  };

  // The next service is derived from the last one plus the interval, so an
  // operator maintains one date instead of two that drift apart.
  if (body.nextServiceDue) {
    patch.nextServiceDue = readDate(body.nextServiceDue, null);
  } else if (patch.serviceIntervalDays && patch.lastServicedOn) {
    patch.nextServiceDue = new Date(patch.lastServicedOn.getTime() + patch.serviceIntervalDays * L.DAY_MS);
  } else {
    patch.nextServiceDue = existing.nextServiceDue || null;
  }

  return patch;
}

module.exports = {
  // GET /api/accounts/assets
  list: async (req, res) => {
    try {
      const base = await L.baseCurrency();
      const now = new Date();

      const filter = {};
      if (req.query.category && req.query.category !== 'all') filter.category = String(req.query.category);
      if (req.query.status && req.query.status !== 'all') filter.status = String(req.query.status);
      if (req.query.condition && req.query.condition !== 'all') filter.condition = String(req.query.condition);

      const term = String(req.query.q || '').trim();
      if (term) {
        const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: rx }, { tag: rx }, { supplier: rx }, { serialNumber: rx }, { location: rx }];
      }

      let rows = await Asset.find(filter).sort({ createdAt: -1 }).lean();
      const shaped = rows.map((row) => shape(row, now));

      // Applied after shaping because "overdue" is derived, not stored.
      const due = String(req.query.service || 'all');
      const visible =
        due === 'overdue'
          ? shaped.filter((row) => row.service_overdue)
          : due === 'soon'
          ? shaped.filter((row) => row.days_to_service !== null && row.days_to_service >= 0 && row.days_to_service <= 30)
          : shaped;

      const cost = {};
      const book = {};
      const byCategory = new Map();

      for (const row of shaped) {
        if (row.status === 'sold' || row.status === 'lost') continue;
        L.addTo(cost, row.currency, row.total_cost);
        L.addTo(book, row.currency, row.book_value);

        const entry = byCategory.get(row.category) || {
          category: row.category,
          label: row.category_label,
          count: 0,
          totals: {}
        };
        entry.count += row.quantity;
        L.addTo(entry.totals, row.currency, row.book_value);
        byCategory.set(row.category, entry);
      }

      return res.json({
        success: true,
        base_currency: base,
        currency_notice: await L.currencyNotice(),
        categories: Asset.CATEGORIES.map((key) => ({
          key,
          label: Asset.CATEGORY_LABELS[key],
          default_life: Asset.DEFAULT_LIFE_YEARS[key]
        })),
        conditions: CONDITIONS,
        statuses: STATUSES,
        summary: {
          count: shaped.length,
          units: shaped.reduce((sum, row) => sum + (row.status === 'sold' ? 0 : row.quantity), 0),
          cost: L.presentTotals(cost, base),
          book_value: L.presentTotals(book, base),
          service_overdue: shaped.filter((row) => row.service_overdue).length,
          service_soon: shaped.filter(
            (row) => row.days_to_service !== null && row.days_to_service >= 0 && row.days_to_service <= 30
          ).length,
          needs_attention: shaped.filter((row) => ['poor', 'unusable'].includes(row.condition)).length,
          by_category: [...byCategory.values()]
            .map((entry) => ({ ...entry, totals: L.presentTotals(entry.totals, base) }))
            .sort((a, b) => b.totals.base_amount - a.totals.base_amount)
        },
        assets: visible
      });
    } catch (error) {
      console.error('[accounts] assets list failed:', error);
      return res.status(500).json({ message: 'Could not load the asset register', error: error.message });
    }
  },

  // POST /api/accounts/assets
  create: async (req, res) => {
    try {
      const patch = await readBody(req.body || {});
      const asset = await Asset.create({
        ...patch,
        tag: await nextTag(),
        createdBy: req.user && req.user.id,
        createdByName: req.user ? [req.user.firstName, req.user.lastName].filter(Boolean).join(' ').trim() : ''
      });

      // Buying it was also a cost. Recording that here, on request, keeps the
      // register and the ledger agreeing without the operator entering the
      // same purchase twice.
      let expense = null;
      if (req.body.recordExpense && patch.unitCost > 0) {
        const total = patch.unitCost * patch.quantity;
        const incurredOn = patch.purchasedOn || new Date();
        const prefix = `EXP-${T.dateKey(incurredOn).slice(0, 7).replace('-', '')}-`;
        const last = await Expense.findOne({ reference: new RegExp('^' + prefix) })
          .sort({ reference: -1 })
          .select('reference')
          .lean();
        const sequence = last ? (parseInt(String(last.reference).slice(prefix.length), 10) || 0) + 1 : 1;

        expense = await Expense.create({
          reference: prefix + String(sequence).padStart(4, '0'),
          title: `${asset.name} (${asset.tag})`,
          category: 'equipment',
          amount: total,
          currency: asset.currency,
          incurredOn,
          paidOn: incurredOn,
          status: 'paid',
          paymentMethod: req.body.paymentMethod || 'bank_transfer',
          vendor: asset.supplier || '',
          assetId: asset._id,
          notes: 'Recorded with the asset register entry.',
          createdBy: req.user && req.user.id,
          createdByName: req.user ? [req.user.firstName, req.user.lastName].filter(Boolean).join(' ').trim() : ''
        });
      }

      return res.status(201).json({
        success: true,
        message: expense
          ? `${asset.tag} added to the register, and ${expense.reference} recorded as an expense.`
          : `${asset.tag} added to the register.`,
        asset: shape(asset)
      });
    } catch (error) {
      console.error('[accounts] asset create failed:', error);
      return res.status(400).json({ message: error.message || 'Could not add this asset' });
    }
  },

  // PUT /api/accounts/assets/:id
  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid asset id' });

      const asset = await Asset.findById(id);
      if (!asset) return res.status(404).json({ message: 'Asset not found' });

      const patch = await readBody(req.body || {}, asset.toObject());
      Object.assign(asset, patch);
      await asset.save();

      return res.json({ success: true, message: `${asset.tag} updated.`, asset: shape(asset) });
    } catch (error) {
      console.error('[accounts] asset update failed:', error);
      return res.status(400).json({ message: error.message || 'Could not update this asset' });
    }
  },

  // POST /api/accounts/assets/:id/service
  //
  // "It was serviced today" as one click, because that is how the fact reaches
  // the system -- an engineer leaves and somebody records it in passing.
  logService: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid asset id' });

      const asset = await Asset.findById(id);
      if (!asset) return res.status(404).json({ message: 'Asset not found' });

      const servicedOn = readDate(req.body && req.body.servicedOn, new Date());
      asset.lastServicedOn = servicedOn;

      const interval = Number(req.body && req.body.serviceIntervalDays) || asset.serviceIntervalDays || 0;
      asset.serviceIntervalDays = interval;
      asset.nextServiceDue = interval ? new Date(servicedOn.getTime() + interval * L.DAY_MS) : null;

      if (req.body && CONDITIONS.includes(req.body.condition)) asset.condition = req.body.condition;
      // A machine that was in for repair is back in use once it is serviced.
      if (asset.status === 'maintenance') asset.status = 'active';

      if (req.body && req.body.notes) {
        asset.notes = [asset.notes, `${T.dateLabel(servicedOn)}: ${String(req.body.notes).trim()}`]
          .filter(Boolean)
          .join('\n');
      }

      await asset.save();

      return res.json({
        success: true,
        message: asset.nextServiceDue
          ? `${asset.tag} serviced. Next due ${T.dateLabel(asset.nextServiceDue)}.`
          : `${asset.tag} serviced.`,
        asset: shape(asset)
      });
    } catch (error) {
      console.error('[accounts] service log failed:', error);
      return res.status(400).json({ message: 'Could not log that service', error: error.message });
    }
  },

  // DELETE /api/accounts/assets/:id
  remove: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid asset id' });

      const asset = await Asset.findByIdAndDelete(id);
      if (!asset) return res.status(404).json({ message: 'Asset not found' });

      // The purchase stays in the ledger: the gym did spend that money, and
      // deleting the cost because the machine is gone would rewrite a closed
      // month. The link is cleared so nothing points at a missing row.
      await Expense.updateMany({ assetId: asset._id }, { $set: { assetId: null } });

      return res.json({
        success: true,
        message: `${asset.tag} removed from the register. Any purchase expense was kept.`
      });
    } catch (error) {
      console.error('[accounts] asset delete failed:', error);
      return res.status(400).json({ message: 'Could not remove this asset', error: error.message });
    }
  }
};
