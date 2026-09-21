import { create } from 'zustand';
import { mockUsers } from '../data/mockData';
import apiClient from '../services/client';
import useNotificationStore from './useNotificationStore';
import useGroupStore from './useGroupStore';
import { normalizeAccountStatus } from '../utils/accountStatus';
import { normalizeMoneyAmount } from '../utils/money';

const dataProvider = (import.meta.env.VITE_DATA_PROVIDER || 'mock').toLowerCase();
const isRealProvider = dataProvider === 'real';
let hasFetchedAdminUsersFromBackendThisSession = false;
let hasFetchedAdminWalletsFromBackendThisSession = false;

const USERS_CACHE_TTL = isRealProvider ? 15 * 1000 : 90 * 1000;
const WALLETS_CACHE_TTL = isRealProvider ? 15 * 1000 : 60 * 1000;
// Keep this within the backend's validated pagination range while providing a
// compact, usable number of users per admin page.
const USERS_PAGE_LIMIT = 20;
const USERS_DEFAULT_SORT_BY = 'walletBalance';
const USERS_DEFAULT_SORT_ORDER = 'desc';
let usersRequest = null;
let walletsRequest = null;
const walletTransactionsRequests = new Map();

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getUserBalanceForSort = (entry) => toFiniteNumber(
  entry?.walletBalance ?? entry?.coins ?? entry?.balance,
  0
);

const sortUsersByBalanceDesc = (users) => (
  [...(Array.isArray(users) ? users : [])]
    .sort((left, right) => getUserBalanceForSort(right) - getUserBalanceForSort(left))
);

const getCurrencyRate = (currencies, currencyCode) => {
  const normalizedCode = String(currencyCode || 'USD').toUpperCase();
  const matchedCurrency = (Array.isArray(currencies) ? currencies : []).find(
    (entry) => String(entry?.code || '').toUpperCase() === normalizedCode
  );

  return toFiniteNumber(matchedCurrency?.rate, 1) || 1;
};

const convertAmountBetweenCurrencies = (amount, fromCurrencyCode, toCurrencyCode, currencies) => {
  const numericAmount = normalizeMoneyAmount(toFiniteNumber(amount, 0));
  const fromCode = String(fromCurrencyCode || 'USD').toUpperCase();
  const toCode = String(toCurrencyCode || 'USD').toUpperCase();

  if (fromCode === toCode) return numericAmount;

  const fromRate = getCurrencyRate(currencies, fromCode);
  const toRate = getCurrencyRate(currencies, toCode);
  if (!fromRate || !toRate) return numericAmount;

  return normalizeMoneyAmount((numericAmount / fromRate) * toRate);
};

const extractGroupIdentity = (groupInput) => {
  if (groupInput && typeof groupInput === 'object') {
    const groupId = String(groupInput.id || groupInput._id || groupInput.groupId || '').trim();
    const groupName = String(groupInput.name || groupInput.groupName || '').trim();
    return { groupId, groupName };
  }

  const raw = String(groupInput || '').trim();
  return { groupId: raw, groupName: '' };
};

const resolveGroupPercentage = (groupInput, fallback = null) => {
  if (groupInput && typeof groupInput === 'object') {
    const directPercentage = Number(groupInput.percentage ?? groupInput.discount);
    if (Number.isFinite(directPercentage)) return directPercentage;
  }

  const { groupId, groupName } = extractGroupIdentity(groupInput);
  const groups = useGroupStore.getState().groups || [];
  const matchedGroup = groups.find((entry) => (
    (groupId && String(entry?.id || '').trim() === groupId)
    || (groupName && String(entry?.name || '').trim().toLowerCase() === groupName.toLowerCase())
  ));

  if (matchedGroup) {
    const matchedPercentage = Number(matchedGroup.percentage ?? matchedGroup.discount);
    if (Number.isFinite(matchedPercentage)) return matchedPercentage;
  }

  return Number.isFinite(Number(fallback)) ? Number(fallback) : null;
};

const upsertUser = (users, nextUser) => {
  if (!nextUser?.id) return Array.isArray(users) ? users : [];
  const existingUsers = Array.isArray(users) ? users : [];
  const hasMatch = existingUsers.some((entry) => String(entry.id) === String(nextUser.id));

  return hasMatch
    ? existingUsers.map((entry) => (String(entry.id) === String(nextUser.id) ? { ...entry, ...nextUser } : entry))
    : [nextUser, ...existingUsers];
};

const upsertWallet = (wallets, nextWallet) => {
  const walletKey = String(nextWallet?.userId || nextWallet?.id || '').trim();
  if (!walletKey) return Array.isArray(wallets) ? wallets : [];

  const existingWallets = Array.isArray(wallets) ? wallets : [];
  const hasMatch = existingWallets.some((entry) => (
    String(entry?.userId || entry?.id || '').trim() === walletKey
  ));

  return hasMatch
    ? existingWallets.map((entry) => (
      String(entry?.userId || entry?.id || '').trim() === walletKey ? { ...entry, ...nextWallet } : entry
    ))
    : [nextWallet, ...existingWallets];
};

const mergeWalletIntoUsers = (users, wallet) => {
  const walletUserId = String(wallet?.userId || wallet?.id || '').trim();
  if (!walletUserId) return Array.isArray(users) ? users : [];

  return (Array.isArray(users) ? users : []).map((entry) => (
    String(entry?.id || '').trim() === walletUserId
      ? {
        ...entry,
        coins: toFiniteNumber(wallet?.walletBalance ?? wallet?.balance ?? entry?.coins, toFiniteNumber(entry?.coins, 0)),
        currency: wallet?.currency || entry?.currency || 'USD',
      }
      : entry
  ));
};

const buildWalletFromUser = (user, seed = {}) => {
  if (!user && !seed?.userId) return null;

  const recentTransactions = Array.isArray(seed?.recentTransactions) ? seed.recentTransactions : [];
  const balance = toFiniteNumber(seed?.walletBalance ?? seed?.balance ?? user?.coins, 0);

  return {
    ...seed,
    id: seed?.id || seed?.walletId || user?.id || seed?.userId,
    walletId: seed?.walletId || seed?.id || user?.id || seed?.userId,
    userId: String(seed?.userId || user?.id || ''),
    user: seed?.user || user || null,
    userName: seed?.userName || user?.name || '',
    userEmail: seed?.userEmail || user?.email || '',
    currency: String(seed?.currency || user?.currency || 'USD').toUpperCase(),
    walletBalance: balance,
    balance,
    recentTransactions,
    transactionsCount: toFiniteNumber(seed?.transactionsCount ?? recentTransactions.length, recentTransactions.length),
    lastTransactionAt: seed?.lastTransactionAt || recentTransactions[0]?.createdAt || null,
  };
};

const removeRecordKey = (record, keyToRemove) => {
  const nextRecord = { ...(record || {}) };
  delete nextRecord[keyToRemove];
  return nextRecord;
};

const ADMIN_MONITOR_ROLES = new Set(['admin', 'supervisor', 'manager', 'moderator', 'super_admin', 'superuser']);

const getActorSnapshot = (actor, fallback = null) => {
  const source = actor || fallback || null;
  return {
    id: String(source?._id || source?.id || source?.userId || '').trim(),
    name: String(source?.name || source?.fullName || source?.email || source?.username || '').trim(),
    role: String(source?.role || '').trim().toLowerCase(),
  };
};

const buildAdminActivity = (entry = {}) => {
  const actor = getActorSnapshot(entry.actor);
  const entityType = String(entry.entityType || 'user').trim().toLowerCase();
  const entityId = String(entry.entityId || '').trim();
  const action = String(entry.action || 'activity').trim();
  const createdAt = entry.createdAt || new Date().toISOString();

  return {
    id: entry.id || `${action}-${entityType}-${entityId || 'global'}-${createdAt}`,
    action,
    title: entry.title || action.replaceAll('_', ' '),
    description: entry.description || '',
    actorId: actor.id || entry.actorId || '',
    actorName: actor.name || entry.actorName || 'System',
    actorRole: actor.role || entry.actorRole || '',
    isMonitoredActor: ADMIN_MONITOR_ROLES.has(actor.role),
    entityType,
    entityId,
    status: String(entry.status || 'updated').trim().toLowerCase(),
    createdAt,
    source: entry.source || 'admin_store',
  };
};

const appendAdminActivity = (set, entry) => {
  const nextEntry = buildAdminActivity(entry);
  set((state) => ({
    adminActivities: [nextEntry, ...(state.adminActivities || [])].slice(0, 200),
  }));
  return nextEntry;
};

const useAdminStore = create((set, get) => ({
      users: isRealProvider ? [] : mockUsers,
      deletedUsers: [],
      usersPagination: null,
      usersCurrentPage: 1,
      usersQuery: { search: '', status: '', role: 'customer' },
      usersLastLoadedAt: 0,
      isLoadingUsers: false,
      wallets: [],
      walletsLastLoadedAt: 0,
      userWalletTransactions: {},
      walletTransactionsLastLoadedAt: {},
      adminActivities: [],

      appendAdminActivity: (entry) => appendAdminActivity(set, entry),

      loadUsers: async ({ force = false, page, search = '', status = '', role = 'customer' } = {}) => {
        const requestedPageCandidate = Number(page ?? get().usersCurrentPage ?? 1);
        const requestedPage = Number.isFinite(requestedPageCandidate) && requestedPageCandidate > 0
          ? Math.floor(requestedPageCandidate)
          : 1;
        const normalizedSearch = String(search || '').trim();
        const normalizedStatus = String(status || '').trim();
        const normalizedRole = String(role || '').trim();
        const { users, usersLastLoadedAt } = get();
        const hasUsers = Array.isArray(users) && users.length > 0;
        const shouldBypassHydratedCache = isRealProvider && !hasFetchedAdminUsersFromBackendThisSession;
        const hasFreshUsers = !shouldBypassHydratedCache
          && hasUsers
          && !page
          && !normalizedSearch
          && !normalizedStatus
          && (Date.now() - Number(usersLastLoadedAt || 0) < USERS_CACHE_TTL);

        if (!force && hasFreshUsers) {
          return users;
        }

        if (usersRequest) {
          return usersRequest;
        }

        set({ isLoadingUsers: true });

        usersRequest = apiClient.users.list({
          page: requestedPage,
          limit: USERS_PAGE_LIMIT,
          sortBy: USERS_DEFAULT_SORT_BY,
          sortOrder: USERS_DEFAULT_SORT_ORDER,
          search: normalizedSearch,
          status: normalizedStatus,
          role: normalizedRole,
        })
          .then(async (result) => {
            // Handle both old (array) and new ({ users, pagination }) response shapes
            const items = Array.isArray(result) ? result : (result?.users || []);
            const nextUsers = sortUsersByBalanceDesc(items.length ? items : (isRealProvider ? [] : mockUsers));
            const pagination = result?.pagination || null;
            const currentPage = Number.isFinite(Number(pagination?.page))
              ? Math.floor(Number(pagination.page))
              : requestedPage;
            const nextDeletedUsers = apiClient.users.listDeleted
              ? await apiClient.users.listDeleted().catch(() => [])
              : [];
            set({
              users: nextUsers,
              deletedUsers: Array.isArray(nextDeletedUsers) ? nextDeletedUsers : [],
              usersPagination: pagination,
              usersCurrentPage: currentPage,
              usersQuery: { search: normalizedSearch, status: normalizedStatus, role: normalizedRole },
              usersLastLoadedAt: Date.now(),
              isLoadingUsers: false,
            });

            if (isRealProvider) {
              hasFetchedAdminUsersFromBackendThisSession = true;
            }
            return nextUsers;
          })
          .catch((_error) => {
            if (!hasUsers) {
              set({ users: sortUsersByBalanceDesc(isRealProvider ? [] : mockUsers) });
            }
            set({ isLoadingUsers: false });
            return get().users;
          })
          .finally(() => {
            usersRequest = null;
          });

        return usersRequest;
      },

      loadUsersPage: async (page) => {
        const requestedPageCandidate = Number(page);
        const requestedPage = Number.isFinite(requestedPageCandidate) && requestedPageCandidate > 0
          ? Math.floor(requestedPageCandidate)
          : 1;
        return get().loadUsers({ force: true, page: requestedPage, ...get().usersQuery });
      },

      getUserById: async (userId, { force = false } = {}) => {
        const normalizedUserId = String(userId || '').trim();
        if (!normalizedUserId) return null;

        const existingUser = (get().users || []).find((entry) => String(entry?.id) === normalizedUserId) || null;
        const existingDeletedUser = (get().deletedUsers || []).find((entry) => String(entry?.id) === normalizedUserId) || null;
        if (existingUser && !force) {
          return existingUser;
        }
        if (existingDeletedUser && !force) {
          return existingDeletedUser;
        }

        const fetchedUser = await apiClient.users.getById(normalizedUserId);
        if (!fetchedUser) {
          return existingUser || existingDeletedUser;
        }

        if (existingUser) {
          if (existingUser.wallet && !fetchedUser.wallet) {
            fetchedUser.wallet = existingUser.wallet;
          } else if (existingUser.wallet && fetchedUser.wallet && !fetchedUser.wallet.transactions) {
            fetchedUser.wallet.transactions = existingUser.wallet.transactions;
          }

          if (existingUser.transactions && !fetchedUser.transactions) {
            fetchedUser.transactions = existingUser.transactions;
          }
        }

        set((state) => ({
          users: upsertUser(state.users, fetchedUser),
          usersLastLoadedAt: Date.now(),
        }));

        return fetchedUser;
      },

      loadWallets: async ({ force = false } = {}) => {
        const { wallets, walletsLastLoadedAt } = get();
        const hasWallets = Array.isArray(wallets) && wallets.length > 0;
        const shouldBypassHydratedCache = isRealProvider && !hasFetchedAdminWalletsFromBackendThisSession;
        const hasFreshWallets = !shouldBypassHydratedCache
          && hasWallets
          && (Date.now() - Number(walletsLastLoadedAt || 0) < WALLETS_CACHE_TTL);

        if (!force && hasFreshWallets) {
          return wallets;
        }

        if (walletsRequest) {
          return walletsRequest;
        }

        walletsRequest = Promise.resolve(apiClient.adminWallets?.list?.() || [])
          .then((items) => {
            const nextWallets = Array.isArray(items) ? items : [];
            set((state) => ({
              wallets: nextWallets,
              walletsLastLoadedAt: Date.now(),
              users: nextWallets.reduce((acc, wallet) => mergeWalletIntoUsers(acc, wallet), Array.isArray(state.users) ? state.users : []),
            }));

            if (isRealProvider) {
              hasFetchedAdminWalletsFromBackendThisSession = true;
            }
            return nextWallets;
          })
          .catch(async () => {
            const fallbackUsers = Array.isArray(get().users) && get().users.length
              ? get().users
              : await get().loadUsers({ force }).catch(() => get().users);
            const fallbackWallets = (Array.isArray(fallbackUsers) ? fallbackUsers : [])
              .map((entry) => buildWalletFromUser(entry))
              .filter(Boolean);

            set((state) => ({
              wallets: fallbackWallets,
              walletsLastLoadedAt: Date.now(),
              users: fallbackWallets.reduce((acc, wallet) => mergeWalletIntoUsers(acc, wallet), Array.isArray(state.users) ? state.users : []),
            }));

            return fallbackWallets;
          })
          .finally(() => {
            walletsRequest = null;
          });

        return walletsRequest;
      },

      getUserWallet: async (userId, { force = false } = {}) => {
        const normalizedUserId = String(userId || '').trim();
        if (!normalizedUserId) return null;

        const existingWallet = (get().wallets || []).find((entry) => (
          String(entry?.userId || entry?.id || '').trim() === normalizedUserId
        )) || null;
        if (existingWallet && !force) {
          return existingWallet;
        }

        try {
        const fetchedWallet = await apiClient.adminWallets.getByUserId(normalizedUserId);
          if (!fetchedWallet) return existingWallet;

          // Seed userWalletTransactions immediately with the populated recentTransactions
          // returned by the wallet endpoint. This prevents the flash: the UI gets correct
          // orderNumber / customerInput data right away without waiting for a second
          // getTransactionsByUserId call to complete.
          const seedTransactions = Array.isArray(fetchedWallet.recentTransactions)
            ? fetchedWallet.recentTransactions
            : [];

          set((state) => {
            let nextUserWalletTransactions = state.userWalletTransactions;

            if (seedTransactions.length > 0) {
              nextUserWalletTransactions = {
                ...state.userWalletTransactions,
                [normalizedUserId]: seedTransactions,
              };
            }

            return {
              wallets: upsertWallet(state.wallets, fetchedWallet),
              walletsLastLoadedAt: Date.now(),
              users: mergeWalletIntoUsers(state.users, fetchedWallet),
              ...(seedTransactions.length > 0 && {
                userWalletTransactions: nextUserWalletTransactions,
                walletTransactionsLastLoadedAt: {
                  ...state.walletTransactionsLastLoadedAt,
                  [normalizedUserId]: Date.now(),
                },
              }),
            };
          });

          return fetchedWallet;
        } catch (_error) {
          const baseUser = await get().getUserById(normalizedUserId).catch(() => (
            (get().users || []).find((entry) => String(entry?.id) === normalizedUserId) || null
          ));
          const fallbackWallet = buildWalletFromUser(baseUser, existingWallet || { userId: normalizedUserId });
          if (!fallbackWallet) {
            return existingWallet;
          }

          set((state) => ({
            wallets: upsertWallet(state.wallets, fallbackWallet),
            walletsLastLoadedAt: Date.now(),
            users: mergeWalletIntoUsers(state.users, fallbackWallet),
          }));

          return fallbackWallet;
        }
      },

      getUserWalletTransactions: async (userId, { force = false } = {}) => {
        const normalizedUserId = String(userId || '').trim();
        if (!normalizedUserId) return [];

        const existingTransactions = Array.isArray(get().userWalletTransactions?.[normalizedUserId])
          ? get().userWalletTransactions[normalizedUserId]
          : [];
        const lastLoadedAt = Number(get().walletTransactionsLastLoadedAt?.[normalizedUserId] || 0);
        const hasFreshTransactions = existingTransactions.length > 0 && (Date.now() - lastLoadedAt < WALLETS_CACHE_TTL);

        if (!force && hasFreshTransactions) {
          return existingTransactions;
        }

        if (walletTransactionsRequests.has(normalizedUserId)) {
          return walletTransactionsRequests.get(normalizedUserId);
        }

        const request = Promise.resolve(apiClient.adminWallets?.getTransactionsByUserId?.(normalizedUserId) || [])
          .then((items) => {
            const nextItems = Array.isArray(items) ? items : [];

            set((state) => {
              const relatedUser = (state.users || []).find((entry) => String(entry?.id) === normalizedUserId) || null;
              const existingWallet = (state.wallets || []).find((entry) => (
                String(entry?.userId || entry?.id || '').trim() === normalizedUserId
              )) || null;

              const nextWallet = buildWalletFromUser(relatedUser, {
                ...(existingWallet || {}),
                userId: normalizedUserId,
                recentTransactions: nextItems.slice(0, 5),
                transactionsCount: nextItems.length,
                lastTransactionAt: nextItems[0]?.createdAt || existingWallet?.lastTransactionAt || null,
              });

              return {
                userWalletTransactions: {
                  ...state.userWalletTransactions,
                  [normalizedUserId]: nextItems,
                },
                walletTransactionsLastLoadedAt: {
                  ...state.walletTransactionsLastLoadedAt,
                  [normalizedUserId]: Date.now(),
                },
                wallets: nextWallet ? upsertWallet(state.wallets, nextWallet) : state.wallets,
                users: nextWallet ? mergeWalletIntoUsers(state.users, nextWallet) : state.users,
              };
            });

            return nextItems;
          })
          .catch(() => existingTransactions)
          .finally(() => {
            walletTransactionsRequests.delete(normalizedUserId);
          });

        walletTransactionsRequests.set(normalizedUserId, request);
        return request;
      },

      addUser: async (user) => {
        const created = await apiClient.auth.register(user);
        const nextUser = created?.user || user;
        set((state) => ({
          users: [...state.users, nextUser],
          usersLastLoadedAt: Date.now(),
        }));
      },

      resendUserVerification: async (userIdOrEmail) => {
        const normalizedToken = String(userIdOrEmail || '').trim();
        if (!normalizedToken) {
          throw new Error('No email available for verification resend.');
        }

        const email = normalizedToken.includes('@')
          ? normalizedToken
          : ((get().users || []).find((entry) => String(entry?.id) === normalizedToken)?.email || '');

        if (!email) {
          throw new Error('No email available for verification resend.');
        }

        return apiClient.auth.resendVerification(email);
      },

      updateUserStatus: async (userId, status, actor = null) => {
        const updatedUser = await apiClient.users.updateStatus(userId, status, actor);
        const target = (get().users || []).find((entry) => entry.id === userId);
        const nextStatus = normalizeAccountStatus(updatedUser?.status || status);

        set((state) => ({
          users: state.users.map((entry) => (
            entry.id === userId ? { ...entry, ...(updatedUser || {}), status: nextStatus } : entry
          )),
          usersLastLoadedAt: Date.now(),
        }));

        get().appendAdminActivity({
          action: 'user_status_updated',
          title: 'تحديث حالة مستخدم',
          description: `تم تحديث حالة ${target?.name || userId} إلى ${nextStatus}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: nextStatus,
          source: 'user_management',
        });

        if (nextStatus === 'approved') {
          useNotificationStore.getState().addNotification({
            title: 'تمت الموافقة على الحساب',
            message: `تمت الموافقة على حساب ${target?.name || userId}`,
            type: 'success',
            targetType: 'user',
            targetId: userId,
            userId,
            targetUrl: '/admin/users',
          });
        } else if (nextStatus === 'rejected') {
          useNotificationStore.getState().addNotification({
            title: 'تم رفض الحساب',
            message: `تم رفض حساب ${target?.name || userId}`,
            type: 'warning',
            targetType: 'user',
            targetId: userId,
            userId,
            targetUrl: '/admin/users',
          });
        }

        return updatedUser || { ...(target || {}), status: nextStatus };
      },

      updateUserCoins: async (userId, amountToAdd, actor = null, onSelfUpdate = null) => {
        // Call API — no optimistic state mutation. Let the backend be the source of truth.
        const apiResult = await apiClient.users.addCoins(userId, amountToAdd, actor);

        // Force re-fetch from backend to reflect the true DB state.
        // CRITICAL: loadWallets must also be invalidated because its
        // mergeWalletIntoUsers() overwrites users[].coins — a stale
        // background loadWallets would silently revert the balance.
        await Promise.allSettled([
          get().loadUsers({ force: true }),
          get().loadWallets({ force: true }),
          get().getUserWallet(userId, { force: true }),
          get().getUserWalletTransactions(userId, { force: true }),
        ]);

        get().appendAdminActivity({
          action: 'user_coins_added',
          title: 'إضافة رصيد لمستخدم',
          description: `تمت إضافة ${normalizeMoneyAmount(amountToAdd)} إلى رصيد المستخدم ${userId}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: 'created',
          source: 'wallet_adjustment',
        });

        if (typeof onSelfUpdate === 'function') onSelfUpdate();
        return apiResult;
      },

      setUserBalance: async (userId, nextBalance, actor = null, onSelfUpdate = null) => {
        const normalizedBalance = normalizeMoneyAmount(toFiniteNumber(nextBalance, 0));

        // Call API — no optimistic state mutation
        const updatedUser = apiClient.users.setBalance
          ? await apiClient.users.setBalance(userId, normalizedBalance, actor)
          : await apiClient.users.updateProfile(userId, { walletBalance: normalizedBalance }, actor);

        // Force re-fetch from backend to reflect the true DB state
        await Promise.allSettled([
          get().loadUsers({ force: true }),
          get().loadWallets({ force: true }),
          get().getUserWallet(userId, { force: true }),
          get().getUserWalletTransactions(userId, { force: true }),
        ]);

        get().appendAdminActivity({
          action: 'user_balance_set',
          title: 'تعديل رصيد مستخدم',
          description: `تم ضبط رصيد ${userId} إلى ${normalizedBalance}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: 'updated',
          source: 'wallet_adjustment',
        });

        if (typeof onSelfUpdate === 'function') onSelfUpdate();
        return updatedUser;
      },

      updateUserGroup: async (userId, newGroup, actor = null) => {
        const updatedUser = await apiClient.users.updateGroup(userId, newGroup, actor);
        const { groupId, groupName } = extractGroupIdentity(newGroup);
        const nextGroupPercentage = resolveGroupPercentage(
          updatedUser?.groupPercentage !== undefined && updatedUser?.groupPercentage !== null
            ? { ...updatedUser, percentage: updatedUser.groupPercentage }
            : newGroup,
          updatedUser?.groupPercentage
        );
        set((state) => ({
          users: state.users.map((entry) => (
            entry.id === userId
              ? {
                ...entry,
                ...(updatedUser || {}),
                group: updatedUser?.group || updatedUser?.groupName || groupName || entry.group,
                groupName: updatedUser?.groupName || updatedUser?.group || groupName || entry.groupName || entry.group,
                groupId: updatedUser?.groupId || groupId || entry.groupId || '',
                groupPercentage: nextGroupPercentage ?? entry.groupPercentage ?? null,
              }
              : entry
          )),
          usersLastLoadedAt: Date.now(),
        }));

        // No persistent storage to clear: runtime-only state now.

        try {
          const useAuthStore = (await import('./useAuthStore')).default;
          const currentUser = useAuthStore.getState().user;
          if (currentUser && (currentUser.id === userId || currentUser._id === userId)) {
            useAuthStore.getState().updateUserSession({
              group: updatedUser?.group || updatedUser?.groupName || groupName || currentUser.group,
              groupName: updatedUser?.groupName || updatedUser?.group || groupName || currentUser.groupName || currentUser.group,
              groupId: updatedUser?.groupId || groupId || currentUser.groupId || '',
              groupPercentage: nextGroupPercentage ?? currentUser.groupPercentage ?? null,
            });
            await useAuthStore.getState().refreshProfile({ force: true });
          }
        } catch (_) { /* ignore if auth store unavailable */ }

        get().appendAdminActivity({
          action: 'user_group_updated',
          title: 'تغيير مجموعة مستخدم',
          description: `تم تغيير مجموعة ${updatedUser?.name || userId} إلى ${updatedUser?.groupName || updatedUser?.group || groupName || 'غير محدد'}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: 'updated',
          source: 'user_management',
        });

        return updatedUser;
      },

      updateUserRole: async (userId, newRole, actor = null) => {
        const updatedUser = await apiClient.users.updateRole(userId, newRole, actor);
        set((state) => ({
          users: state.users.map((entry) => (
            entry.id === userId ? { ...entry, ...(updatedUser || {}), role: updatedUser?.role || String(newRole || '').toLowerCase() } : entry
          )),
          usersLastLoadedAt: Date.now(),
        }));

        get().appendAdminActivity({
          action: 'user_role_updated',
          title: 'تغيير دور مستخدم',
          description: `تم تغيير دور ${updatedUser?.name || userId} إلى ${updatedUser?.role || newRole}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: 'updated',
          source: 'user_management',
        });
        return updatedUser;
      },

      updateUserPermissions: async (userId, permissions = [], actor = null) => {
        const updated = await apiClient.users.updatePermissions(userId, permissions, actor);
        const nextPermissions = Array.isArray(updated?.permissions) ? updated.permissions : permissions;
        set((state) => ({
          users: state.users.map((entry) => (
            entry.id === userId ? { ...entry, ...(updated || {}), permissions: nextPermissions } : entry
          )),
          usersLastLoadedAt: Date.now(),
        }));

        get().appendAdminActivity({
          action: 'user_permissions_updated',
          title: 'تحديث صلاحيات مستخدم',
          description: `تم تحديث صلاحيات ${updated?.name || userId}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: 'updated',
          source: 'user_management',
        });
        return updated;
      },

      updateUserCurrency: async (userId, currencyCode, actor = null) => {
        const normalizedUserId = String(userId || '').trim();
        const nextCurrencyCode = String(currencyCode || '').toUpperCase();
        if (!normalizedUserId || !nextCurrencyCode) return null;

        const existingUser = (get().users || []).find((entry) => String(entry?.id || '').trim() === normalizedUserId) || null;
        const previousCurrencyCode = String(existingUser?.currency || 'USD').toUpperCase();
        const previousCreditLimit = normalizeMoneyAmount(Math.max(0, toFiniteNumber(existingUser?.creditLimit, 0)));

        // 1. Call the API — backend converts balance + returns updated user
        const updatedCurrencyUser = await apiClient.users.updateCurrency(normalizedUserId, nextCurrencyCode, actor);

        if (previousCreditLimit > 0 && previousCurrencyCode !== nextCurrencyCode) {
          try {
            const useSystemStore = (await import('./useSystemStore')).default;
            let currencies = useSystemStore.getState().currencies || [];

            if (!Array.isArray(currencies) || currencies.length === 0) {
              currencies = await useSystemStore.getState().loadCurrencies().catch(() => []);
            }

            const convertedCreditLimit = convertAmountBetweenCurrencies(
              previousCreditLimit,
              previousCurrencyCode,
              nextCurrencyCode,
              currencies
            );

            await get().updateUserCreditLimit(normalizedUserId, convertedCreditLimit, actor);
          } catch (_error) {
            // If credit-limit conversion fails, keep the currency update instead of blocking the flow.
          }
        }

        // 2. Force re-fetch the entire users list from DB (bulletproof — no manual patching)
        await get().loadUsers({ force: true });
        await get().getUserWallet(normalizedUserId, { force: true }).catch(() => null);

        // 3. If the updated user is the currently logged-in user,
        //    force re-fetch their profile so navbar/balance updates instantly.
        try {
          const useAuthStore = (await import('./useAuthStore')).default;
          const currentUser = useAuthStore.getState().user;
          if (currentUser && (currentUser.id === normalizedUserId || currentUser._id === normalizedUserId)) {
            await useAuthStore.getState().refreshProfile({ force: true });
          }
        } catch (_) { /* ignore if auth store unavailable */ }

        get().appendAdminActivity({
          action: 'user_currency_updated',
          title: 'تغيير عملة مستخدم',
          description: `تم تغيير عملة ${updatedCurrencyUser?.name || normalizedUserId} إلى ${nextCurrencyCode}`,
          actor,
          entityType: 'user',
          entityId: normalizedUserId,
          status: 'updated',
          source: 'user_management',
        });

        return updatedCurrencyUser;
      },

      updateUserCreditLimit: async (userId, creditLimit, actor = null) => {
        const normalizedCreditLimit = normalizeMoneyAmount(
          Math.max(0, toFiniteNumber(creditLimit, 0))
        );

        const updatedUser = apiClient.users.updateCreditLimit
          ? await apiClient.users.updateCreditLimit(userId, normalizedCreditLimit, actor)
          : await apiClient.users.updateProfile(userId, { creditLimit: normalizedCreditLimit }, actor);

        set((state) => ({
          users: state.users.map((entry) => (
            entry.id === userId
              ? {
                ...entry,
                ...(updatedUser || {}),
                creditLimit: normalizeMoneyAmount(
                  Math.max(
                    0,
                    toFiniteNumber(updatedUser?.creditLimit, toFiniteNumber(entry?.creditLimit, normalizedCreditLimit))
                  )
                ),
              }
              : entry
          )),
          usersLastLoadedAt: Date.now(),
        }));

        try {
          const useAuthStore = (await import('./useAuthStore')).default;
          const currentUser = useAuthStore.getState().user;
          if (currentUser && (currentUser.id === userId || currentUser._id === userId)) {
            await useAuthStore.getState().refreshProfile({ force: true });
          }
        } catch (_) { /* ignore if auth store unavailable */ }

        get().appendAdminActivity({
          action: 'user_credit_limit_updated',
          title: 'تعديل الحد الائتماني',
          description: `تم تعديل الحد الائتماني للمستخدم ${userId} إلى ${normalizedCreditLimit}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: 'updated',
          source: 'user_management',
        });

        return updatedUser;
      },

      deleteUser: async (userId, actor = null) => {
        const normalizedUserId = String(userId || '').trim();
        const targetUser = (get().users || []).find((entry) => String(entry?.id || '').trim() === normalizedUserId) || null;
        await apiClient.users.delete(userId, actor);
        set((state) => ({
          users: state.users.filter((entry) => entry.id !== userId),
          deletedUsers: targetUser
            ? [
              {
                ...targetUser,
                deletedAt: new Date().toISOString(),
                isDeleted: true,
                previousStatus: targetUser?.status || 'approved',
                status: 'deleted',
              },
              ...(state.deletedUsers || []).filter((entry) => String(entry?.id || '').trim() !== normalizedUserId),
            ]
            : (state.deletedUsers || []),
          usersLastLoadedAt: Date.now(),
          wallets: (state.wallets || []).filter((entry) => String(entry?.userId || entry?.id || '').trim() !== normalizedUserId),
          userWalletTransactions: removeRecordKey(state.userWalletTransactions, normalizedUserId),
          walletTransactionsLastLoadedAt: removeRecordKey(state.walletTransactionsLastLoadedAt, normalizedUserId),
        }));

        get().appendAdminActivity({
          action: 'user_deleted',
          title: 'حذف مستخدم',
          description: `تم حذف ${targetUser?.name || userId}`,
          actor,
          entityType: 'user',
          entityId: normalizedUserId,
          status: 'deleted',
          source: 'user_management',
        });
      },

      restoreUser: async (userId, actor = null) => {
        if (!apiClient.users.restore) {
          throw new Error('Restore endpoint is not available.');
        }

        const restoredUser = await apiClient.users.restore(userId, actor);
        const normalizedUserId = String(userId || '').trim();

        set((state) => ({
          users: upsertUser(state.users, restoredUser),
          deletedUsers: (state.deletedUsers || []).filter((entry) => String(entry?.id || '').trim() !== normalizedUserId),
          usersLastLoadedAt: Date.now(),
        }));

        get().appendAdminActivity({
          action: 'user_restored',
          title: 'استرجاع مستخدم',
          description: `تم استرجاع ${restoredUser?.name || userId}`,
          actor,
          entityType: 'user',
          entityId: normalizedUserId,
          status: 'restored',
          source: 'user_management',
        });

        return restoredUser;
      },

      updateUserAvatar: async (userId, avatar, actor = null, onSelfUpdate = null) => {
        const updatedUser = await apiClient.users.updateAvatar(userId, avatar, actor);
        const nextAvatar = updatedUser && Object.prototype.hasOwnProperty.call(updatedUser, 'avatar')
          ? updatedUser.avatar
          : avatar;
        set((state) => ({
          users: state.users.map((entry) => (
            entry.id === userId ? { ...entry, avatar: nextAvatar } : entry
          )),
          usersLastLoadedAt: Date.now(),
        }));

        get().appendAdminActivity({
          action: 'user_avatar_updated',
          title: 'تحديث صورة المستخدم',
          description: `تم تحديث صورة ${userId}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: 'updated',
          source: 'user_management',
        });

        if (typeof onSelfUpdate === 'function') onSelfUpdate();
        return updatedUser;
      },

      updateUserProfile: async (userId, profileUpdates, actor = null, onSelfUpdate = null) => {
        const updatedUser = await apiClient.users.updateProfile(userId, profileUpdates, actor);
        set((state) => ({
          users: state.users.map((entry) => (
            entry.id === userId ? { ...entry, ...updatedUser } : entry
          )),
          usersLastLoadedAt: Date.now(),
        }));

        get().appendAdminActivity({
          action: 'user_profile_updated',
          title: 'تحديث بيانات المستخدم',
          description: `تم تحديث بيانات ${updatedUser?.name || userId}`,
          actor,
          entityType: 'user',
          entityId: userId,
          status: 'updated',
          source: 'user_management',
        });

        if (typeof onSelfUpdate === 'function') onSelfUpdate(updatedUser);
      },

      resetUserPassword: async (userId, actor = null, password = '') => apiClient.users.resetPassword(userId, actor, password),
}));

export default useAdminStore;
