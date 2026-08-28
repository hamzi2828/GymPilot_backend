// src/services/affiliateService.js
//
// Commissions are stored as an embedded array on the User document
// (user.affiliate.commissions) rather than a separate collection — this
// works around the MongoDB Atlas 500-collection limit and keeps each
// affiliate's ledger right next to their config.

const User = require('../models/user');

const affiliateService = {
    /**
     * Resolve an affiliate code into the affiliate user. Returns null if invalid
     * or suspended. Self-referral allowed (commissions can be reviewed by admin).
     */
    async resolveAffiliate(code, buyerUserId = null) {
        console.log('🟣 [AFFILIATE] resolveAffiliate called with code:', code, 'buyerUserId:', buyerUserId);
        if (!code || typeof code !== 'string') {
            console.log('🟣 [AFFILIATE] No code provided, skipping');
            return null;
        }
        const normalized = code.trim().toLowerCase();
        if (!normalized) {
            console.log('🟣 [AFFILIATE] Empty after normalize, skipping');
            return null;
        }

        const user = await User.findOne({
            'affiliate.code': normalized,
            'affiliate.status': 'approved',
            'affiliate.isAffiliate': true,
            isActive: true
        }).select('_id affiliate.commissionPercent affiliate.code affiliate.status');

        if (!user) {
            const anyUser = await User.findOne({ 'affiliate.code': normalized })
                .select('_id affiliate.status affiliate.isAffiliate isActive');
            if (!anyUser) {
                console.log(`🟣 [AFFILIATE] No user found with code "${normalized}"`);
            } else {
                console.log(`🟣 [AFFILIATE] Code "${normalized}" matched user ${anyUser._id} but failed gate:`, {
                    status: anyUser.affiliate?.status,
                    isAffiliate: anyUser.affiliate?.isAffiliate,
                    isActive: anyUser.isActive
                });
            }
            return null;
        }
        if (buyerUserId && user._id.toString() === buyerUserId.toString()) {
            console.log(`🟣 [AFFILIATE] Self-referral allowed (buyer is the affiliate); commission will be created with status 'pending' for admin review`);
        }

        const result = {
            userId: user._id,
            code: user.affiliate.code,
            commissionPercent: user.affiliate.commissionPercent || 0
        };
        console.log('🟣 [AFFILIATE] Resolved successfully:', result);
        return result;
    },

    /**
     * Record a commission ledger entry on the affiliate user's embedded array.
     * Idempotent — skips if an entry already exists for this order.
     */
    async recordCommissionForOrder(order) {
        console.log('🟢 [AFFILIATE] recordCommissionForOrder called for order:', order?.orderNumber, 'affiliateCode:', order?.affiliateCode);
        if (!order || !order.affiliateUser || !order.affiliateCode) {
            console.log('🟢 [AFFILIATE] Order has no affiliate, skipping commission');
            return null;
        }

        const affiliateUser = await User.findById(order.affiliateUser);
        if (!affiliateUser || !affiliateUser.affiliate) {
            console.log('🟢 [AFFILIATE] Affiliate user not found:', order.affiliateUser);
            return null;
        }

        const orderIdStr = order._id.toString();
        const existing = (affiliateUser.affiliate.commissions || []).find(
            c => c.order && c.order.toString() === orderIdStr
        );
        if (existing) {
            console.log('🟢 [AFFILIATE] Commission already exists for order, skipping (idempotent)');
            return existing;
        }

        const percent = typeof affiliateUser.affiliate.commissionPercent === 'number'
            ? affiliateUser.affiliate.commissionPercent
            : 0;
        const subtotal = Number(order.subtotal) || 0;
        const amount = Math.round(((subtotal * percent) / 100) * 100) / 100;
        console.log(`🟢 [AFFILIATE] Computing commission: subtotal=${subtotal} × ${percent}% = ${amount}`);
        if (amount <= 0) {
            console.log('🟢 [AFFILIATE] Commission amount <= 0, skipping');
            return null;
        }

        affiliateUser.affiliate.commissions = affiliateUser.affiliate.commissions || [];
        affiliateUser.affiliate.commissions.push({
            order: order._id,
            orderNumber: order.orderNumber,
            code: order.affiliateCode,
            orderSubtotal: subtotal,
            commissionPercent: percent,
            commissionAmount: amount,
            status: 'pending'
        });
        affiliateUser.affiliate.totalEarnings = (affiliateUser.affiliate.totalEarnings || 0) + amount;
        affiliateUser.affiliate.totalOrders = (affiliateUser.affiliate.totalOrders || 0) + 1;
        await affiliateUser.save();

        const created = affiliateUser.affiliate.commissions[affiliateUser.affiliate.commissions.length - 1];
        console.log('🟢 [AFFILIATE] Commission entry pushed to user.affiliate.commissions, _id=', created._id.toString());
        console.log(`🟢 [AFFILIATE] Bumped totalEarnings by ${amount} for user ${order.affiliateUser}`);

        return created;
    },

    /**
     * Reverse a commission when an order is refunded/cancelled.
     */
    async reverseCommissionForOrder(orderId) {
        console.log('🟠 [AFFILIATE] reverseCommissionForOrder called for order:', orderId);
        const orderIdStr = orderId.toString();
        const user = await User.findOne({ 'affiliate.commissions.order': orderId });
        if (!user) {
            console.log('🟠 [AFFILIATE] No commission found to reverse');
            return null;
        }
        const entry = user.affiliate.commissions.find(c => c.order && c.order.toString() === orderIdStr);
        if (!entry || entry.status === 'reversed') {
            console.log('🟠 [AFFILIATE] Nothing to reverse');
            return null;
        }
        const wasPaid = entry.status === 'paid';
        entry.status = 'reversed';
        entry.reversedAt = new Date();
        user.affiliate.totalEarnings = Math.max(0, (user.affiliate.totalEarnings || 0) - entry.commissionAmount);
        if (wasPaid) {
            user.affiliate.totalPaid = Math.max(0, (user.affiliate.totalPaid || 0) - entry.commissionAmount);
        }
        await user.save();
        console.log(`🟠 [AFFILIATE] Reversed commission ${entry._id} (was ${wasPaid ? 'paid' : 'pending'}, amount ${entry.commissionAmount})`);
        return entry;
    }
};

module.exports = affiliateService;
