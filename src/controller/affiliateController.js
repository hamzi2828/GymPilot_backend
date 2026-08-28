// src/controller/affiliateController.js
//
// Commissions live as an embedded array on user.affiliate.commissions
// (see models/user.js). No separate collection — works around the
// MongoDB Atlas 500-collection limit.

const User = require('../models/user');
const Order = require('../models/order');
const Product = require('../models/product');

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

async function generateUniqueCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
        let suffix = '';
        for (let i = 0; i < 6; i++) {
            suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
        }
        const code = `s${suffix}`;
        const exists = await User.exists({ 'affiliate.code': code });
        if (!exists) return code;
    }
    throw new Error('Could not generate unique affiliate code');
}

function ensureUser(req, res) {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return null;
    }
    return userId;
}

function ensureAdmin(req, res) {
    if (!req.user || req.user.role !== 'admin') {
        res.status(403).json({ success: false, message: 'Admin only' });
        return false;
    }
    return true;
}

const affiliateController = {
    // ==================== USER (self) ====================

    async getMyAffiliate(req, res) {
        try {
            const userId = ensureUser(req, res);
            if (!userId) return;
            const user = await User.findById(userId).select('affiliate firstName lastName email');
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });
            const affiliate = user.affiliate ? user.affiliate.toObject() : {};
            // Don't ship the full commissions array on the state endpoint — separate route for that
            delete affiliate.commissions;
            res.status(200).json({ success: true, affiliate });
        } catch (error) {
            console.error('getMyAffiliate error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async applyForAffiliate(req, res) {
        try {
            const userId = ensureUser(req, res);
            if (!userId) return;

            const user = await User.findById(userId);
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });

            const status = user.affiliate?.status || 'none';
            if (status === 'pending') {
                return res.status(400).json({ success: false, message: 'Application already pending' });
            }
            if (status === 'approved') {
                return res.status(400).json({ success: false, message: 'You are already an affiliate' });
            }

            const existingAffiliate = user.affiliate ? user.affiliate.toObject() : {};
            user.affiliate = {
                ...existingAffiliate,
                status: 'pending',
                appliedAt: new Date(),
                rejectedAt: null,
                rejectionReason: '',
                payoutDetails: req.body.payoutDetails || existingAffiliate.payoutDetails || {}
            };
            await user.save();

            const affiliate = user.affiliate.toObject ? user.affiliate.toObject() : user.affiliate;
            delete affiliate.commissions;
            res.status(200).json({ success: true, message: 'Application submitted', affiliate });
        } catch (error) {
            console.error('applyForAffiliate error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async updatePayoutDetails(req, res) {
        try {
            const userId = ensureUser(req, res);
            if (!userId) return;
            const { method, accountTitle, accountNumber, bankName } = req.body || {};
            const user = await User.findById(userId);
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });

            user.affiliate = user.affiliate || {};
            user.affiliate.payoutDetails = {
                method: method || '',
                accountTitle: accountTitle || '',
                accountNumber: accountNumber || '',
                bankName: bankName || ''
            };
            await user.save();
            const affiliate = user.affiliate.toObject ? user.affiliate.toObject() : user.affiliate;
            delete affiliate.commissions;
            res.status(200).json({ success: true, affiliate });
        } catch (error) {
            console.error('updatePayoutDetails error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async getMyCommissions(req, res) {
        try {
            const userId = ensureUser(req, res);
            if (!userId) return;

            const { status, page = 1, limit = 50 } = req.query;
            const user = await User.findById(userId).select('affiliate.commissions');
            const all = (user?.affiliate?.commissions || [])
                .map(c => (c.toObject ? c.toObject() : c))
                .filter(c => !status || c.status === status)
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const paged = all.slice(skip, skip + parseInt(limit)).map(c => ({
                ...c,
                _id: c._id.toString(),
                order: c.order ? c.order.toString() : null
            }));

            res.status(200).json({
                success: true,
                commissions: paged,
                pagination: { page: parseInt(page), limit: parseInt(limit), total: all.length }
            });
        } catch (error) {
            console.error('getMyCommissions error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async getMyAffiliateProducts(req, res) {
        try {
            const userId = ensureUser(req, res);
            if (!userId) return;
            const user = await User.findById(userId).select('affiliate');
            if (!user || user.affiliate?.status !== 'approved') {
                return res.status(403).json({ success: false, message: 'Not an approved affiliate' });
            }
            const { search = '', page = 1, limit = 24 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);

            const filter = { status: 'published' };
            if (user.affiliate.productsScope === 'selected'
                && Array.isArray(user.affiliate.allowedProducts)
                && user.affiliate.allowedProducts.length > 0) {
                filter._id = { $in: user.affiliate.allowedProducts };
            }
            if (search) filter.name = { $regex: search, $options: 'i' };

            const [products, total] = await Promise.all([
                Product.find(filter)
                    .select('name slug thumbnailUrl bannerUrls price discountedPrice')
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(parseInt(limit))
                    .lean(),
                Product.countDocuments(filter)
            ]);

            res.status(200).json({
                success: true,
                products,
                pagination: { page: parseInt(page), limit: parseInt(limit), total }
            });
        } catch (error) {
            console.error('getMyAffiliateProducts error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    // ==================== ADMIN ====================

    async adminListAffiliates(req, res) {
        try {
            if (!ensureAdmin(req, res)) return;
            const { status, search, page = 1, limit = 25 } = req.query;
            const filter = {};
            if (status) {
                filter['affiliate.status'] = status;
            } else {
                filter['affiliate.status'] = { $exists: true, $nin: [null, 'none'] };
            }
            if (search) {
                filter.$or = [
                    { firstName: { $regex: search, $options: 'i' } },
                    { lastName: { $regex: search, $options: 'i' } },
                    { email: { $regex: search, $options: 'i' } },
                    { 'affiliate.code': { $regex: search, $options: 'i' } }
                ];
            }
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const [users, total] = await Promise.all([
                User.find(filter)
                    .select('firstName lastName email phone affiliate createdAt')
                    .sort({ 'affiliate.appliedAt': -1, createdAt: -1 })
                    .skip(skip)
                    .limit(parseInt(limit))
                    .lean(),
                User.countDocuments(filter)
            ]);
            // Strip commissions array from list response (heavy)
            for (const u of users) {
                if (u.affiliate) delete u.affiliate.commissions;
            }
            res.status(200).json({
                success: true,
                affiliates: users,
                pagination: { page: parseInt(page), limit: parseInt(limit), total }
            });
        } catch (error) {
            console.error('adminListAffiliates error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async adminGetAffiliate(req, res) {
        try {
            if (!ensureAdmin(req, res)) return;
            const user = await User.findById(req.params.id)
                .select('firstName lastName email phone affiliate createdAt')
                .lean();
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });
            const orders = await Order.find({ affiliateUser: user._id })
                .select('orderNumber subtotal total orderStatus paymentStatus createdAt')
                .sort({ createdAt: -1 })
                .limit(50)
                .lean();
            res.status(200).json({ success: true, affiliate: user, orders });
        } catch (error) {
            console.error('adminGetAffiliate error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async adminApprove(req, res) {
        try {
            if (!ensureAdmin(req, res)) return;
            const { commissionPercent, allowedProducts, productsScope } = req.body || {};
            const user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });

            const aff = user.affiliate || {};
            if (!aff.code) aff.code = await generateUniqueCode();
            aff.isAffiliate = true;
            aff.status = 'approved';
            aff.approvedAt = new Date();
            aff.rejectedAt = null;
            aff.rejectionReason = '';
            if (typeof commissionPercent === 'number') aff.commissionPercent = commissionPercent;
            if (productsScope === 'all' || productsScope === 'selected') aff.productsScope = productsScope;
            if (Array.isArray(allowedProducts)) aff.allowedProducts = allowedProducts;
            user.affiliate = aff;
            await user.save();
            const out = user.affiliate.toObject ? user.affiliate.toObject() : user.affiliate;
            delete out.commissions;
            res.status(200).json({ success: true, affiliate: out });
        } catch (error) {
            console.error('adminApprove error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async adminReject(req, res) {
        try {
            if (!ensureAdmin(req, res)) return;
            const { reason } = req.body || {};
            const user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });
            const aff = user.affiliate || {};
            aff.status = 'rejected';
            aff.isAffiliate = false;
            aff.rejectedAt = new Date();
            aff.rejectionReason = reason || '';
            user.affiliate = aff;
            await user.save();
            const out = user.affiliate.toObject ? user.affiliate.toObject() : user.affiliate;
            delete out.commissions;
            res.status(200).json({ success: true, affiliate: out });
        } catch (error) {
            console.error('adminReject error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async adminUpdateAffiliate(req, res) {
        try {
            if (!ensureAdmin(req, res)) return;
            const { commissionPercent, allowedProducts, productsScope, status } = req.body || {};
            const user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ success: false, message: 'User not found' });
            const aff = user.affiliate || {};
            if (typeof commissionPercent === 'number') aff.commissionPercent = commissionPercent;
            if (productsScope === 'all' || productsScope === 'selected') aff.productsScope = productsScope;
            if (Array.isArray(allowedProducts)) aff.allowedProducts = allowedProducts;
            if (status && ['approved', 'suspended'].includes(status)) {
                aff.status = status;
                aff.isAffiliate = status === 'approved';
            }
            user.affiliate = aff;
            await user.save();
            const out = user.affiliate.toObject ? user.affiliate.toObject() : user.affiliate;
            delete out.commissions;
            res.status(200).json({ success: true, affiliate: out });
        } catch (error) {
            console.error('adminUpdateAffiliate error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * Aggregates commissions across all users into one flat list. Each row
     * carries the parent affiliate user info so the admin UI can render it.
     */
    async adminListCommissions(req, res) {
        try {
            if (!ensureAdmin(req, res)) return;
            const { status, code, affiliateUser, page = 1, limit = 50 } = req.query;

            const userFilter = {};
            if (affiliateUser) userFilter._id = affiliateUser;
            if (code) userFilter['affiliate.code'] = code;

            const users = await User.find(userFilter)
                .select('firstName lastName email affiliate.code affiliate.commissions')
                .lean();

            let all = [];
            const summary = { pending: { total: 0, count: 0 }, approved: { total: 0, count: 0 }, paid: { total: 0, count: 0 }, reversed: { total: 0, count: 0 } };

            for (const u of users) {
                const list = u.affiliate?.commissions || [];
                for (const c of list) {
                    if (status && c.status !== status) continue;
                    all.push({
                        _id: c._id.toString(),
                        affiliateUser: { _id: u._id.toString(), firstName: u.firstName, lastName: u.lastName, email: u.email },
                        code: c.code,
                        order: c.order ? c.order.toString() : null,
                        orderNumber: c.orderNumber,
                        orderSubtotal: c.orderSubtotal,
                        commissionPercent: c.commissionPercent,
                        commissionAmount: c.commissionAmount,
                        status: c.status,
                        paidAt: c.paidAt,
                        reversedAt: c.reversedAt,
                        createdAt: c.createdAt
                    });
                    if (summary[c.status]) {
                        summary[c.status].total += c.commissionAmount;
                        summary[c.status].count += 1;
                    }
                }
            }
            all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const total = all.length;
            const skip = (parseInt(page) - 1) * parseInt(limit);
            const paged = all.slice(skip, skip + parseInt(limit));

            const summaryArr = Object.entries(summary).map(([k, v]) => ({ _id: k, total: v.total, count: v.count }));

            res.status(200).json({
                success: true,
                commissions: paged,
                pagination: { page: parseInt(page), limit: parseInt(limit), total },
                summary: summaryArr
            });
        } catch (error) {
            console.error('adminListCommissions error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async adminMarkPaid(req, res) {
        try {
            if (!ensureAdmin(req, res)) return;
            const { commissionIds } = req.body || {};
            if (!Array.isArray(commissionIds) || commissionIds.length === 0) {
                return res.status(400).json({ success: false, message: 'commissionIds required' });
            }

            // Find all users whose commissions array contains any of the requested IDs
            const users = await User.find({ 'affiliate.commissions._id': { $in: commissionIds } });
            const now = new Date();
            let updated = 0;
            for (const user of users) {
                let userIncrement = 0;
                for (const c of user.affiliate.commissions) {
                    if (commissionIds.includes(c._id.toString()) && (c.status === 'pending' || c.status === 'approved')) {
                        c.status = 'paid';
                        c.paidAt = now;
                        userIncrement += c.commissionAmount;
                        updated++;
                    }
                }
                if (userIncrement > 0) {
                    user.affiliate.totalPaid = (user.affiliate.totalPaid || 0) + userIncrement;
                    await user.save();
                }
            }
            res.status(200).json({ success: true, updated });
        } catch (error) {
            console.error('adminMarkPaid error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }
};

module.exports = affiliateController;
module.exports.generateUniqueCode = generateUniqueCode;
