// src/accounts/controller/expenseController.js
//
// CRUD for money going out, plus the per-category summary the list is read
// alongside. Deliberately kept as a normal ledger: rows are edited and deleted
// rather than reversed with contra-entries, because the people using this are
// running a gym, not closing audited books.

const mongoose = require('mongoose');

const Expense = require('../models/expenseModel');
const Asset = require('../models/assetModel');
const User = require('../../models/user');
const L = require('../services/ledger');
const categories = require('../services/categories');
const T = require('../../attendance/services/timeUtils');
const { parseAmount } = require('../../helper/money');
const { EXPENSE_METHODS, expenseMethodLabel, readExpenseMethod } = require('../../services/paymentMethods');

// How a bill can be paid (services/paymentMethods.js): JazzCash and
// Easypaisa as well as cash and the bank. An unknown method is refused, never
// quietly filed as cash.
const METHODS = EXPENSE_METHODS;
const STATUSES = ['pending', 'paid', 'cancelled'];

// EXP-202608-0007. Sequential within the month it is filed against, so the
// reference itself says which period the receipt belongs to.
async function nextReference(incurredOn) {
  const prefix = `EXP-${T.dateKey(incurredOn).slice(0, 7).replace('-', '')}-`;
  const last = await Expense.findOne({ reference: new RegExp('^' + prefix) })
    .sort({ reference: -1 })
    .select('reference')
    .lean();

  let sequence = 1;
  if (last) {
    const parsed = parseInt(String(last.reference).slice(prefix.length), 10);
    if (!Number.isNaN(parsed)) sequence = parsed + 1;
  }
  return prefix + String(sequence).padStart(4, '0');
}

// `heads` (services/categories.headsFor('expense')) names the gym's own heads;
// without it only the built-in ones have a label.
function shape(expense, heads = null) {
  return {
    id: String(expense._id),
    reference: expense.reference,
    title: expense.title,
    category: expense.category,
    category_label: heads ? heads.labelOf(expense.category) : Expense.CATEGORY_LABELS[expense.category] || expense.category,
    amount: L.round(expense.amount),
    currency: expense.currency,
    incurred_on: expense.incurredOn,
    incurred_label: expense.incurredOn ? T.dateLabel(expense.incurredOn) : null,
    paid_on: expense.paidOn,
    paid_label: expense.paidOn ? T.dateLabel(expense.paidOn) : null,
    status: expense.status,
    payment_method: expense.paymentMethod,
    payment_method_label: expenseMethodLabel(expense.paymentMethod),
    vendor: expense.vendor || '',
    reference_no: expense.reference_no || '',
    notes: expense.notes || '',
    recurring: {
      is_recurring: !!(expense.recurring && expense.recurring.isRecurring),
      cycle: (expense.recurring && expense.recurring.cycle) || 'monthly'
    },
    staff_id: expense.staffId ? String(expense.staffId) : null,
    staff_name: expense.staffName || '',
    asset_id: expense.assetId ? String(expense.assetId) : null,
    created_by: expense.createdByName || ''
  };
}

// Dates arrive as 'YYYY-MM-DD' from a date input and must land on the gym's
// local day, not on midnight UTC -- which in Karachi is 5am the same morning
// and, five hours a day, the wrong date entirely.
function readDate(value, fallback = null) {
  if (!value) return fallback;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }
  return L.localInstant(text, 12, 0);
}

async function readBody(body, existing = {}, heads = null) {
  // Typed as the gym writes money -- "1,20,000", "Rs 5,000" -- and read
  // exactly as a package price is (helper/money.js parseAmount).
  const amount = parseAmount(body.amount);
  if (!body.title || !String(body.title).trim()) throw new Error('Give the expense a title');
  if (amount === null || !Number.isFinite(amount) || amount < 0) throw new Error('Enter a valid amount, like 5000 or 1,20,000');
  const paid = readExpenseMethod(body.paymentMethod, { fallback: 'cash', current: existing.paymentMethod || null });
  if (paid.problem) throw new Error(paid.problem);

  // A built-in head or one of the gym's own that is not archived; a row
  // already filed under an archived head keeps it.
  const category = categories.pickCategory(heads || (await categories.headsFor('expense')), body.category, existing.category);
  const status = STATUSES.includes(body.status) ? body.status : 'paid';
  const incurredOn = readDate(body.incurredOn, existing.incurredOn || new Date());

  const patch = {
    title: String(body.title).trim(),
    category,
    amount,
    currency: String(body.currency || existing.currency || (await L.recordCurrency())).toUpperCase(),
    incurredOn,
    status,
    // A paid expense always has a payment date: defaulting it to the date it
    // was incurred beats leaving a hole that every later report has to guess at.
    paidOn: status === 'paid' ? readDate(body.paidOn, existing.paidOn || incurredOn) : null,
    paymentMethod: paid.method,
    // Partial-update semantics for the optional fields: a body that does not
    // mention one leaves what is stored; sending '' or null clears it. An
    // older client that never knew about the staff or asset link cannot
    // silently unlink a wage row from its employee.
    vendor: body.vendor !== undefined ? String(body.vendor || '').trim() : existing.vendor || '',
    reference_no:
      body.referenceNo !== undefined || body.reference_no !== undefined
        ? String(body.referenceNo ?? body.reference_no ?? '').trim()
        : existing.reference_no || '',
    notes: body.notes !== undefined ? String(body.notes || '').trim() : existing.notes || '',
    recurring: {
      isRecurring: !!(body.recurring && body.recurring.isRecurring),
      cycle: ['weekly', 'monthly', 'quarterly', 'yearly'].includes(body.recurring && body.recurring.cycle)
        ? body.recurring.cycle
        : 'monthly'
    },
    assetId:
      body.assetId !== undefined
        ? mongoose.Types.ObjectId.isValid(body.assetId) ? body.assetId : null
        : existing.assetId || null,
    staffId:
      body.staffId !== undefined
        ? mongoose.Types.ObjectId.isValid(body.staffId) ? body.staffId : null
        : existing.staffId || null
  };

  // Snapshotted so a wage row still reads correctly if the account is later
  // renamed or removed. Re-read only when the link itself was sent.
  if (!patch.staffId) {
    patch.staffName = '';
  } else if (body.staffId !== undefined || !existing.staffName) {
    const staff = await User.findById(patch.staffId).select('firstName lastName').lean();
    patch.staffName = staff ? [staff.firstName, staff.lastName].filter(Boolean).join(' ').trim() : '';
  } else {
    patch.staffName = existing.staffName;
  }

  return patch;
}

module.exports = {
  // GET /api/accounts/expenses
  list: async (req, res) => {
    try {
      const range = L.readRange(req.query);
      const base = await L.baseCurrency();
      const heads = await categories.headsFor('expense');

      const filter = { incurredOn: { $gte: range.start, $lt: range.end } };
      if (req.query.category && req.query.category !== 'all') filter.category = String(req.query.category);
      if (req.query.status && req.query.status !== 'all') filter.status = String(req.query.status);

      const term = String(req.query.q || '').trim();
      if (term) {
        const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ title: rx }, { vendor: rx }, { reference: rx }, { reference_no: rx }, { notes: rx }];
      }

      const rows = await Expense.find(filter).sort({ incurredOn: -1, createdAt: -1 }).lean();

      const paid = {};
      const pending = {};
      const byCategory = new Map();

      for (const row of rows) {
        const currency = String(row.currency || base).toUpperCase();
        if (row.status === 'paid') L.addTo(paid, currency, row.amount);
        else if (row.status === 'pending') L.addTo(pending, currency, row.amount);

        if (row.status === 'cancelled') continue;
        const entry = byCategory.get(row.category) || {
          category: row.category,
          label: heads.labelOf(row.category),
          count: 0,
          totals: {}
        };
        entry.count += 1;
        L.addTo(entry.totals, currency, row.amount);
        byCategory.set(row.category, entry);
      }

      return res.json({
        success: true,
        base_currency: base,
        // What a new expense is recorded in: the Settings currency.
        record_currency: await L.recordCurrency(),
        currency_notice: await L.currencyNotice(),
        range: { from: range.from, to: range.to, label: range.label, today: range.today },
        // What a new expense can be filed under; the archived heads are listed
        // apart, for the filter -- old rows are still filed under them.
        categories: heads.active.map((head) => ({ key: head.key, label: head.label, built_in: head.built_in })),
        archived_categories: heads.archived.map((head) => ({ key: head.key, label: head.label })),
        methods: METHODS,
        method_options: METHODS.map((value) => ({ value, label: expenseMethodLabel(value) })),
        summary: {
          paid: L.presentTotals(paid, base),
          pending: L.presentTotals(pending, base),
          count: rows.length,
          by_category: [...byCategory.values()]
            .map((entry) => ({ ...entry, totals: L.presentTotals(entry.totals, base) }))
            .sort((a, b) => b.totals.base_amount - a.totals.base_amount)
        },
        expenses: rows.map((row) => shape(row, heads))
      });
    } catch (error) {
      console.error('[accounts] expenses list failed:', error);
      return res.status(500).json({ message: 'Could not load expenses', error: error.message });
    }
  },

  // POST /api/accounts/expenses
  create: async (req, res) => {
    try {
      const heads = await categories.headsFor('expense');
      const patch = await readBody(req.body || {}, {}, heads);
      const expense = await Expense.create({
        ...patch,
        reference: await nextReference(patch.incurredOn),
        createdBy: req.user && req.user.id,
        createdByName: req.user ? [req.user.firstName, req.user.lastName].filter(Boolean).join(' ').trim() : ''
      });

      // Buying equipment is both a cost and a thing the gym now owns. Rather
      // than silently creating an asset behind the operator's back, the reply
      // says so and the UI offers it -- the register stays something a person
      // chose to put an item in.
      const suggestsAsset = patch.category === 'equipment' && !patch.assetId;

      return res.status(201).json({
        success: true,
        message: `${expense.reference} recorded.`,
        suggest_asset: suggestsAsset,
        expense: shape(expense, heads)
      });
    } catch (error) {
      console.error('[accounts] expense create failed:', error);
      return res.status(400).json({ message: error.message || 'Could not record this expense' });
    }
  },

  // PUT /api/accounts/expenses/:id
  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid expense id' });

      const expense = await Expense.findById(id);
      if (!expense) return res.status(404).json({ message: 'Expense not found' });

      const heads = await categories.headsFor('expense');
      const patch = await readBody(req.body || {}, expense.toObject(), heads);
      Object.assign(expense, patch);
      await expense.save();

      return res.json({ success: true, message: `${expense.reference} updated.`, expense: shape(expense, heads) });
    } catch (error) {
      console.error('[accounts] expense update failed:', error);
      return res.status(400).json({ message: error.message || 'Could not update this expense' });
    }
  },

  // DELETE /api/accounts/expenses/:id
  remove: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid expense id' });

      const expense = await Expense.findByIdAndDelete(id);
      if (!expense) return res.status(404).json({ message: 'Expense not found' });

      return res.json({ success: true, message: `${expense.reference} deleted.` });
    } catch (error) {
      console.error('[accounts] expense delete failed:', error);
      return res.status(400).json({ message: 'Could not delete this expense', error: error.message });
    }
  },

  // POST /api/accounts/expenses/payroll
  //
  // Turns the payroll the overview CALCULATES into expenses that actually
  // exist. Until this is run, wages are a commitment the reports show but the
  // ledger does not contain -- which is exactly the gap that makes a net
  // profit figure flattering.
  postPayroll: async (req, res) => {
    try {
      const range = L.readRange(req.body || {});
      const staff = await User.find({ 'employment.isStaff': true, isActive: true })
        .select('firstName lastName employment')
        .lean();

      const monthLabel = L.rangeLabel(range.from, range.to);
      const created = [];
      const payCurrency = await L.recordCurrency();

      for (const person of staff) {
        const payroll = (person.employment && person.employment.payroll) || {};
        const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();

        // Only salaried people are posted automatically: an hourly wage depends
        // on hours that may still be accruing, and guessing them would put a
        // number in the ledger nobody agreed to.
        if ((payroll.basis || 'salaried') !== 'salaried' || !payroll.salary) continue;

        const already = await Expense.findOne({
          staffId: person._id,
          category: 'salaries',
          incurredOn: { $gte: range.start, $lt: range.end }
        });
        if (already) continue;

        // The salary is quoted per pay cycle: a weekly wage over a month is
        // four-and-a-bit of them, not one, and a part-month is its share of
        // that month's days -- the same figure the overview and the payslip
        // work out.
        const amount = L.round(L.salaryForDays(payroll.salary, payroll.cycle, range.from, range.to));
        if (!amount) continue;

        const expense = await Expense.create({
          reference: await nextReference(range.end),
          title: `Salary — ${name} (${monthLabel})`,
          category: 'salaries',
          amount,
          // The gym's currency, like the payslip it stands for.
          currency: payCurrency,
          incurredOn: new Date(range.end.getTime() - 1),
          status: 'pending',
          paidOn: null,
          paymentMethod: 'bank_transfer',
          vendor: name,
          staffId: person._id,
          staffName: name,
          notes: 'Generated from the staff pay rate. Mark as paid once the transfer is made.',
          createdBy: req.user && req.user.id,
          createdByName: req.user ? [req.user.firstName, req.user.lastName].filter(Boolean).join(' ').trim() : ''
        });

        created.push(shape(expense));
      }

      return res.json({
        success: true,
        message: created.length
          ? `${created.length} salary expense${created.length === 1 ? '' : 's'} drafted for ${monthLabel}, awaiting payment.`
          : `Salaries for ${monthLabel} have already been drafted.`,
        expenses: created
      });
    } catch (error) {
      console.error('[accounts] payroll posting failed:', error);
      return res.status(400).json({ message: 'Could not draft payroll', error: error.message });
    }
  }
};
