import { create } from 'zustand';
import { mockTopups } from '../data/mockData';
import apiClient from '../services/client';
import useNotificationStore from './useNotificationStore';
import useAuthStore from './useAuthStore';
import useAdminStore from './useAdminStore';
import { formatTime } from '../utils/intl';

const dataProvider = (import.meta.env.VITE_DATA_PROVIDER || 'mock').toLowerCase();
const isRealProvider = dataProvider === 'real';
let hasFetchedTopupsFromBackendThisSession = false;

const TOPUPS_CACHE_TTL = 15 * 1000; // short TTL to reduce refetch storms while keeping data fresh
let topupsRequest = null;
let filteredTopupsRequestSeq = 0;

const useTopupStore = create((set, get) => ({
      // =====================================================================================
      // FINANCIAL SNAPSHOT SYSTEM - CRITICAL BUSINESS LOGIC
      // =====================================================================================
      // Each topup transaction gets a FINANCIAL SNAPSHOT at approval time that includes:
      // - originalCurrency: The currency the user paid in
      // - originalAmount: The exact amount paid
      // - exchangeRateAtExecution: Exchange rate at the moment of approval
      // - convertedAmountAtExecution: Amount converted at execution time
      // - finalAmountAtExecution: Final coins credited to wallet
      // - pricingSnapshot: Complete pricing context (fees, discounts, etc.)
      //
      // This prevents dynamic recalculation when exchange rates change later.
      // =====================================================================================
      topups: isRealProvider ? [] : mockTopups,
      topupsLastLoadedAt: 0,

      topupsPagination: null,
      topupsSummary: null,

      loadTopups: async ({ force = true } = {}) => {
        const { topups, topupsLastLoadedAt } = get();
        const hasTopups = Array.isArray(topups) && topups.length > 0;
        const shouldBypassHydratedCache = isRealProvider && !hasFetchedTopupsFromBackendThisSession;
        const loadedAt = Number(topupsLastLoadedAt || 0);
        const cacheAge = loadedAt ? (Date.now() - loadedAt) : Number.POSITIVE_INFINITY;
        const cacheIsFresh = cacheAge >= 0 && cacheAge < TOPUPS_CACHE_TTL;
        const hasFreshTopups = !shouldBypassHydratedCache && hasTopups && cacheIsFresh;

        // Serve cached data when still fresh (even if force=true).
        if (hasFreshTopups) return topups;
        if (!force && hasTopups) return topups;

        if (topupsRequest) return topupsRequest;

        topupsRequest = apiClient.topups.list()
          .then((result) => {
            // Handle both old (array) and new ({ items, pagination }) response shapes
            const items = Array.isArray(result) ? result : (result?.items || []);
            const nextTopups = items.length ? items : (isRealProvider ? [] : mockTopups);
            set({
              topups: nextTopups,
              topupsLastLoadedAt: Date.now(),
              topupsPagination: result?.pagination || null,
            });

            if (isRealProvider) {
              hasFetchedTopupsFromBackendThisSession = true;
            }
            return nextTopups;
          })
          .catch((_error) => {
            if (!hasTopups) {
              set({ topups: isRealProvider ? [] : mockTopups });
            }
            return get().topups;
          })
          .finally(() => {
            topupsRequest = null;
          });

        return topupsRequest;
      },

      /**
       * Admin-only: load deposits with server-side filters (no cache/dedup).
       * Each call hits the server directly, perfect for filter/page changes.
       */
      loadTopupsFiltered: async (params = {}) => {
        const requestSeq = filteredTopupsRequestSeq + 1;
        filteredTopupsRequestSeq = requestSeq;

        const normalizedSearch = String(params.search || '').trim().replace(/^#/, '');
        const shouldTryDirectLookup = Boolean(normalizedSearch)
          && !normalizedSearch.includes('@')
          && !/\s/.test(normalizedSearch)
          && Number(params.page || 1) === 1;

        if (shouldTryDirectLookup) {
          try {
            const directMatch = await apiClient.topups.getById(normalizedSearch);
            if (directMatch && requestSeq === filteredTopupsRequestSeq) {
              set({
                topups: [directMatch],
                topupsLastLoadedAt: Date.now(),
                topupsPagination: { page: 1, limit: params.limit || 20, total: 1, pages: 1 },
                topupsSummary: null,
              });
              return [directMatch];
            }
          } catch (_error) {
            // Not an exact request id; continue with the normal server-side list search.
          }
        }

        const result = await apiClient.topups.list(params);
        const items = Array.isArray(result) ? result : (result?.items || []);
        if (requestSeq === filteredTopupsRequestSeq) {
          set({
            topups: items,
            topupsLastLoadedAt: Date.now(),
            topupsPagination: result?.pagination || null,
            topupsSummary: result?.summary || null,
          });
        }
        return items;
      },

      getTopupById: async (topupId, userId = null) => {
        const normalizedTopupId = String(topupId || '').trim();
        if (!normalizedTopupId) return null;

        const fetchedTopup = await apiClient.topups.getById(normalizedTopupId, userId);
        if (!fetchedTopup) return null;

        set((state) => {
          const existingTopups = Array.isArray(state.topups) ? state.topups : [];
          const existingIndex = existingTopups.findIndex((entry) => String(entry.id) === String(fetchedTopup.id));
          const nextTopups = existingIndex >= 0
            ? existingTopups.map((entry) => (String(entry.id) === String(fetchedTopup.id) ? { ...entry, ...fetchedTopup } : entry))
            : [fetchedTopup, ...existingTopups];

          return {
            topups: nextTopups,
            topupsLastLoadedAt: Date.now(),
          };
        });

        return fetchedTopup;
      },

      requestTopup: async (amountOrPayload, method, userId, userName) => {
        const isPayloadObject = typeof amountOrPayload === 'object' && amountOrPayload !== null;
        const requestedAmount = isPayloadObject
          ? Number(amountOrPayload.requestedAmount || amountOrPayload.amount || 0)
          : Number(amountOrPayload || 0);

        const topupType = isPayloadObject && amountOrPayload.type ? amountOrPayload.type : 'regular';
        const gameDetails = isPayloadObject && amountOrPayload.gameDetails ? amountOrPayload.gameDetails : null;

        const newTopup = {
          id: Date.now(),
          userId: isPayloadObject ? amountOrPayload.userId : userId,
          userName: isPayloadObject ? amountOrPayload.userName : userName,
          amount: requestedAmount,
          requestedAmount,
          requestedCoins: requestedAmount,
          status: topupType === 'game_topup' ? 'approved' : 'pending', // Auto-approve game top-ups
          createdAt: new Date().toISOString(),
          time: formatTime(new Date(), 'ar-EG'),
          method: isPayloadObject ? amountOrPayload.paymentChannel : method,
          paymentChannel: isPayloadObject ? amountOrPayload.paymentChannel : method,
          currencyCode: isPayloadObject ? amountOrPayload.currencyCode : 'USD',
          proofImage: isPayloadObject ? amountOrPayload.proofImage : '',
          senderDetails: isPayloadObject ? (amountOrPayload.senderDetails || null) : null,
          senderWalletNumber: isPayloadObject ? amountOrPayload.senderWalletNumber : '',
          senderWalletAddress: isPayloadObject ? amountOrPayload.senderWalletAddress : '',
          transferredFromNumber: isPayloadObject ? amountOrPayload.transferredFromNumber : '',
          transactionId: isPayloadObject ? (amountOrPayload.transactionId || amountOrPayload.transactionNumber || amountOrPayload.paymentReference || '') : '',
          transactionNumber: isPayloadObject ? (amountOrPayload.transactionNumber || amountOrPayload.transactionId || amountOrPayload.paymentReference || '') : '',
          paymentReference: isPayloadObject ? (amountOrPayload.paymentReference || amountOrPayload.transactionId || amountOrPayload.transactionNumber || '') : '',
          type: topupType,
          gameDetails: gameDetails,
          // ── Fields required by realApi.topups.create (POST /me/deposits) ──
          paymentMethodId: isPayloadObject ? (amountOrPayload.paymentMethodId || '') : '',
          currency: isPayloadObject ? (amountOrPayload.currencyCode || amountOrPayload.currency || 'USD') : 'USD',
          paymentMethodType: isPayloadObject ? (amountOrPayload.paymentMethodType || '') : '',
          receipt: isPayloadObject ? (amountOrPayload.receipt || amountOrPayload.proofImage || null) : null,
          notes: isPayloadObject ? (amountOrPayload.notes || '') : '',
        };

        // Auto-create financial snapshot for game top-ups
        if (topupType === 'game_topup') {
          const currencies = await apiClient.system.currencies().catch(() => []);
          const userCurrency = currencies.find(c => c.code === (newTopup.currencyCode || 'USD')) || { code: 'USD', rate: 1 };
          const exchangeRate = Number(userCurrency.rate || 1);
          const convertedAmount = requestedAmount * exchangeRate;

          newTopup.financialSnapshot = {
            originalCurrency: newTopup.currencyCode || 'USD',
            originalAmount: requestedAmount,
            exchangeRateAtExecution: exchangeRate,
            convertedAmountAtExecution: convertedAmount,
            finalAmountAtExecution: convertedAmount,
            pricingSnapshot: {
              baseRate: exchangeRate,
              fees: 0,
              discount: 0,
              finalRate: exchangeRate
            },
            feesSnapshot: {
              processingFee: 0,
              transferFee: 0,
              totalFees: 0
            }
          };
          newTopup.creditedCoins = convertedAmount;
          newTopup.adminNote = 'Auto-approved - Game top-up';
        }

        const created = await apiClient.topups.create(newTopup);
        // Preserve submitted metadata when an API response omits optional
        // transaction fields, so the admin can review the operation number.
        const finalTopup = { ...newTopup, ...(created || {}) };
        set(state => ({
          topups: [finalTopup, ...state.topups],
          topupsLastLoadedAt: Date.now(),
        }));

        // Auto-credit coins for game top-ups
        if (topupType === 'game_topup' && finalTopup.financialSnapshot) {
          useAdminStore.getState().updateUserCoins(
            finalTopup.userId,
            finalTopup.financialSnapshot.finalAmountAtExecution,
            null,
            () => {
              useNotificationStore.getState().addNotification({
                title: 'تم شحن الرصيد تلقائياً',
                message: `تم إضافة ${finalTopup.financialSnapshot.finalAmountAtExecution} عملة إلى رصيدك`,
                type: 'success',
                targetType: 'wallet',
                targetId: finalTopup?.id,
                topupId: finalTopup?.id,
                targetUrl: '/wallet/topups',
              });
            }
          );
        }

        useNotificationStore.getState().addNotification({
          title: topupType === 'game_topup' ? 'طلب شحن لعبة جديد' : 'طلب شحن جديد',
          message: `طلب شحن ${topupType === 'game_topup' ? 'لعبة ' : ''}جديد من ${finalTopup?.userName || userName || 'عميل'}`,
          type: 'info',
          targetType: 'topup',
          targetId: finalTopup?.id,
          topupId: finalTopup?.id,
          targetUrl: '/wallet/topups',
        });
      },

      updateTopupStatus: async (id, status, review = {}) => {
        const target = (get().topups || []).find((t) => t.id === id);
        if (!target) return;
        const currentActor = useAuthStore.getState().user || null;
        const actorRole = String(currentActor?.role || '').trim().toLowerCase();
        const isAdminActor = ['admin', 'supervisor', 'manager', 'moderator'].includes(actorRole);

        // Get current exchange rates for financial snapshot
        const currencies = await apiClient.system.currencies().catch(() => []);
        const userCurrency = currencies.find(c => c.code === (target.currencyCode || 'USD')) || { code: 'USD', rate: 1, symbol: '$' };

        let updatedTopup = { ...target, status };

        // Create financial snapshot when approving the topup
        if (status === 'approved' && !target.financialSnapshot) {
          const actualPaidAmount = Number(review.actualPaidAmount || target.requestedAmount || 0);
          const exchangeRate = Number(userCurrency.rate || 1);
          const convertedAmount = actualPaidAmount * exchangeRate;

          updatedTopup.financialSnapshot = {
            originalCurrency: target.currencyCode || 'USD',
            originalAmount: actualPaidAmount,
            exchangeRateAtExecution: exchangeRate,
            convertedAmountAtExecution: convertedAmount,
            finalAmountAtExecution: convertedAmount, // Amount credited to wallet
            pricingSnapshot: {
              baseRate: exchangeRate,
              fees: 0,
              discount: 0,
              finalRate: exchangeRate
            },
            feesSnapshot: {
              processingFee: 0,
              transferFee: 0,
              totalFees: 0
            }
          };

          // Update legacy fields for backward compatibility
          updatedTopup.actualPaidAmount = actualPaidAmount;
          updatedTopup.creditedCoins = convertedAmount;
          updatedTopup.adminNote = review.adminNote || '';
          if (isAdminActor) {
            updatedTopup.reviewedBy = currentActor?.id || currentActor?._id || updatedTopup.reviewedBy || null;
            updatedTopup.reviewerName = currentActor?.name || updatedTopup.reviewerName || '';
            updatedTopup.approvedBy = updatedTopup.reviewedBy || updatedTopup.approvedBy || null;
            updatedTopup.reviewedAt = new Date().toISOString();
          }
        }

        const updated = await apiClient.topups.updateStatus(id, status, updatedTopup);
        const finalUpdate = updated || updatedTopup;

        set(state => ({
          topups: state.topups.map(t => t.id === id ? finalUpdate : t),
          topupsLastLoadedAt: Date.now(),
        }));

        if (isAdminActor) {
          useAdminStore.getState().appendAdminActivity?.({
            action: `topup_${status}`,
            title: status === 'approved' || status === 'completed' ? 'قبول طلب شحن' : 'رفض طلب شحن',
            description: `${currentActor?.name || actorRole || 'مشرف'} ${status === 'approved' || status === 'completed' ? 'قبل' : 'رفض'} طلب الشحن ${target?.id || id}`,
            actor: currentActor,
            entityType: 'topup',
            entityId: target?.id || id,
            status,
            source: 'topup_review',
          });
        }

        // Refresh wallet/user snapshots so dashboard metrics reflect the approval immediately.
        if ((status === 'approved' || status === 'completed') && useAdminStore.getState().loadUsers) {
          await useAdminStore.getState().loadUsers({ force: true });
        }

        const requestedAmount = Number(finalUpdate?.requestedAmount ?? finalUpdate?.requestedCoins ?? target?.requestedAmount ?? target?.requestedCoins ?? 0);
        const actualAmount = Number(finalUpdate?.actualPaidAmount ?? requestedAmount);

        if (status === 'approved' || status === 'completed') {
          useNotificationStore.getState().addNotification({
            title: 'قبول طلب شحن',
            message: actualAmount !== requestedAmount
              ? `تم قبول طلب ${target?.id || id} بالمبلغ الفعلي ${actualAmount} فقط`
              : `تم قبول طلب الشحن ${target?.id || id}`,
            type: 'success',
            targetType: 'wallet',
            targetId: target?.id || id,
            topupId: target?.id || id,
            targetUrl: '/wallet/topups',
          });
        } else if (status === 'rejected' || status === 'denied') {
          useNotificationStore.getState().addNotification({
            title: 'رفض طلب شحن',
            message: `تم رفض طلب الشحن ${target?.id || id}`,
            type: 'warning',
            targetType: 'wallet',
            targetId: target?.id || id,
            topupId: target?.id || id,
            targetUrl: '/wallet/topups',
          });
        }
      },

      updateTopupRequest: async (id, payload = {}) => {
        const currentActor = useAuthStore.getState().user || null;
        const actorRole = String(currentActor?.role || '').trim().toLowerCase();
        const isAdminActor = ['admin', 'supervisor', 'manager', 'moderator'].includes(actorRole);
        const updated = await apiClient.topups.updateRequest(id, payload);
        set((state) => ({
          topups: state.topups.map((item) => (item.id === id ? { ...item, ...updated } : item)),
          topupsLastLoadedAt: Date.now(),
        }));

        if (isAdminActor) {
          useAdminStore.getState().appendAdminActivity?.({
            action: 'topup_updated',
            title: 'تعديل طلب شحن',
            description: `${currentActor?.name || actorRole || 'مشرف'} عدل طلب الشحن ${id}`,
            actor: currentActor,
            entityType: 'topup',
            entityId: id,
            status: 'updated',
            source: 'topup_review',
          });
        }

        const requestedAmount = Number(updated?.requestedAmount ?? updated?.requestedCoins ?? updated?.amount ?? 0);
        useNotificationStore.getState().addNotification({
          title: 'تعديل طلب شحن',
          message: `تم تعديل مبلغ الطلب ${id} إلى ${requestedAmount}`,
          type: 'info',
          targetType: 'topup',
          targetId: id,
          topupId: id,
          targetUrl: '/wallet/topups',
        });
      }
}));

export default useTopupStore;
