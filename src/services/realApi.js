/**
 * realApi.js — Real HTTP API provider
 *
 * Replaces mockApi.js when VITE_DATA_PROVIDER=real.
 * All methods conform to the same interface contract as mockApi so that
 * Zustand stores work without modification.
 *
 * BE responses are wrapped in: { success, message, data }
 * Adapter helpers unwrap responses and normalise field names
 * (_id → id, uppercase roles/statuses → lowercase, etc.)
 */

import axios from 'axios';
import { devLogger } from '../utils/devLogger';
import { getWalletBalanceSummary } from '../utils/money';
import { isSiteWalletPaymentMethod, normalizePaymentGroups } from '../utils/paymentSettings';
import {
  resolveWalletTransactionExecutionCurrency,
  resolveWalletTransactionOriginalCurrency,
} from '../utils/transactionCurrency';

// ─── Axios instance ──────────────────────────────────────────────────────────

import { resolveImageUrl } from '../utils/imageUrl';
import { resolveUserAvatar } from '../utils/avatar';
import { getAccountAccessRoute, normalizeAccountStatus } from '../utils/accountStatus';
import { readReferralBridge, readReferralCodeFromSearch } from '../utils/referralCode';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

const http = axios.create({
  baseURL: API_BASE,
  timeout: 180_000,
  // NOTE: Do NOT set a default Content-Type here.
  // Axios auto-sets 'application/json' for object bodies and
  // 'multipart/form-data; boundary=…' for FormData bodies.
  // Hardcoding it breaks Multer file uploads.
});

// ─── Token helpers ───────────────────────────────────────────────────────────

const AUTH_STORAGE_KEY = 'auth-storage';
const SESSION_LOGOUT_REASON_KEY = 'auth:logout-reason';
const SESSION_EXPIRED_REASON = 'expired';
const LOGIN_REDIRECT_PATH = '/login';
const REFRESH_ENDPOINT = '/auth/refresh';

const AUTH_FORCE_LOGOUT_EVENT = 'auth:force-logout';

const safeParseJson = (raw, fallback = null) => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const getAuthPersistedRoot = () => {
  if (typeof window === 'undefined' || !window.localStorage) return {};

  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};
const getStoredAuthState = () => getAuthPersistedRoot()?.state || {};
const getStoredRole = () => String(getStoredAuthState()?.user?.role || '').trim().toUpperCase();

const prepareFreshPaymentSettingsRequest = () => {
  // No-op: payment settings are always fetched from the API.
};

const normalizeSettingArray = (value) => {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    const parsed = safeParseJson(value, null);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.value)) return parsed.value;
    if (Array.isArray(parsed?.items)) return parsed.items;
    if (Array.isArray(parsed?.paymentGroups)) return parsed.paymentGroups;
    if (Array.isArray(parsed?.countryAccounts)) return parsed.countryAccounts;
  }

  if (Array.isArray(value?.value)) return value.value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.paymentGroups)) return value.paymentGroups;
  if (Array.isArray(value?.countryAccounts)) return value.countryAccounts;

  return [];
};

const normalizePaymentSettingsResponse = (settings) => {
  const source = settings || {};
  const normalizeAccount = (item = {}) => ({
    countryCode: String(item?.countryCode || '').trim().toUpperCase(),
    countryName: String(item?.countryName || '').trim(),
    currencyCode: String(item?.currencyCode || '').trim().toUpperCase(),
    cashWalletNumber: String(item?.cashWalletNumber || '').trim(),
    bankAccountNumber: String(item?.bankAccountNumber || '').trim(),
    bankAccountName: String(item?.bankAccountName || '').trim(),
  });

  return {
    countryAccounts: normalizeSettingArray(source?.countryAccounts)
      .map((item) => normalizeAccount(item))
      .filter((item) => item.countryCode),
    instructions: String(source?.instructions || '').trim(),
    whatsappNumber: String(source?.whatsappNumber || '').trim(),
    paymentGroups: normalizePaymentGroups(normalizeSettingArray(source?.paymentGroups), { fallbackToDefault: false }),
  };
};

const serializePaymentGroupsForApi = (groups) => normalizePaymentGroups(groups, { fallbackToDefault: false }).map((group) => ({
  id: group.id,
  name: group.name,
  description: group.description,
  currency: group.currency,
  image: group.image,
  imageName: group.imageName,
  isActive: group.isActive !== false,
  methods: group.methods.map((method) => ({
    id: method.id,
    name: method.name,
    description: method.description,
    type: method.type,
    accountNumber: method.accountNumber,
    accountName: method.accountName,
    bankName: method.bankName,
    feePercent: method.feePercent,
    instructions: method.instructions,
    image: method.image,
    imageName: method.imageName,
    isActive: method.isActive !== false,
    fields: Array.isArray(method.fields) ? method.fields : [],
  })),
}));

const normaliseSenderDetails = (source = {}) => {
  const rawDetails = source?.senderDetails && typeof source.senderDetails === 'object'
    ? source.senderDetails
    : safeParseJson(source?.senderDetails, null);
  const details = rawDetails && typeof rawDetails === 'object' ? rawDetails : {};
  const rawPaymentDetails = source?.paymentDetails && typeof source.paymentDetails === 'object'
    ? source.paymentDetails
    : safeParseJson(source?.paymentDetails, null);
  const paymentDetails = rawPaymentDetails && typeof rawPaymentDetails === 'object' ? rawPaymentDetails : {};
  const value = String(
    details.value
    || source.senderWalletAddress
    || source.senderWalletNumber
    || source.transferredFromNumber
    || ''
  ).trim();
  const transactionNumber = String(
    details.transactionNumber
    || details.transactionId
    || details.paymentReference
    || details.operationNumber
    || details.operationId
    || paymentDetails.transactionNumber
    || paymentDetails.transactionId
    || paymentDetails.paymentReference
    || paymentDetails.operationNumber
    || paymentDetails.referenceNumber
    || source.transactionNumber
    || source.transactionId
    || source.paymentReference
    || source.operationNumber
    || source.operationId
    || source.referenceNumber
    || source.transferNumber
    || source.transferReference
    || source.transaction?.number
    || source.transaction?.id
    || source.payment?.transactionNumber
    || source.metadata?.transactionNumber
    || source.metadata?.transactionId
    || String(source.notes || '').match(/\[transactionNumber:([^\]\r\n]+)\]/i)?.[1]
    || ''
  ).trim();

  // Some payment methods do not require the sender's wallet number. Keep the
  // details object when a transaction number exists so admins can still see it.
  if (!value && !transactionNumber) return null;

  const methodType = String(details.methodType || details.type || source.paymentMethodType || '').trim().toLowerCase();
  const field = String(
    details.field
    || (source.senderWalletAddress ? 'senderWalletAddress' : 'senderWalletNumber')
  ).trim();
  const label = String(
    details.label
    || (field === 'senderWalletAddress' || methodType === 'usdt'
      ? 'عنوان المحفظة المحول منها'
      : 'رقم المحفظة المحول منها')
  ).trim();
  return { methodType, field, label, value, transactionNumber };
};

const writeAuthState = (nextState) => {
  const root = getAuthPersistedRoot() || {};
  const nextRoot = {
    ...root,
    state: { ...(root.state || {}), ...(nextState || {}) },
  };

  if (typeof window === 'undefined' || !window.localStorage) return;

  try {
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextRoot));
  } catch {
    // Best effort.
  }
};

const getStoredToken = () => String(getStoredAuthState()?.token || '').trim() || null;
const getStoredRefreshToken = () => {
  return getStoredAuthState()?.refreshToken || null;
};

const setStoredAuthTokens = (token, refreshToken) => {
  writeAuthState({
    token: token || null,
    isAuthenticated: Boolean(token),
    refreshToken: refreshToken || null,
  });
};

const clearStoredSession = () => {
  if (typeof window === 'undefined' || !window.localStorage) return;

  try {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
};

const setSessionLogoutReason = (reason = SESSION_EXPIRED_REASON) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSION_LOGOUT_REASON_KEY, reason);
  } catch {
    // Ignore storage failures.
  }
};

const dispatchForceLogoutEvent = (reason) => {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(AUTH_FORCE_LOGOUT_EVENT, { detail: { reason } }));
  } catch {
    // Best-effort; the app can still rely on persisted storage changes.
  }
};

let isForceLogoutInProgress = false;
const forceLogoutAndRedirect = (reason = SESSION_EXPIRED_REASON) => {
  if (isForceLogoutInProgress) return;
  isForceLogoutInProgress = true;
  clearStoredSession();
  setSessionLogoutReason(reason);
  dispatchForceLogoutEvent(reason);
};

const isPublicAuthRequest = (url = '') => {
  const value = String(url || '');
  return (
    value.includes('/auth/login')
    || value.includes('/auth/register')
    || value.includes('/auth/google')
    || value.includes('/auth/verify-2fa')
    || value.includes(REFRESH_ENDPOINT)
  );
};

const isTokenAuthError = (error) => {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.response?.data?.code || '').toLowerCase();
  const message = String(
    error?.response?.data?.message
    || error?.response?.data?.error
    || error?.message
    || ''
  ).toLowerCase();

  const looksLikeTokenFailure = (
    /jwt|token/.test(message) && /expired|invalid|missing|malformed|revoked/.test(message)
  ) || [
    'token_expired',
    'jwt_expired',
    'invalid_token',
    'auth_token_invalid',
  ].includes(code);

  return status === 401 || looksLikeTokenFailure;
};

const wrapHttpError = (error) => {
  const msg =
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    'Network error';
  const wrapped = new Error(msg);
  wrapped.status = error?.response?.status || error?.status;
  wrapped.code = error?.response?.data?.code || error?.code;
  return wrapped;
};

const requestTokenRefresh = async (refreshToken) => {
  const res = await axios.post(
    `${API_BASE}${REFRESH_ENDPOINT}`,
    { refreshToken },
    {
      timeout: 180_000,
      headers: { 'Content-Type': 'application/json' },
    }
  );
  const payload = res?.data?.data ?? res?.data ?? {};
  const nextAccessToken = payload?.token || payload?.accessToken;
  const nextRefreshToken = payload?.refreshToken ?? payload?.refresh_token ?? refreshToken;

  if (!nextAccessToken) {
    throw new Error('Unable to refresh session');
  }

  setStoredAuthTokens(nextAccessToken, nextRefreshToken);
  return nextAccessToken;
};

let refreshUnsupported = false;

let refreshInFlight = null;
let refreshQueue = [];
const flushRefreshQueue = (error, token) => {
  const queue = [...refreshQueue];
  refreshQueue = [];
  queue.forEach(({ resolve, reject, request }) => {
    if (error) {
      reject(error);
      return;
    }
    request.headers = {
      ...(request.headers || {}),
      Authorization: `Bearer ${token}`,
    };
    resolve(http(request));
  });
};

// ─── Request interceptor: attach JWT ─────────────────────────────────────────

http.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers = {
      ...(config.headers || {}),
      Authorization: `Bearer ${token}`,
    };
  }
  return config;
});

// ─── Response interceptor: unwrap envelope ───────────────────────────────────

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error?.config || {};
    const unauthorized = isTokenAuthError(error);
    const skipAuthHandling = isPublicAuthRequest(originalRequest?.url);

    if (unauthorized && !skipAuthHandling) {
      const refreshToken = getStoredRefreshToken();
      const canRetryWithRefresh = !refreshUnsupported && Boolean(refreshToken) && !originalRequest._retryWithRefresh;

      if (canRetryWithRefresh) {
        originalRequest._retryWithRefresh = true;

        if (refreshInFlight) {
          return new Promise((resolve, reject) => {
            refreshQueue.push({ resolve, reject, request: originalRequest });
          });
        }

        refreshInFlight = requestTokenRefresh(refreshToken)
          .then((nextAccessToken) => {
            flushRefreshQueue(null, nextAccessToken);
            return nextAccessToken;
          })
          .catch((refreshError) => {
            flushRefreshQueue(refreshError, null);
            throw refreshError;
          })
          .finally(() => {
            refreshInFlight = null;
          });

        try {
          const nextAccessToken = await refreshInFlight;
          originalRequest.headers = {
            ...(originalRequest.headers || {}),
            Authorization: `Bearer ${nextAccessToken}`,
          };
          return http(originalRequest);
        } catch (refreshError) {
          const refreshStatus = Number(refreshError?.response?.status || refreshError?.status || 0);
          if (refreshStatus === 404) {
            refreshUnsupported = true;
          }
          forceLogoutAndRedirect(SESSION_EXPIRED_REASON);
          return Promise.reject(wrapHttpError(refreshError));
        }
      }

      forceLogoutAndRedirect(SESSION_EXPIRED_REASON);
    }

    return Promise.reject(wrapHttpError(error));
  }
);

// ─── Adapter / Mapper utilities ──────────────────────────────────────────────

/** Unwrap the standard BE envelope: { success, data } → data */
const unwrap = (res) => res.data?.data ?? res.data;

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveUserCreditLimit = (user) => {
  const candidates = [
    user?.creditLimit,
    user?.walletCreditLimit,
    user?.debtLimit,
    user?.maxDebt,
    user?.financialSnapshot?.creditLimit,
    user?.financialSnapshot?.debtLimit,
  ];

  for (const entry of candidates) {
    const parsed = Number(entry);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }

  return 0;
};

const getProviderCatalogPriceValue = (product = {}) => (
  product?.rawPayload?.product_price
  ?? product?.rawPrice
  ?? product?.price
  ?? product?.basePrice
  ?? product?.priceCoins
  ?? ''
);

const getProviderCatalogMinQtyValue = (product = {}) => (
  product?.minQty
  ?? product?.minimumOrderQty
  ?? product?.min
  ?? product?.rawPayload?.minQty
  ?? product?.rawPayload?.minimumOrderQty
  ?? product?.rawPayload?.min_qty
  ?? product?.rawPayload?.min
  ?? null
);

const getProviderCatalogMaxQtyValue = (product = {}) => (
  product?.maxQty
  ?? product?.maximumOrderQty
  ?? product?.max
  ?? product?.rawPayload?.maxQty
  ?? product?.rawPayload?.maximumOrderQty
  ?? product?.rawPayload?.max_qty
  ?? product?.rawPayload?.max
  ?? null
);

/** Normalise a single user object from BE to FE shape */
const normaliseUser = (u) => {
  if (!u) return null;
  const id = u._id || u.id;
  const rawRole = String(u.role || u.userRole || u.accountType || 'customer').trim().toLowerCase();
  const role = ['user', 'client', 'customer_user', 'customer-user'].includes(rawRole)
    ? 'customer'
    : rawRole;

  // Flatten populated groupId: BE may return { _id, name, percentage } object
  const rawGroup = u.group || u.groupId;
  const groupName = typeof rawGroup === 'object' && rawGroup !== null
    ? (rawGroup.name || '')
    : (rawGroup || '');
  const groupId = typeof rawGroup === 'object' && rawGroup !== null
    ? (rawGroup._id || rawGroup.id || '')
    : (rawGroup || '');
  const groupPercentageRaw = typeof rawGroup === 'object' && rawGroup !== null
    ? (rawGroup.percentage ?? rawGroup.discount)
    : null;
  const groupPercentage = groupPercentageRaw === undefined || groupPercentageRaw === null
    ? null
    : Number(groupPercentageRaw);
  const rawBillingMode = u.billingMode || (typeof rawGroup === 'object' ? rawGroup.billingMode : '') || 'standard';
  const billingMode = String(rawBillingMode).toLowerCase() === 'quantity' ? 'quantity_only' : String(rawBillingMode).toLowerCase();
  const quantityLimit = Math.max(0, Number(u.quantityLimit ?? u.quota?.limit ?? 0) || 0);
  const quantityUsed = Math.max(0, Number(u.quantityUsed ?? u.quota?.used ?? 0) || 0);

  // Flatten populated currency ref if it were ever an object
  const rawCurrency = u.currency;
  const currency = typeof rawCurrency === 'object' && rawCurrency !== null
    ? (rawCurrency.code || rawCurrency._id || '')
    : (rawCurrency || '');
  const walletSummary = getWalletBalanceSummary({
    ...u,
    creditLimit: resolveUserCreditLimit(u),
    currency,
  });

  return {
    ...u,
    id,
    _id: undefined,
    // FE expects lowercase role
    role,
    // FE expects lowercase status strings
    status: (u.status || 'pending').toLowerCase(),
    signupMethod: (u.signupMethod || u.authProvider || u.provider || u.signupProvider || 'email').toLowerCase(),
    authProvider: (u.authProvider || u.signupMethod || u.provider || 'email').toLowerCase(),
    // FE uses "coins" as a legacy alias for walletBalance, not spendable balance.
    coins: walletSummary.walletBalance,
    walletBalance: walletSummary.walletBalance,
    balance: walletSummary.walletBalance,
    // Financial controls
    creditLimit: walletSummary.creditLimit,
    creditUsed: walletSummary.creditUsed,
    availableCredit: walletSummary.availableCredit,
    availableBalance: walletSummary.availableBalance,
    // Flattened group fields — never pass an object to React
    group: groupName,
    groupId: String(groupId),
    groupName,
    groupPercentage: Number.isFinite(groupPercentage) ? groupPercentage : null,
    billingMode,
    quantityLimit,
    quantityUsed,
    quota: { limit: quantityLimit, used: quantityUsed, remaining: Math.max(0, quantityLimit - quantityUsed) },
    // Flattened currency
    currency: walletSummary.currency || currency,
    // joinDate aliasing
    joinDate: u.joinDate || u.createdAt,
    createdAt: u.createdAt || u.joinDate || u.registeredAt || null,
    approvedAt: u.approvedAt || u.activatedAt || null,
    rejectedAt: u.rejectedAt || u.deniedAt || null,
    // ensure avatar — resolve relative paths and fallback
    avatar: resolveUserAvatar(u, u.name || u.email || 'Dra90n User'),
    permissions: Array.isArray(u.permissions) ? u.permissions.map((item) => String(item || '').trim()).filter(Boolean) : [],
    twoFactorEnabled: Boolean(u.twoFactorEnabled ?? u.isTwoFactorEnabled),
    isTwoFactorEnabled: Boolean(u.isTwoFactorEnabled ?? u.twoFactorEnabled),
    profileCompletedAt: u.profileCompletedAt || null,
    isProfileComplete: Boolean(u.isProfileComplete ?? !u.profileCompletionRequired),
    profileCompletionRequired: Boolean(u.profileCompletionRequired),
    missingProfileFields: Array.isArray(u.missingProfileFields) ? u.missingProfileFields : [],
    isApiEnabled: Boolean(u.isApiEnabled),
    whitelistIps: Array.isArray(u.whitelistIps) ? u.whitelistIps.map((item) => String(item || '').trim()).filter(Boolean) : [],
    webhookUrl: String(u.webhookUrl || ''),
  };
};

/** Normalise an array of users */
const normaliseUsers = (arr) =>
  (Array.isArray(arr) ? arr : []).map(normaliseUser);

const normaliseWalletTransactionType = (value) => {
  const token = String(value || '').trim().toLowerCase();
  if (['credit', 'deposit', 'topup', 'top_up'].includes(token)) return 'credit';
  if (['debit', 'purchase', 'charge', 'deduct', 'deduction'].includes(token)) return 'debit';
  if (['refund', 'reversal'].includes(token)) return 'refund';
  return token || 'credit';
};

const getSignedWalletAmount = (amount, type) => (
  type === 'debit' ? -Math.abs(amount) : Math.abs(amount)
);

const normaliseWalletTransaction = (tx, fallbackUserId = '') => {
  if (!tx) return null;

  const rawUser = typeof tx.user === 'object' && tx.user !== null
    ? tx.user
    : (typeof tx.userId === 'object' && tx.userId !== null ? tx.userId : null);
  const user = rawUser ? normaliseUser(rawUser) : null;
  const type = normaliseWalletTransactionType(tx.type || tx.kind || tx.transactionType);
  const amount = toFiniteNumber(tx.amount ?? tx.value ?? tx.total ?? 0);
  const balanceAfterRaw = tx.balanceAfter ?? tx.balance ?? tx.walletBalance;
  const originalTransactionCurrency = resolveWalletTransactionOriginalCurrency(tx);
  const transactionCurrency = resolveWalletTransactionExecutionCurrency(
    tx,
    tx.walletCurrency || user?.currency || 'USD'
  );
  const rawUserId = typeof tx.userId === 'object' && tx.userId !== null
    ? (tx.userId._id || tx.userId.id || '')
    : tx.userId;

  // Preserve the reference field faithfully:
  //   • If the backend returned a populated object { orderNumber, customerInput, … }
  //     keep it as a plain object so resolveOrderMeta() can read sub-fields.
  //   • If it is null / undefined / a raw ObjectId string, fall through to alternate
  //     fields (referenceId, orderId, …) or null.
  const rawReference = tx.reference;
  const resolvedReference = (rawReference !== null && rawReference !== undefined && typeof rawReference === 'object')
    ? rawReference                                  // ← populated object — preserve as-is
    : (rawReference || tx.referenceId || tx.orderId || tx.depositId || tx.topupId || null);

  // Avoid using a populated object as the `id` string — use the nested _id instead
  const rawRefForId = (rawReference && typeof rawReference === 'object')
    ? (rawReference._id || rawReference.id || null)
    : rawReference;

  return {
    ...tx,
    id: tx._id || tx.id || tx.transactionId || rawRefForId || `${fallbackUserId || 'wallet'}-${type}-${tx.createdAt || Date.now()}`,
    _id: undefined,
    userId: String(rawUserId || user?.id || fallbackUserId || ''),
    user,
    type,
    amount: Math.abs(amount),
    signedAmount: toFiniteNumber(tx.signedAmount, getSignedWalletAmount(amount, type)),
    balanceAfter: balanceAfterRaw === undefined || balanceAfterRaw === null ? null : toFiniteNumber(balanceAfterRaw, 0),
    currency: transactionCurrency,
    originalCurrency: originalTransactionCurrency || null,
    status: String(tx.status || 'completed').trim().toLowerCase(),
    description: tx.description || tx.note || tx.title || '',
    reference: resolvedReference,
    sourceType: tx.sourceType || tx.targetType || null,
    sourceId: tx.sourceId || tx.orderId || tx.depositId || tx.topupId || null,
    createdAt: tx.createdAt || tx.date || tx.timestamp || null,
  };
};

const normaliseWalletSummary = (wallet, fallbackUserId = '') => {
  if (!wallet) return null;

  const rawUser = typeof wallet.user === 'object' && wallet.user !== null
    ? wallet.user
    : (typeof wallet.userId === 'object' && wallet.userId !== null ? wallet.userId : null);
  const user = rawUser ? normaliseUser(rawUser) : null;
  const rawUserId = typeof wallet.userId === 'object' && wallet.userId !== null
    ? (wallet.userId._id || wallet.userId.id || '')
    : wallet.userId;
  const recentTransactionsRaw = Array.isArray(wallet.recentTransactions)
    ? wallet.recentTransactions
    : (Array.isArray(wallet.transactions) ? wallet.transactions.slice(0, 5) : []);
  const recentTransactions = recentTransactionsRaw
    .map((entry) => normaliseWalletTransaction(entry, rawUserId || user?.id || fallbackUserId))
    .filter(Boolean);
  const walletSummary = getWalletBalanceSummary(wallet);
  const transactionsCount = toFiniteNumber(
    wallet.transactionsCount ?? wallet.totalTransactions ?? wallet.transactionCount ?? recentTransactions.length,
    recentTransactions.length
  );

  return {
    ...wallet,
    id: wallet._id || wallet.id || wallet.walletId || rawUserId || user?.id || fallbackUserId,
    _id: undefined,
    userId: String(rawUserId || user?.id || fallbackUserId || ''),
    user,
    userName: wallet.userName || user?.name || '',
    userEmail: wallet.userEmail || user?.email || '',
    currency: String(wallet.currency || wallet.currencyCode || wallet.walletCurrency || user?.currency || walletSummary.currency || 'USD').toUpperCase(),
    walletBalance: walletSummary.walletBalance,
    coins: walletSummary.walletBalance,
    balance: walletSummary.walletBalance,
    creditLimit: walletSummary.creditLimit,
    creditUsed: walletSummary.creditUsed,
    availableCredit: walletSummary.availableCredit,
    availableBalance: walletSummary.availableBalance,
    recentTransactions,
    transactionsCount,
    lastTransactionAt: wallet.lastTransactionAt || recentTransactions[0]?.createdAt || wallet.updatedAt || null,
    updatedAt: wallet.updatedAt || recentTransactions[0]?.createdAt || wallet.createdAt || null,
  };
};

const normaliseWalletSummaries = (arr) =>
  (Array.isArray(arr) ? arr : []).map((entry) => normaliseWalletSummary(entry)).filter(Boolean);

const looksLikeObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || '').trim());

const productHasReadableCategory = (product) => {
  const rawCategory = product?.category;
  if (rawCategory && typeof rawCategory === 'object' && !Array.isArray(rawCategory)) {
    return Boolean(rawCategory?.name || rawCategory?.nameAr || rawCategory?.title || rawCategory?.titleAr);
  }

  const categoryValue = String(rawCategory || '').trim();
  if (!categoryValue) return false;
  if (!looksLikeObjectId(categoryValue)) return true;

  return Boolean(
    product?.categoryName
    || product?.categoryNameAr
    || product?.categoryTitle
    || product?.categoryTitleAr
    || product?.categoryLabel
    || product?.categoryLabelAr
    || product?.categoryAr
  );
};

const productsHaveReadableCategories = (products) => (Array.isArray(products) ? products : []).some(productHasReadableCategory);

/** Normalise a group from BE to FE shape */
const normaliseGroup = (g) => {
  if (!g) return null;
  return {
    ...g,
    id: g._id || g.id,
    _id: undefined,
    name: g.name || '',
    image: resolveImageUrl(g.image),
    // BE uses "percentage", FE uses "discount"
    discount: g.percentage ?? g.discount ?? 0,
    percentage: g.percentage ?? g.discount ?? 0,
    billingMode: String(g.billingMode || 'standard').toLowerCase() === 'quantity' ? 'quantity_only' : String(g.billingMode || 'standard').toLowerCase(),
    isActive: g.isActive !== false,
  };
};

/**
 * Normalise a product from BE to FE shape.
 *
 * BE model fields → FE useMediaStore fields:
 *   _id                → id
 *   isActive           → status ('active'/'inactive'), productStatus ('available'/'unavailable')
 *   minQty / maxQty    → minimumOrderQty / maximumOrderQty
 *   basePrice          → basePriceCoins (kept alongside basePrice for compat)
 *   provider (ObjId)   → supplierId
 *   providerProduct    → externalProductId, externalProductName
 *   markupType/Value   → supplierMarginType / supplierMarginValue
 *   pricingMode        → externalPricingMode
 */
const normaliseProduct = (p) => {
  if (!p) return null;
  const id = p._id || p.id;
  const productStatus = String(p.productStatus || '').trim().toLowerCase();
  const rawStatus = String(p.status || '').trim().toLowerCase();
  const stoppedStatuses = new Set([
    'inactive',
    'disabled',
    'disable',
    'stopped',
    'stop',
    'paused',
    'pause',
    'unavailable',
    'not_available',
    'not-available',
    'out_of_service',
    'out-of-service',
    'suspended',
    'blocked',
    'off',
    'closed',
  ]);
  const hasExplicitIsActive = p.isActive !== undefined && p.isActive !== null;
  const explicitIsActiveValue = String(p.isActive ?? '').trim().toLowerCase();
  const explicitlyInactive = hasExplicitIsActive && (
    p.isActive === false
    || p.isActive === 0
    || explicitIsActiveValue === 'false'
    || explicitIsActiveValue === '0'
    || explicitIsActiveValue === 'inactive'
  );
  // Any explicit stop signal wins over a stale/conflicting `status: active`.
  const isStopped = explicitlyInactive
    || stoppedStatuses.has(productStatus)
    || stoppedStatuses.has(rawStatus);
  const isExplicitlyHidden = rawStatus === 'hidden' || productStatus === 'hidden';
  const isDeleted = Boolean(p.deletedAt || p.isDeleted === true);
  const normalizedStatus = isStopped ? 'inactive' : 'active';
  const resolvedProductStatus = stoppedStatuses.has(productStatus) || isStopped ? 'unavailable' : 'available';

  // Resolve populated provider reference
  const providerId = typeof p.provider === 'object' ? (p.provider?._id || p.provider?.id) : p.provider;
  // Resolve populated providerProduct reference
  const pp = typeof p.providerProduct === 'object' ? p.providerProduct : null;
  const rawProviderProductId = typeof p.providerProduct === 'string' || typeof p.providerProduct === 'number'
    ? p.providerProduct
    : '';
  const providerProductId = pp?._id || pp?.id || rawProviderProductId || p.providerProductId || p.externalProductId || '';
  const externalProductId = pp?.externalProductId || p.externalProductId || p.providerProductId || rawProviderProductId || '';
  const providerMapping = p.providerMapping || p.orderFieldsMapping || {};
  const supplierFieldMappings = Array.isArray(providerMapping)
    ? providerMapping
    : Object.entries(providerMapping || {}).map(([internalField, externalField]) => ({
      internalField,
      externalField,
    }));
  const usesProviderPricing = Boolean(
    p.syncPriceWithProvider
    || p.pricingMode === 'sync'
    || p.externalPricingMode === 'use_supplier_price'
    || p.externalPricingMode === 'supplier_price_plus_margin'
  );
  const externalPricingMode = p.externalPricingMode || (usesProviderPricing ? 'use_supplier_price' : 'use_local_price');
  const manualPriceAdjustment = p.manualPriceAdjustment ?? p.manualDelta ?? '';
  const resolvedProviderId = providerId || p.providerId || p.supplierId || '';
  const legacyCatalogPrice = getProviderCatalogPriceValue(p);
  const pickPriceValue = (...values) => {
    const usable = values.find((value) => {
      if (value === null || value === undefined || String(value).trim() === '') return false;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0;
    });
    if (usable !== undefined) return usable;
    return values.find((value) => value !== null && value !== undefined && String(value).trim() !== '') ?? 0;
  };
  const resolvedBasePrice = pickPriceValue(
    p.basePrice,
    p.basePriceCoins,
    p.priceCoins,
    p.price,
    p.displayPrice,
    legacyCatalogPrice
  );
  const resolvedDisplayPrice = pickPriceValue(
    p.displayPrice,
    p.markedUpPriceUSD,
    p.finalPrice,
    p.priceCoins,
    p.price,
    legacyCatalogPrice,
    null
  );
  const resolvedMinQty = getProviderCatalogMinQtyValue(p) ?? 1;
  const resolvedMaxQty = getProviderCatalogMaxQtyValue(p) ?? 999;
  const purchaseAccountNumber = String(
    p.displayAccountNumber
    || p.purchaseAccountNumber
    || p.accountNumber
    || p.productAccountNumber
    || ''
  ).trim();
  const showPurchaseAccountNumber = Boolean(
    p.showPurchaseAccountNumber
    ?? p.showAccountNumber
    ?? p.displayAccountNumber
    ?? false
  );

  return {
    ...p,
    id,
    _id: undefined,
    // Status mapping
    status: normalizedStatus,
    productStatus: resolvedProductStatus,
    isVisibleInStore: !isDeleted && !isExplicitlyHidden && p.isVisibleInStore !== false,
    showWhenUnavailable: p.showWhenUnavailable !== undefined
      ? Boolean(p.showWhenUnavailable)
      : resolvedProductStatus === 'unavailable',
    // Pricing
    basePriceCoins: resolvedBasePrice,
    basePrice: p.basePrice ?? resolvedBasePrice,
    originalPriceCoins: p.originalPriceCoins ?? p.originalPrice ?? p.costPrice ?? '',
    originalPrice: p.originalPrice ?? p.originalPriceCoins ?? p.costPrice ?? '',
    costPrice: p.costPrice ?? p.originalPriceCoins ?? p.originalPrice ?? '',
    displayPrice: resolvedDisplayPrice,
    markedUpPriceUSD: p.markedUpPriceUSD ?? p.finalPrice ?? null,
    displayCurrency: p.displayCurrency ?? null,
    // Quantity
    minimumOrderQty: p.minQty ?? p.minimumOrderQty ?? resolvedMinQty,
    maximumOrderQty: p.maxQty ?? p.maximumOrderQty ?? resolvedMaxQty,
    minQty: p.minQty ?? resolvedMinQty,
    maxQty: p.maxQty ?? resolvedMaxQty,
    // Supplier/Provider mapping
    supplierId: resolvedProviderId,
    providerId: resolvedProviderId,
    providerProductId,
    externalProductId,
    externalProductName: pp?.rawName || p.externalProductName || '',
    displayAccountNumber: purchaseAccountNumber,
    purchaseAccountNumber,
    accountNumber: p.accountNumber || purchaseAccountNumber,
    showPurchaseAccountNumber,
    showAccountNumber: p.showAccountNumber ?? showPurchaseAccountNumber,
    autoFulfillmentEnabled: p.autoFulfillmentEnabled !== undefined ? Boolean(p.autoFulfillmentEnabled) : (p.executionType === 'automatic'),
    // Markup → supplierMargin
    supplierMarginType: p.markupType || p.supplierMarginType || 'percentage',
    supplierMarginValue: p.markupValue ?? p.supplierMarginValue ?? 0,
    externalPricingMode,
    syncPriceWithProvider: p.syncPriceWithProvider !== undefined ? Boolean(p.syncPriceWithProvider) : usesProviderPricing,
    enableManualPrice: p.enableManualPrice !== undefined ? Boolean(p.enableManualPrice) : Number(manualPriceAdjustment || 0) !== 0,
    manualPriceAdjustment,
    syncedProviderBasePrice: p.syncedProviderBasePrice ?? p.rawPrice ?? null,
    fallbackSupplierId: p.fallbackSupplierId || '',
    supplierFieldMappings,
    supplierNotes: p.supplierNotes || '',
    // Category stays as-is (string in both BE and FE)
    category: p.category || '',
    // Resolve image URL so user-facing components get fully-qualified paths
    image: resolveImageUrl(p.image),
  };
};

/**
 * Normalise an order from BE to FE shape.
 *
 * BE order model fields → FE useOrderStore fields:
 *   _id                → id
 *   status (UPPERCASE)  → status (lowercase)
 *   productId (populated) → productName, productId
 *   userId (populated)    → userName, userId
 *   totalPrice / chargedAmount → priceCoins
 *   basePriceSnapshot   → unitPriceBase
 *   finalPriceCharged   → unitPrice
 *   currency, rateSnapshot, usdAmount → financialSnapshot
 */
const normaliseOrder = (o) => {
  if (!o) return null;
  const id = o._id || o.id;
  const resolvedOrderNumber = String(o.orderNumber || o.internalOrderNumber || id || '').trim();
  const resolvedSupplierOrderNumber = String(
    o.externalOrderId
    || o.supplierOrderNumber
    || o.providerOrderId
    || o.supplierResponseSnapshot?.data?.orderId
    || o.supplierResponseSnapshot?.orderId
    || ''
  ).trim();

  // Resolve populated refs
  const product = typeof o.productId === 'object' ? o.productId : null;
  const user = typeof o.userId === 'object' ? o.userId : null;
  const productIdStr = product?._id || product?.id || o.productId;
  const userIdStr = user?._id || user?.id || o.userId;

  return {
    ...o,
    id,
    _id: undefined,
    // Core IDs
    productId: productIdStr,
    userId: userIdStr,
    orderNumber: resolvedOrderNumber,
    internalOrderNumber: resolvedOrderNumber,
    siteOrderNumber: resolvedOrderNumber,
    externalOrderId: resolvedSupplierOrderNumber || null,
    supplierOrderNumber: resolvedSupplierOrderNumber || null,
    // Resolved names from populated refs
    productName: product?.name || o.productName || '',
    userName: user?.name || o.userName || '',
    userEmail: user?.email || o.userEmail || '',
    // Status: BE uses UPPERCASE, FE uses lowercase
    status: (o.status || 'pending').toLowerCase(),
    // Pricing aliases for FE
    priceCoins: o.chargedAmount ?? o.totalPrice ?? o.priceCoins ?? 0,
    billingModeSnapshot: String(o.billingModeSnapshot || o.billingMode || 'standard').toLowerCase() === 'quantity' ? 'quantity_only' : String(o.billingModeSnapshot || o.billingMode || 'standard').toLowerCase(),
    billingMode: String(o.billingModeSnapshot || o.billingMode || 'standard').toLowerCase() === 'quantity' ? 'quantity_only' : String(o.billingModeSnapshot || o.billingMode || 'standard').toLowerCase(),
    chargedAmount: Number(o.chargedAmount ?? o.totalPrice ?? o.priceCoins ?? 0),
    quantityCharged: Number(o.quantityCharged ?? 0),
    unitPriceBase: o.basePriceSnapshot ?? o.unitPriceBase ?? 0,
    unitPrice: o.finalPriceCharged ?? o.unitPrice ?? 0,
    quantity: o.quantity || 1,
    playerId: o.playerId
      || o.customerInput?.values?.playerId
      || o.customerInput?.values?.player_id
      || o.customerInput?.values?.userId
      || o.orderFieldsValues?.playerId
      || o.orderFieldsValues?.player_id
      || o.orderFieldsValues?.userId
      || o.orderFields?.playerId
      || o.orderFields?.player_id
      || o.orderFields?.userId
      || '',
    orderFieldsValues: o.orderFieldsValues
      || o.customerInput?.values
      || o.orderFields
      || {},
    customInputs: o.customInputs
      || o.customerInput?.values
      || o.orderFieldsValues
      || o.orderFields
      || {},
    orderFields: o.orderFields
      || o.orderFieldsValues
      || o.customerInput?.values
      || {},
    // Financial snapshot for FE store's deduction logic
    financialSnapshot: o.financialSnapshot || {
      originalCurrency: o.currency || 'USD',
      originalAmount: o.basePriceSnapshot || 0,
      exchangeRateAtExecution: o.rateSnapshot || 1,
      convertedAmountAtExecution: o.chargedAmount ?? o.totalPrice ?? 0,
      finalAmountAtExecution: o.chargedAmount ?? o.totalPrice ?? 0,
      pricingSnapshot: {
        basePrice: o.basePriceSnapshot || 0,
        groupDiscount: o.markupPercentageSnapshot || 0,
        unitPrice: o.finalPriceCharged || 0,
        finalPrice: o.chargedAmount ?? o.totalPrice ?? 0,
        currency: o.currency || 'USD',
      },
    },
    // Timestamps
    date: o.createdAt || o.date,
  };
};

/**
 * Normalise a deposit (BE) → topup (FE) shape.
 *
 * BE deposit model fields → FE useTopupStore fields:
 *   _id                   → id
 *   status (UPPERCASE)     → status (lowercase)
 *   requestedAmount       → requestedAmount, requestedCoins, amount
 *   amountUsd             → amountUsd, creditedCoins
 *   receiptImage          → proofImage
 *   paymentMethodId       → paymentMethodId
 *   currency              → currency
 *   exchangeRate          → exchangeRate
 *   notes                 → notes
 *   adminNotes            → adminNotes
 *   userId (populated)    → userId (string), userName
 *   reviewedBy (populated)→ reviewedBy (string), reviewerName
 */
const normaliseDeposit = (d) => {
  if (!d) return null;
  const id = d._id || d.id;

  // Resolve populated refs
  const user = typeof d.userId === 'object' ? d.userId : null;
  const reviewer = typeof d.reviewedBy === 'object' ? d.reviewedBy : null;
  const userIdStr = user?._id || user?.id || d.userId;
  const reviewerIdStr = reviewer?._id || reviewer?.id || d.reviewedBy;

  const status = (d.status || 'pending').toLowerCase();
  const requestedAmount = d.requestedAmount ?? d.amountRequested ?? d.amount ?? 0;
  const amountUsd = d.amountUsd ?? d.amountApproved ?? d.actualPaidAmount ?? null;
  const currency = d.currency || 'USD';
  const exchangeRate = d.exchangeRate ?? 1;
  const senderDetails = normaliseSenderDetails(d);

  // Resolve proof image URL — handle both new receiptImage and legacy transferImageUrl
  const rawProof = d.receiptImage || d.transferImageUrl || d.proofImage || '';
  const proofImage = resolveImageUrl(rawProof);

  return {
    ...d,
    id,
    _id: undefined,
    // Status
    status,
    // User info
    userId: userIdStr,
    userName: user?.name || d.userName || '',
    userEmail: user?.email || d.userEmail || '',
    // Reviewer info
    reviewedBy: reviewerIdStr || null,
    reviewerName: reviewer?.name || d.reviewerName || '',
    // Amount aliases (FE uses many field names for the same concept)
    requestedAmount,
    requestedCoins: requestedAmount,
    amount: requestedAmount,
    amountUsd,
    // actualPaidAmount = the amount the user ACTUALLY paid in their LOCAL currency.
    // Do NOT alias this to amountUsd — that's the USD conversion for internal accounting.
    actualPaidAmount: requestedAmount,
    creditedCoins: status === 'approved' ? requestedAmount : null,
    // Multi-currency fields
    currency,
    currencyCode: currency,          // alias — AdminPayments reads currencyCode
    exchangeRate,
    paymentMethodId: d.paymentMethodId || '',
    transactionId: d.transactionId || d.transactionNumber || d.paymentReference || d.operationNumber || d.operationId || d.referenceNumber || d.transferNumber || d.transferReference || d.transaction?.number || d.transaction?.id || '',
    transactionNumber: d.transactionNumber || d.transactionId || d.paymentReference || d.operationNumber || d.operationId || d.referenceNumber || d.transferNumber || d.transferReference || d.transaction?.number || d.transaction?.id || '',
    paymentReference: d.paymentReference || d.transactionId || d.transactionNumber || d.operationNumber || d.operationId || d.referenceNumber || d.transferNumber || d.transferReference || d.transaction?.number || d.transaction?.id || '',
    notes: d.notes || '',
    adminNotes: d.adminNotes || '',
    // Transfer proof
    proofImage,
    senderDetails,
    senderWalletNumber: senderDetails?.field === 'senderWalletNumber'
      ? senderDetails.value
      : (d.transferredFromNumber || d.senderWalletNumber || ''),
    senderWalletAddress: senderDetails?.field === 'senderWalletAddress'
      ? senderDetails.value
      : (d.senderWalletAddress || ''),
    transferredFromNumber: senderDetails?.value || d.transferredFromNumber || d.senderWalletNumber || d.senderWalletAddress || '',
    // Timestamps
    createdAt: d.createdAt || d.date,
    reviewedAt: d.reviewedAt || null,
    // Financial snapshot for FE store's credit logic
    financialSnapshot: d.financialSnapshot || (status === 'approved' ? {
      originalCurrency: currency,
      originalAmount: requestedAmount,
      exchangeRateAtExecution: exchangeRate,
      convertedAmountAtExecution: amountUsd || requestedAmount,
      finalAmountAtExecution: amountUsd || requestedAmount,
      pricingSnapshot: { baseRate: exchangeRate, fees: 0, discount: 0, finalRate: exchangeRate },
      feesSnapshot: { processingFee: 0, transferFee: 0, totalFees: 0 },
    } : null),
  };
};

/**
 * Normalise a provider (BE) → supplier (FE) shape.
 *
 * BE provider model fields → FE AdminSuppliers fields:
 *   _id             → id
 *   name            → supplierName
 *   slug            → supplierCode
 *   baseUrl         → baseUrl
 *   apiToken        → bearerToken (and apiKey alias)
 *   apiKey (legacy)  → apiKey
 *   isActive        → isActive
 *   syncInterval    → syncInterval
 *   supportedFeatures → feature flags
 */
const normaliseProvider = (p) => {
  if (!p) return null;
  const id = p._id || p.id;
  const effectiveToken = p.apiToken || p.apiKey || '';

  return {
    ...p,
    id,
    _id: undefined,
    // Name & code
    supplierName: p.name || p.supplierName || '',
    supplierCode: p.slug || p.supplierCode || '',
    name: p.name || p.supplierName || '',
    // API config
    baseUrl: p.baseUrl || '',
    apiKey: effectiveToken,
    bearerToken: effectiveToken,
    authType: effectiveToken ? 'bearer_token' : 'none',
    supplierType: 'api',
    // Status
    isActive: p.isActive !== false,
    // Sync
    syncInterval: p.syncInterval ?? 60,
    supportedFeatures: p.supportedFeatures || [],
    enableAutoFulfillment: (p.supportedFeatures || []).includes('placeOrder'),
    enableStatusSync: (p.supportedFeatures || []).includes('checkOrder'),
    enableProductSync: (p.supportedFeatures || []).includes('fetchProducts'),
    linkedProductsCount: p.linkedProductsCount ?? p.productsCount ?? p.catalogProductsCount ?? 0,
    syncedProductsCount: p.syncedProductsCount ?? p.productsCount ?? p.catalogProductsCount ?? 0,
    lastProductSyncAt: p.lastProductSyncAt || p.productsSyncedAt || p.catalogSyncedAt || null,
    // Connection test — always 'not_tested' from BE (no endpoint)
    lastConnectionTestStatus: p.lastConnectionTestStatus || 'not_tested',
    lastConnectionTestAt: p.lastConnectionTestAt || null,
    lastConnectionTestMessage: p.lastConnectionTestMessage || '',
    // Timestamps
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
};

/**
 * Reverse-map FE supplier payload → BE provider validation schema.
 *
 * BE create accepts: { name, slug, baseUrl, apiToken, isActive, syncInterval, supportedFeatures }
 * BE update accepts: same fields, all optional, .min(1)
 *
 * FE sends: { supplierName, supplierCode, baseUrl, apiKey, bearerToken,
 *             authType, supplierType, isActive, syncInterval,
 *             enableAutoFulfillment, enableStatusSync, enableProductSync, ... }
 */
const providerToBE = (fe) => {
  const body = {};
  const trimValue = (value) => (typeof value === 'string' ? value.trim() : value);

  // Name
  const name = trimValue(fe.supplierName || fe.name);
  if (name !== undefined) body.name = name;

  // Slug
  const slug = trimValue(fe.supplierCode || fe.slug);
  if (slug !== undefined) body.slug = slug;

  // Base URL
  if (fe.baseUrl !== undefined) body.baseUrl = trimValue(fe.baseUrl);

  // API token: FE may store it in apiKey, bearerToken, or apiToken
  const token = trimValue(fe.bearerToken || fe.apiKey || fe.apiToken);
  if (token !== undefined) body.apiToken = token;

  // Active status
  if (fe.isActive !== undefined) body.isActive = fe.isActive;

  // Sync interval
  if (fe.syncInterval !== undefined) body.syncInterval = Number(fe.syncInterval);

  // Supported features — synthesize from FE boolean flags
  if (fe.enableAutoFulfillment !== undefined || fe.enableStatusSync !== undefined || fe.enableProductSync !== undefined) {
    const features = [];
    if (fe.enableAutoFulfillment) features.push('placeOrder');
    if (fe.enableStatusSync) features.push('checkOrder', 'checkOrdersBatch');
    if (fe.enableProductSync) features.push('fetchProducts');
    body.supportedFeatures = features;
  } else if (fe.supportedFeatures !== undefined) {
    body.supportedFeatures = fe.supportedFeatures;
  }

  return body;
};

const normaliseTargetApp = (app = {}) => {
  const id = app._id || app.id;
  const allowedPaymentMethods = Array.isArray(app.allowedPaymentMethods)
    ? app.allowedPaymentMethods.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  return {
    ...app,
    id,
    _id: undefined,
    name: String(app.name || '').trim(),
    targetAccountId: String(app.targetAccountId || app.receivingAccountId || app.receiverAccountId || app.recipientAccountId || app.targetRecipientId || app.receivingAccount || app.targetAccount || app.destinationAccountId || app.accountId || app.accountNumber || '').trim(),
    receivingAccountId: String(app.receivingAccountId || app.targetAccountId || app.receiverAccountId || app.recipientAccountId || app.targetRecipientId || app.receivingAccount || app.targetAccount || app.destinationAccountId || app.accountId || app.accountNumber || '').trim(),
    unitPrice: Number(app.unitPrice || 0),
    image: resolveImageUrl(app.image),
    imagePath: app.image || '',
    allowedPaymentMethods,
    paymentMethodIds: allowedPaymentMethods,
    isActive: app.isActive !== false,
  };
};

const normaliseTargetOrderUser = (order = {}) => {
  const userRecord = (() => {
    if (order.user && typeof order.user === 'object') return order.user;
    if (order.userId && typeof order.userId === 'object') return order.userId;
    if (order.customer && typeof order.customer === 'object') return order.customer;
    if (order.customerId && typeof order.customerId === 'object') return order.customerId;
    if (order.createdBy && typeof order.createdBy === 'object') return order.createdBy;
    return {};
  })();

  const userId = String(
    userRecord._id
    || userRecord.id
    || order.userId
    || order.customerId
    || order.createdBy
    || order.user
    || ''
  ).trim();

  const userName = String(
    order.userName
    || order.customerName
    || userRecord.name
    || userRecord.fullName
    || userRecord.username
    || ''
  ).trim();

  const userEmail = String(
    order.userEmail
    || order.customerEmail
    || order.email
    || userRecord.email
    || ''
  ).trim();

  return { userId, userName, userEmail };
};

const normaliseTargetOrder = (order = {}) => {
  const id = order._id || order.id;
  const app = typeof order.appId === 'object' && order.appId !== null ? normaliseTargetApp(order.appId) : null;
  const coinAmount = Number(order.coinAmount ?? order.quantity ?? order.coins ?? 0);
  const unitPrice = Number(order.unitPriceSnapshot ?? order.unitPrice ?? app?.unitPrice ?? 0);
  const totalPrice = Number(order.totalPrice ?? (coinAmount * unitPrice));
  const status = String(order.status || 'PENDING').trim().toUpperCase();
  const orderUser = normaliseTargetOrderUser(order);
  const paymentMethodId = String(order.paymentMethodIdSnapshot || order.paymentMethodId || order.paymentMethod || '').trim();
  const paymentMethodName = String(order.paymentMethodNameSnapshot || order.paymentMethodName || order.paymentMethod || '').trim();

  return {
    ...order,
    id,
    _id: undefined,
    appId: app?.id || order.appId,
    app,
    appNameSnapshot: order.appNameSnapshot || app?.name || order.productName || '',
    productName: order.appNameSnapshot || app?.name || order.productName || '',
    targetAccountIdSnapshot: order.targetAccountIdSnapshot || order.targetAccountId || order.receivingAccountId || order.recipientAccountId || order.targetRecipientId || order.receivingAccount || order.targetAccount || order.destinationAccountId || app?.targetAccountId || '',
    targetAccountId: order.targetAccountIdSnapshot || order.targetAccountId || order.receivingAccountId || order.recipientAccountId || order.targetRecipientId || order.receivingAccount || order.targetAccount || order.destinationAccountId || app?.targetAccountId || '',
    coinAmount,
    quantity: coinAmount,
    unitPriceSnapshot: unitPrice,
    unitPrice,
    totalPrice,
    paymentMethod: paymentMethodName || paymentMethodId,
    paymentMethodId,
    paymentMethodName: paymentMethodName || paymentMethodId,
    transferNumber: order.transferNumber || order.vodafoneCashNumber || order.paymentAccount || '',
    paymentAccount: order.transferNumber || order.vodafoneCashNumber || order.paymentAccount || '',
    transactionNumber: order.transactionNumber || order.transactionId || order.paymentReference || '',
    transactionId: order.transactionNumber || order.transactionId || order.paymentReference || '',
    senderId: order.senderId || order.playerId || order.transferFromId || '',
    transferFromId: order.senderId || order.playerId || order.transferFromId || '',
    screenshotProof: resolveImageUrl(order.screenshotProof || order.proofImage || ''),
    proofImage: resolveImageUrl(order.screenshotProof || order.proofImage || ''),
    status,
    ...orderUser,
  };
};

const appendIfPresent = (formData, key, value) => {
  if (value === undefined || value === null || value === '') return;
  formData.append(key, value);
};

const isFileLike = (value) => (
  (typeof File !== 'undefined' && value instanceof File)
  || (typeof Blob !== 'undefined' && value instanceof Blob)
);

const buildTargetAppFormData = (payload = {}, { partial = false } = {}) => {
  const formData = new FormData();
  if (!partial || payload.name !== undefined) appendIfPresent(formData, 'name', String(payload.name || '').trim());
  if (!partial || payload.targetAccountId !== undefined || payload.receivingAccountId !== undefined) {
    const targetAccountId = String(payload.targetAccountId || payload.receivingAccountId || '').trim();
    appendIfPresent(formData, 'targetAccountId', targetAccountId);
    appendIfPresent(formData, 'receivingAccountId', targetAccountId);
  }
  if (!partial || payload.unitPrice !== undefined) appendIfPresent(formData, 'unitPrice', String(payload.unitPrice ?? ''));
  if (!partial || payload.allowedPaymentMethods !== undefined || payload.paymentMethodIds !== undefined) {
    const methods = payload.allowedPaymentMethods || payload.paymentMethodIds || [];
    formData.append('allowedPaymentMethods', JSON.stringify(Array.isArray(methods) ? methods : []));
  }
  if (payload.isActive !== undefined) formData.append('isActive', String(payload.isActive !== false));
  const image = payload.imageFile || payload.file || payload.image;
  if (isFileLike(image)) {
    formData.append('image', image);
  } else if (typeof image === 'string' && image && !image.startsWith('data:') && !/^https?:\/\//i.test(image)) {
    formData.append('image', image);
  }
  return formData;
};

const buildTargetOrderFormData = (payload = {}) => {
  const formData = new FormData();
  const usesSiteWallet = payload.isSiteWalletPayment || isSiteWalletPaymentMethod(payload.paymentMethodId || payload.paymentMethod || payload.paymentMethodName);
  const transactionReference = String(
    payload.transactionNumber
    || payload.transactionId
    || payload.paymentReference
    || (usesSiteWallet ? `site-wallet-${Date.now()}` : payload.transferNumber)
    || ''
  ).trim();
  formData.append('appId', String(payload.appId || payload.productId || ''));
  formData.append('coinAmount', String(payload.coinAmount ?? payload.quantity ?? ''));
  formData.append('senderId', String(payload.senderId || payload.transferFromId || payload.playerId || '').trim());
  formData.append('transferNumber', String(payload.transferNumber || payload.paymentAccount || (usesSiteWallet ? 'محفظة الموقع' : '')).trim());
  formData.append('transactionNumber', transactionReference);
  formData.append('paymentReference', transactionReference);
  formData.append('paymentMethod', String(payload.paymentMethod || payload.paymentMethodName || '').trim());
  appendIfPresent(formData, 'paymentMethodName', String(payload.paymentMethodName || '').trim());
  appendIfPresent(formData, 'paymentMethodId', String(payload.paymentMethodId || '').trim());
  if (usesSiteWallet) formData.append('transferImageUrl', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
  appendIfPresent(formData, 'userName', String(payload.userName || '').trim());
  appendIfPresent(formData, 'userEmail', String(payload.userEmail || '').trim());
  appendIfPresent(formData, 'idempotencyKey', String(payload.idempotencyKey || createClientIdempotencyKey()).trim());
  const file = payload.screenshotProof || payload.proofImage || payload.receipt || null;
  if (file) formData.append('screenshotProof', file);
  return formData;
};

const createClientIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `target-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const normalizeReferralCurrency = (value, fallback = 'USD') =>
  String(value || fallback).trim().toUpperCase();

const normalizeReferralNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const referralPayoutStatusToUi = (status) => {
  const code = String(status || '').trim().toUpperCase();
  if (code === 'PAID' || code === 'COMPLETED' || code === 'SUCCESS') return 'completed';
  if (code === 'REJECTED' || code === 'FAILED') return 'failed';
  return 'processing';
};

const normalizeSubAgentRequest = (request = {}) => ({
  ...request,
  id: request.id || request._id || '',
  userId: request.userId || request.user?.id || '',
  name: request.name || request.user?.name || '',
  email: request.email || request.user?.email || '',
  message: request.message || request.notes || '',
  proofImage: resolveImageUrl(request.proofImage || request.proofUrl || ''),
  proofUrl: resolveImageUrl(request.proofUrl || request.proofImage || ''),
  status: String(request.status || request.statusCode || 'pending').toLowerCase(),
  statusCode: String(request.statusCode || request.status || 'PENDING').toUpperCase(),
  currentGroup: request.currentGroup || request.user?.group || null,
  approvedGroup: request.approvedGroup || null,
  rejectionReason: request.rejectionReason || null,
  createdAt: request.createdAt || null,
  reviewedAt: request.reviewedAt || null,
});

const normalizeReferralCommission = (commission = {}) => {
  const referredUser = commission.referredUser || commission.referredUserId || {};
  return {
    ...commission,
    id: commission.id || commission._id || '',
    referredUser: typeof referredUser === 'object' ? {
      id: referredUser.id || referredUser._id || '',
      name: referredUser.name || '',
      email: referredUser.email || '',
    } : null,
    sourceType: commission.sourceType || '',
    sourceDate: commission.sourceCompletedAt || commission.sourceDate || commission.createdAt || null,
    originalAmount: commission.originalAmount || '0.000000',
    originalCurrency: normalizeReferralCurrency(commission.originalCurrency),
    commissionPercent: commission.commissionPercentSnapshot || commission.commissionPercent || '0',
    amount: commission.commissionAmountReferrerCurrency || commission.amount || '0.000000',
    currency: normalizeReferralCurrency(commission.referrerCurrency || commission.currency),
    status: String(commission.status || '').toLowerCase(),
    statusCode: String(commission.status || '').toUpperCase(),
    createdAt: commission.createdAt || null,
  };
};

const normalizeReferralPayout = (payout = {}, { includeFullExternal = false } = {}) => {
  const summary = payout.externalPaymentSummary || payout.externalSummary || {};
  const fullDetails = includeFullExternal ? (payout.externalPaymentDetails || {}) : {};
  const external = { ...summary, ...fullDetails };
  return {
    ...payout,
    id: payout.id || payout._id || '',
    user: payout.user || null,
    ownerName: payout.ownerName || payout.user?.name || '',
    ownerEmail: payout.ownerEmail || payout.user?.email || '',
    ownerAvatar: resolveUserAvatar(payout.user || {}, payout.user?.email || payout.user?.name || ''),
    method: payout.methodAlias || payout.withdrawalMethod || String(payout.method || 'wallet').toLowerCase(),
    methodName: payout.methodName || external.methodType || payout.methodAlias || payout.withdrawalMethod || payout.method || 'wallet',
    amount: normalizeReferralNumber(payout.amount),
    requestedAmount: normalizeReferralNumber(payout.requestedAmount ?? payout.amount),
    currency: normalizeReferralCurrency(payout.currency, 'EGP'),
    status: referralPayoutStatusToUi(payout.statusCode || payout.status),
    statusCode: String(payout.statusCode || payout.status || '').toUpperCase(),
    createdAt: payout.createdAt || null,
    completedAt: payout.completedAt || payout.paidAt || null,
    reviewedAt: payout.reviewedAt || null,
    rejectionReason: payout.rejectionReason || null,
    accountHolder: external.accountName || '',
    accountNumber: external.phoneNumber || external.accountNumber || external.iban || external.walletAddress || '',
    phone: external.phoneNumber || external.accountNumber || '',
    reference: payout.externalTransactionReference || payout.externalTransactionReferenceFull || '',
    receiptImage: resolveImageUrl(payout.receiptImage || payout.paymentProofUrl || ''),
    raw: payout,
  };
};

const normalizeReferralCustomer = (customer = {}, fallbackCurrency = 'USD', index = 0) => ({
  ...customer,
  id: customer.id || customer._id || `referral-${index}`,
  name: customer.name || customer.username || customer.email || `Customer ${index + 1}`,
  email: customer.email || '',
  avatar: resolveUserAvatar(customer, customer.email || customer.name || `Customer ${index + 1}`),
  addedAmount: normalizeReferralNumber(customer.addedAmount ?? customer.totalDeposits ?? customer.depositsTotal ?? customer.topupTotal),
  earnings: normalizeReferralNumber(customer.earnings ?? customer.referralEarnings ?? customer.commission),
  currency: normalizeReferralCurrency(customer.currency, fallbackCurrency),
  invitedAt: customer.invitedAt || customer.referredAt || customer.createdAt || null,
  expiresAt: customer.expiresAt || customer.referralEligibleUntil || null,
});

const normalizeReferralDashboard = (dashboard = {}, user = {}) => {
  const currency = normalizeReferralCurrency(dashboard.displayCurrency || dashboard.walletCurrency || user.currency);
  const invitedUsers = Array.isArray(dashboard.invitedUsers || dashboard.referredCustomers)
    ? (dashboard.invitedUsers || dashboard.referredCustomers).map((customer, index) => normalizeReferralCustomer(customer, currency, index))
    : [];
  return {
    ...dashboard,
    referralCode: dashboard.referralCode || user.referralCode || user.inviteCode || '',
    referralLinkPath: dashboard.referralLinkPath || '',
    walletCurrency: currency,
    displayCurrency: currency,
    referralCount: normalizeReferralNumber(dashboard.referralCount ?? invitedUsers.length),
    invitedUsers,
    referredCustomers: invitedUsers,
    availableEarnings: dashboard.availableEarnings || {},
    lockedEarnings: dashboard.lockedEarnings || {},
    paidEarnings: dashboard.paidEarnings || {},
    displayAvailableEarnings: dashboard.displayAvailableEarnings || dashboard.availableEarnings?.[currency] || '0.000000',
    currentGroup: dashboard.currentGroup || null,
    resellerStatus: dashboard.resellerStatus || 'NONE',
  };
};

const normalizeReferralPayoutMethod = (method = {}, index = 0) => ({
  id: String(method.id || method.code || `method-${index}`).trim().toLowerCase(),
  name: String(method.name || method.label || method.id || `Method ${index + 1}`).trim(),
  enabled: method.enabled !== false && method.isActive !== false,
  requiresAccount: method.requiresAccount !== false && String(method.id || method.code || '').toLowerCase() !== 'wallet',
  discountPercent: Math.min(100, Math.max(0, normalizeReferralNumber(method.discountPercent))),
  kind: method.kind || (String(method.id || '').toLowerCase() === 'wallet' ? 'wallet_credit' : 'manual_external'),
  sortOrder: normalizeReferralNumber(method.sortOrder, index),
});

const normalizeAdminReferralAgent = (agent = {}, index = 0) => {
  const currency = normalizeReferralCurrency(agent.currency, 'EGP');
  const referrals = Array.isArray(agent.referrals)
    ? agent.referrals.map((entry, referralIndex) => normalizeReferralCustomer(entry, currency, referralIndex))
    : [];
  const withdrawals = Array.isArray(agent.withdrawals)
    ? agent.withdrawals.map(normalizeReferralPayout)
    : [];
  return {
    ...agent,
    id: agent.id || agent._id || `owner-${index}`,
    name: agent.name || agent.username || agent.email || `User ${index + 1}`,
    email: agent.email || '',
    avatar: resolveUserAvatar(agent, agent.email || agent.name),
    code: agent.code || agent.referralCode || agent.inviteCode || '—',
    currency,
    referrals,
    withdrawals,
    earnings: normalizeReferralNumber(agent.earnings ?? agent.referralRewards ?? agent.referralEarnings),
    availableEarnings: normalizeReferralNumber(agent.availableEarnings),
    lockedEarnings: normalizeReferralNumber(agent.lockedEarnings),
    paidEarnings: normalizeReferralNumber(agent.paidEarnings),
    withdrawn: normalizeReferralNumber(agent.withdrawn),
    currentCommissionPercent: normalizeReferralNumber(agent.currentCommissionPercent ?? agent.defaultCommissionPercent),
    referralCommissionPercentOverride: agent.referralCommissionPercentOverride ?? null,
    group: agent.group || null,
  };
};

/**
 * Normalise a currency from BE to FE shape.
 *
 * BE currency model fields → FE fields:
 *   _id / code        → id (use code as primary key)
 *   code              → code
 *   name              → name
 *   symbol            → symbol
 *   platformRate      → rate (FE's primary rate field)
 *   marketRate        → marketRate
 *   markupPercentage  → markupPercentage
 *   isActive          → isActive
 *   lastUpdatedAt     → lastUpdatedAt
 *   effectiveRate (virtual) → effectiveRate
 *   spreadPercent (virtual) → spreadPercent
 */
const normaliseCurrency = (c) => {
  if (!c) return null;
  return {
    ...c,
    id: c._id || c.id || c.code,
    _id: undefined,
    code: c.code || '',
    name: c.name || c.code || '',
    symbol: c.symbol || '',
    // FE expects `rate` as the primary platform rate
    rate: c.platformRate ?? c.rate ?? 1,
    platformRate: c.platformRate ?? c.rate ?? 1,
    marketRate: c.marketRate ?? null,
    markupPercentage: c.markupPercentage ?? 0,
    effectiveRate: c.effectiveRate ?? c.platformRate ?? c.rate ?? 1,
    spreadPercent: c.spreadPercent ?? null,
    isActive: c.isActive !== false,
    lastUpdatedAt: c.lastUpdatedAt || c.updatedAt || null,
  };
};

/**
 * Normalise a category from BE to FE shape.
 *
 * BE category model fields → FE fields:
 *   _id         → id
 *   name        → name
 *   nameAr      → nameAr
 *   image       → image
 *   slug        → slug
 *   sortOrder   → sortOrder
 *   isActive    → isActive
 */
const normaliseCategory = (c) => {
  if (!c) return null;

  // Bulletproof parentCategory extraction
  const rawParent = c.parentCategory;
  let parentCategory = null;
  if (rawParent) {
    if (typeof rawParent === 'object') {
      parentCategory = String(rawParent._id || rawParent.id || '').trim() || null;
    } else if (typeof rawParent === 'string') {
      parentCategory = rawParent.trim() || null;
    } else {
      parentCategory = String(rawParent).trim() || null;
    }
  }

  return {
    ...c,
    id: c._id || c.id,
    _id: c._id || c.id,
    name: c.name || '',
    nameAr: c.nameAr || '',
    image: resolveImageUrl(c.image),
    slug: c.slug || '',
    sortOrder: c.sortOrder ?? 0,
    isActive: c.isActive !== false,
    parentCategory,
  };
};

/**
 * Reverse-map FE product fields → BE model fields for create / update.
 *
 * Only sends fields the BE updateProduct whitelist accepts:
 *   name, description, image, category, displayOrder, isActive,
 *   basePrice, minQty, maxQty, pricingMode, markupType, markupValue,
 *   executionType, orderFields, providerMapping
 */
const productToBE = (fe) => {
  const body = {};

  // Direct pass-through fields
  if (fe.name !== undefined) body.name = fe.name;
  if (fe.nameAr !== undefined) body.nameAr = fe.nameAr;
  if (fe.description !== undefined) body.description = fe.description;
  if (fe.descriptionAr !== undefined) body.descriptionAr = fe.descriptionAr;
  if (fe.image !== undefined) body.image = fe.image;
  if (fe.category !== undefined) body.category = fe.category;
  if (fe.category !== undefined) body.categoryId = fe.category;
  if (fe.displayOrder !== undefined) body.displayOrder = fe.displayOrder;
  if (fe.orderFields !== undefined) body.orderFields = fe.orderFields;
  if (fe.dynamicFields !== undefined) {
    body.dynamicFields = (Array.isArray(fe.dynamicFields) ? fe.dynamicFields : [])
      .map((field, index) => {
        const rawName = String(field?.name || field?.key || `field_${index + 1}`).trim();
        const sanitizedName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const label = String(field?.label || rawName).trim();
        const type = String(field?.type || 'text').trim().toLowerCase();
        return {
          name: sanitizedName,
          label,
          type: ['text', 'number', 'email', 'select', 'image', 'file'].includes(type) ? type : 'text',
          required: field?.required !== false,
          isVerifiable: field?.isVerifiable === true,
        };
      })
      .filter((field) => field.name && field.label);
  }
  if (fe.productStatus !== undefined) body.productStatus = fe.productStatus;
  if (fe.isVisibleInStore !== undefined) body.isVisibleInStore = Boolean(fe.isVisibleInStore);
  if (fe.showWhenUnavailable !== undefined) body.showWhenUnavailable = Boolean(fe.showWhenUnavailable);
  if (fe.pauseSales !== undefined) body.pauseSales = Boolean(fe.pauseSales);
  if (fe.pauseReason !== undefined) body.pauseReason = fe.pauseReason;
  if (fe.internalNotes !== undefined) body.internalNotes = fe.internalNotes;
  if (fe.enableSchedule !== undefined) body.enableSchedule = Boolean(fe.enableSchedule);
  if (fe.scheduledStartAt !== undefined) body.scheduledStartAt = fe.scheduledStartAt;
  if (fe.scheduledEndAt !== undefined) body.scheduledEndAt = fe.scheduledEndAt;
  if (fe.scheduleVisibilityMode !== undefined) body.scheduleVisibilityMode = fe.scheduleVisibilityMode;
  if (fe.trackInventory !== undefined) body.trackInventory = Boolean(fe.trackInventory);
  if (fe.stockQuantity !== undefined) body.stockQuantity = Number(fe.stockQuantity);
  if (fe.lowStockThreshold !== undefined) body.lowStockThreshold = Number(fe.lowStockThreshold);
  if (fe.hideWhenOutOfStock !== undefined) body.hideWhenOutOfStock = Boolean(fe.hideWhenOutOfStock);
  if (fe.showOutOfStockLabel !== undefined) body.showOutOfStockLabel = Boolean(fe.showOutOfStockLabel);

  // Pricing: FE uses basePriceCoins, BE uses basePrice
  // Send as String to preserve full 50dp precision — no Number() truncation.
  if (fe.basePriceCoins !== undefined) body.basePrice = String(fe.basePriceCoins);
  else if (fe.basePrice !== undefined) body.basePrice = String(fe.basePrice);
  if (fe.originalPriceCoins !== undefined) body.originalPriceCoins = String(fe.originalPriceCoins || '');
  if (fe.originalPrice !== undefined) body.originalPrice = String(fe.originalPrice || '');
  if (fe.costPrice !== undefined) body.costPrice = String(fe.costPrice || '');

  // Quantity: FE uses minimumOrderQty / maximumOrderQty, BE uses minQty / maxQty
  if (fe.minimumOrderQty !== undefined) body.minQty = Number(fe.minimumOrderQty);
  else if (fe.minQty !== undefined) body.minQty = Number(fe.minQty);

  if (fe.maximumOrderQty !== undefined) body.maxQty = Number(fe.maximumOrderQty);
  else if (fe.maxQty !== undefined) body.maxQty = Number(fe.maxQty);

  // Status: FE uses status 'active'/'inactive', BE uses isActive boolean
  if (fe.status !== undefined) body.isActive = fe.status === 'active';
  else if (fe.isActive !== undefined) body.isActive = fe.isActive;

  // Execution: FE uses autoFulfillmentEnabled, BE uses executionType
  if (fe.autoFulfillmentEnabled !== undefined) {
    body.executionType = fe.autoFulfillmentEnabled ? 'automatic' : 'manual';
  } else if (fe.executionType !== undefined) {
    body.executionType = fe.executionType;
  }

  // Markup: FE uses supplierMarginType/Value, BE uses markupType/Value
  if (fe.supplierMarginType !== undefined) body.markupType = fe.supplierMarginType;
  else if (fe.markupType !== undefined) body.markupType = fe.markupType;

  if (fe.supplierMarginValue !== undefined) body.markupValue = Number(fe.supplierMarginValue);
  else if (fe.markupValue !== undefined) body.markupValue = Number(fe.markupValue);

  // Pricing mode: FE uses externalPricingMode, BE uses pricingMode
  if (fe.externalPricingMode !== undefined) {
    body.pricingMode = ['use_supplier_price', 'supplier_price_plus_margin'].includes(fe.externalPricingMode) ? 'sync' : 'manual';
  } else if (fe.pricingMode !== undefined) {
    body.pricingMode = fe.pricingMode;
  }

  const providerId = String(fe.providerId || fe.supplierId || '').trim();
  if (providerId) {
    body.provider = providerId;
    body.providerId = providerId;
    body.supplierId = providerId;
  }

  // Provider mapping (for auto-fulfilled products)
  if (fe.providerMapping !== undefined) body.providerMapping = fe.providerMapping;
  if (fe.supplierFieldMappings !== undefined) {
    // Convert array format [{key, providerKey}] → { key: providerKey } map
    if (Array.isArray(fe.supplierFieldMappings)) {
      body.providerMapping = {};
      fe.supplierFieldMappings.forEach((m) => {
        const internalField = m.key || m.internalField;
        const externalField = m.providerKey || m.externalField;
        if (internalField && externalField) body.providerMapping[internalField] = externalField;
      });
    }
  }

  // Provider product linkage (for publish-from-provider flow)
  if (fe.providerProductId || fe.externalProductId) {
    const providerProductId = String(fe.providerProductId || fe.externalProductId || '').trim();
    body.providerProductId = providerProductId;
    body.providerProduct = providerProductId;
  }

  if (fe.externalProductId !== undefined) body.externalProductId = fe.externalProductId;
  if (fe.externalProductName !== undefined) body.externalProductName = fe.externalProductName;
  if (fe.displayAccountNumber !== undefined || fe.purchaseAccountNumber !== undefined || fe.accountNumber !== undefined) {
    const accountNumber = String(fe.displayAccountNumber ?? fe.purchaseAccountNumber ?? fe.accountNumber ?? '').trim();
    body.displayAccountNumber = accountNumber;
    body.purchaseAccountNumber = accountNumber;
    body.accountNumber = accountNumber;
  }
  if (fe.showPurchaseAccountNumber !== undefined || fe.showAccountNumber !== undefined) {
    const shouldShowAccountNumber = Boolean(fe.showPurchaseAccountNumber ?? fe.showAccountNumber);
    body.showPurchaseAccountNumber = shouldShowAccountNumber;
    body.showAccountNumber = shouldShowAccountNumber;
  }
  if (fe.syncPriceWithProvider !== undefined) {
    const shouldSyncWithProvider = Boolean(fe.syncPriceWithProvider);
    body.syncPriceWithProvider = shouldSyncWithProvider;
    if (fe.externalPricingMode === undefined && fe.pricingMode === undefined) {
      body.pricingMode = shouldSyncWithProvider ? 'sync' : 'manual';
    }
  }
  if (fe.enableManualPrice !== undefined) body.enableManualPrice = Boolean(fe.enableManualPrice);
  if (fe.manualPriceAdjustment !== undefined) {
    const manualAdjustment = String(fe.manualPriceAdjustment || '0');
    body.manualPriceAdjustment = manualAdjustment;
    body.manualDelta = manualAdjustment;
  }
  if (fe.supplierNotes !== undefined) body.supplierNotes = fe.supplierNotes;
  if (fe.fallbackSupplierId !== undefined) body.fallbackSupplierId = fe.fallbackSupplierId;

  return body;
};

const normaliseProductMutationResponse = (response) => {
  const payload = unwrap(response);
  const candidate = payload?.product || payload;

  if (!candidate || typeof candidate !== 'object') return null;

  const hasProductShape = Boolean(
    candidate._id
    || candidate.id
    || candidate.name !== undefined
    || candidate.nameAr !== undefined
    || candidate.isActive !== undefined
    || candidate.status !== undefined
    || candidate.productStatus !== undefined
  );

  return hasProductShape ? normaliseProduct(candidate) : null;
};

const runProductMutationPlan = async (plan, fallbackMessage = 'Unable to save product.') => {
  let lastError = null;

  for (const [method, endpoint, payload] of plan) {
    try {
      const response = method === 'patch'
        ? await http.patch(endpoint, payload)
        : await http.post(endpoint, payload);
      return normaliseProductMutationResponse(response);
    } catch (error) {
      lastError = error;

      // Definitive client errors — do NOT retry the next endpoint.
      // 400 = validation failed (e.g. bad basePrice, missing field)
      // 409 = conflict (e.g. duplicate product name)
      // 422 = unprocessable entity
      const status = error?.response?.status;
      if (status === 400 || status === 409 || status === 422) {
        throw error;
      }
      // For 404 (endpoint doesn't exist) or 5xx (server error),
      // fall through to the next endpoint in the plan.
    }
  }

  throw lastError || new Error(fallbackMessage);
};

// ─── Determine if current user is admin ──────────────────────────────────────

const isAdmin = () => {
  try {
    return getStoredAuthState()?.user?.role?.toLowerCase() === 'admin';
  } catch { return false; }
};

// ═════════════════════════════════════════════════════════════════════════════
// API Contract — same interface as mockApi
// ═════════════════════════════════════════════════════════════════════════════

const realApi = {

  quota: {
    getMine: async () => {
      const res = await http.get('/me/quota');
      return unwrap(res)?.quota || unwrap(res);
    },
  },

  uploads: {
    orderFieldImage: async (file) => {
      const formData = new FormData();
      formData.append('image', file);
      const res = await http.post('/me/upload/order-field-image', formData);
      const data = unwrap(res);
      return data?.path || data?.url || '';
    },
  },

  whatsapp: {
    getStatus: async () => {
      const res = await http.get('/admin/whatsapp/status');
      return unwrap(res);
    },
    reconnect: async () => {
      const res = await http.post('/admin/whatsapp/reconnect');
      return unwrap(res);
    },
    reset: async () => {
      const res = await http.post('/admin/whatsapp/reset');
      return unwrap(res);
    },
  },

  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: {
    login: async (email, password) => {
      const res = await http.post('/auth/login', { email, password });
      const data = unwrap(res);
      if (data?.requires2FA || data?.requiresTwoFactor) {
        const tempToken = data.tempToken || data.twoFactorToken || data.sessionId || data.requestId || null;
        return {
          requires2FA: true,
          tempToken,
          twoFactorToken: tempToken,
          email: data.email || null,
          user: data.user ? normaliseUser(data.user) : null,
        };
      }
      const user = normaliseUser(data.user);
      const token = data.token || data.accessToken || null;
      const refreshToken = data.refreshToken ?? data.refresh_token ?? null;
      // Persist tokens for subsequent requests
      setStoredAuthTokens(token, refreshToken);
      return { user, token };
    },

    verifyTwoFactor: async ({ tempToken, twoFactorToken, code }) => {
      const res = await http.post('/auth/verify-2fa', {
        tempToken: tempToken || twoFactorToken,
        code,
      });
      const data = unwrap(res);
      const user = normaliseUser(data.user);
      const token = data.token || data.accessToken || null;
      const refreshToken = data.refreshToken ?? data.refresh_token ?? null;
      setStoredAuthTokens(token, refreshToken);
      return { user, token };
    },

    generateTwoFactor: async () => {
      const res = await http.post('/auth/2fa/generate');
      return unwrap(res);
    },

    enableTwoFactor: async ({ code } = {}) => {
      const res = await http.post('/auth/2fa/enable', { code });
      return unwrap(res);
    },

    disableTwoFactor: async ({ token, code, password }) => {
      const body = {};
      const twoFactorCode = token || code;
      if (twoFactorCode) body.code = twoFactorCode;
      if (password) body.password = password;
      const res = await http.post('/auth/2fa/disable', body);
      return unwrap(res);
    },

    loginWithGoogle: async () => {
      // Google OAuth uses redirect flow — open the BE endpoint in the browser.
      // The BE redirects back either with ?token= or ?status=pending.
      // This method is called from FE after capturing the token from the redirect.
      // We keep it compatible by parsing the token from the current URL if present.
      const params = new URLSearchParams(window.location.search);
      const rawCallbackStatus = String(params.get('status') || '').trim().toUpperCase();
      const callbackStatus = normalizeAccountStatus(rawCallbackStatus);
      const completionToken = params.get('completionToken') || params.get('completion_token');
      if (rawCallbackStatus === 'OAUTH_ERROR') {
        throw new Error('Google authentication failed. Please try again.');
      }

      if (callbackStatus === 'profile_completion_required' && completionToken) {
        return {
          user: null,
          token: null,
          completionToken,
          status: 'profile_completion_required',
          callbackStatus: 'PROFILE_COMPLETION_REQUIRED',
          redirectTo: '/auth?status=PROFILE_COMPLETION_REQUIRED',
          canAccessApp: false,
        };
      }

      if (callbackStatus && callbackStatus !== 'approved' && !params.get('token')) {
        return {
          user: null,
          token: null,
          status: callbackStatus,
          redirectTo: getAccountAccessRoute(callbackStatus),
          canAccessApp: false,
        };
      }

      const token = params.get('token');
      if (!token) {
        // Initiate the redirect
        const referralCode = readReferralCodeFromSearch(window.location.search) || readReferralBridge();
        const signupIntent = window.sessionStorage?.getItem('auth:google-signup-intent') === '1';
        const googleParams = new URLSearchParams();
        googleParams.set('intent', signupIntent ? 'signup' : 'login');
        if (referralCode) googleParams.set('referralCode', referralCode);
        window.location.href = `${API_BASE}/auth/google?${googleParams.toString()}`;
        // Return a promise that never resolves (page will redirect)
        return new Promise(() => { });
      }
      // Token captured from callback redirect — fetch profile
      setStoredAuthTokens(token, null);
      const res = await http.get('/users/me');
      const user = normaliseUser(unwrap(res));
      return { user, token, status: 'login_complete', callbackStatus: rawCallbackStatus || 'LOGIN_COMPLETE' };
    },

    completeGoogleProfile: async ({ completionToken, country, currency }) => {
      const res = await http.post('/auth/google/complete-profile', {
        completionToken,
        country,
        currency,
      });
      const data = unwrap(res);
      const user = normaliseUser(data.user);
      const token = data.token || data.accessToken || null;
      const refreshToken = data.refreshToken ?? data.refresh_token ?? null;
      if (token) setStoredAuthTokens(token, refreshToken);
      return { user, token, status: normalizeAccountStatus(data.status || 'LOGIN_COMPLETE') };
    },

    resendVerification: async (email) => {
      const res = await http.post('/auth/resend-verification', {
        email: String(email || '').trim(),
      });
      const data = unwrap(res);
      return {
        success: true,
        message: data?.message || res?.data?.message || 'If that email exists, a verification link has been sent.',
      };
    },

    register: async (userData) => {
      const payload = {
        name: userData.name || userData.username || '',
        email: userData.email,
        password: userData.password,
        currency: userData.currency || 'USD',
        country: userData.country || '',
        phone: userData.phone || '',
      };

      if (userData.username) payload.username = userData.username;
      if (userData.referralCode) payload.referralCode = userData.referralCode;

      const res = await http.post('/auth/register', payload);
      const data = unwrap(res);
      const user = normaliseUser(data.user);
      const token = data.token || data.accessToken || null;
      const refreshToken = data.refreshToken ?? data.refresh_token ?? null;
      if (token) setStoredAuthTokens(token, refreshToken);
      return { user, token };
    },

    getProfile: async (_userId) => {
      // Prefer the self-profile endpoint used elsewhere in this adapter.
      // Some deployments don't expose `/me` but do expose `/users/me`.
      const res = await http.get('/users/me');
      return normaliseUser(unwrap(res));
    },

    refreshSession: async () => {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) return null;

      try {
        const token = await requestTokenRefresh(refreshToken);
        return { token };
      } catch {
        return null;
      }
    },

    logout: async () => {
      // The current backend contract has no logout endpoint. The API uses
      // bearer tokens, so clearing the persisted session is the logout action.
      clearStoredSession();
      return { success: true };
    },
  },

  me: {
    generateApiToken: async () => {
      const res = await http.post('/me/api-token/generate');
      return unwrap(res);
    },

    updateApiSettings: async ({ whitelistIps = [], webhookUrl = '' } = {}) => {
      const payload = {
        whitelistIps: Array.isArray(whitelistIps)
          ? whitelistIps.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        webhookUrl: String(webhookUrl || '').trim(),
      };
      const res = await http.put('/me/api-settings', payload);
      return unwrap(res);
    },
  },

  referrals: {
    dashboard: async ({ limit = 50 } = {}) => {
      const res = await http.get('/me/referrals/dashboard', { params: { limit } });
      const data = unwrap(res);
      const user = getStoredAuthState()?.user || {};
      return normalizeReferralDashboard(data?.dashboard || data, user);
    },

    commissions: async ({ page = 1, limit = 50, status, currency } = {}) => {
      const params = { page, limit };
      if (status) params.status = status;
      if (currency) params.currency = normalizeReferralCurrency(currency);
      const res = await http.get('/me/referral-commissions', { params });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.commissions || data?.data || []);
      return {
        commissions: items.map(normalizeReferralCommission),
        pagination: res.data?.pagination || data?.pagination || null,
      };
    },

    summary: async () => {
      const res = await http.get('/me/referral-commissions/summary');
      return unwrap(res);
    },

    payoutMethods: async () => {
      const res = await http.get('/me/referral-payout-methods');
      const data = unwrap(res);
      const methods = Array.isArray(data) ? data : (data?.methods || []);
      return methods.map(normalizeReferralPayoutMethod).filter((method) => method.enabled);
    },

    currentSubAgentRequest: async () => {
      const res = await http.get('/me/sub-agent-requests/current');
      const data = unwrap(res);
      return {
        ...data,
        request: data?.request ? normalizeSubAgentRequest(data.request) : null,
        currentGroup: data?.currentGroup || null,
      };
    },

    subAgentRequests: async ({ page = 1, limit = 50 } = {}) => {
      const res = await http.get('/me/sub-agent-requests', { params: { page, limit } });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.requests || data?.data || []);
      return {
        requests: items.map(normalizeSubAgentRequest),
        pagination: res.data?.pagination || data?.pagination || null,
      };
    },

    createSubAgentRequest: async ({ message, proofFile }) => {
      const formData = new FormData();
      formData.append('message', String(message || '').trim());
      if (proofFile) formData.append('proofImage', proofFile);
      const res = await http.post('/me/sub-agent-requests', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const data = unwrap(res);
      return normalizeSubAgentRequest(data?.request || data);
    },

    payouts: async ({ page = 1, limit = 50, status, method, currency } = {}) => {
      const params = { page, limit };
      if (status) params.status = status;
      if (method) params.method = method;
      if (currency) params.currency = normalizeReferralCurrency(currency);
      const res = await http.get('/me/referral-payouts', { params });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.payouts || data?.data || []);
      return {
        payouts: items.map(normalizeReferralPayout),
        pagination: res.data?.pagination || data?.pagination || null,
      };
    },

    createPayout: async (payload = {}) => {
      const methodId = String(payload.method || payload.withdrawalMethod || 'wallet').trim().toLowerCase();
      const body = {
        method: methodId === 'wallet' ? 'wallet' : methodId,
        currency: normalizeReferralCurrency(payload.currency),
        amount: String(payload.amount || '').trim(),
        idempotencyKey: payload.idempotencyKey || createClientIdempotencyKey(),
      };
      if (methodId !== 'wallet') {
        body.externalDetails = {
          methodType: methodId,
          accountName: payload.accountName || payload.accountHolder || payload.name || '',
          phoneNumber: payload.phone || payload.walletNumber || payload.accountNumber || '',
          accountNumber: payload.accountNumber || payload.phone || '',
          notes: payload.notes || '',
        };
      }
      const res = await http.post('/me/referral-payouts', body);
      const data = unwrap(res);
      return normalizeReferralPayout(data?.payout || data);
    },

    adminAgents: async ({ page = 1, limit = 100, search = '' } = {}) => {
      const res = await http.get('/admin/referrals/agents', { params: { page, limit, search } });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.agents || data?.data || []);
      return {
        agents: items.map(normalizeAdminReferralAgent),
        pagination: res.data?.pagination || data?.pagination || null,
        defaultCommissionPercent: normalizeReferralNumber(res.data?.defaultCommissionPercent ?? data?.defaultCommissionPercent, 1),
        settingKey: res.data?.settingKey || data?.settingKey || 'referralDefaultCommissionPercent',
      };
    },

    updateAgentCommission: async (userId, percent) => {
      const res = await http.patch(`/admin/referrals/agents/${userId}/commission`, { percent });
      return unwrap(res);
    },

    getDefaultCommissionRate: async () => {
      try {
        const res = await http.get('/admin/settings/referralDefaultCommissionPercent');
        const data = unwrap(res);
        return normalizeReferralNumber(data?.setting?.value ?? data?.value, 1);
      } catch {
        return 1;
      }
    },

    updateDefaultCommissionRate: async (percent) => {
      const normalized = Math.min(50, Math.max(0, normalizeReferralNumber(percent, 1)));
      const res = await http.patch('/admin/settings/referralDefaultCommissionPercent', { value: String(normalized) });
      const data = unwrap(res);
      return normalizeReferralNumber(data?.setting?.value ?? data?.value, normalized);
    },

    adminSubAgentRequests: async ({ page = 1, limit = 100, status, search = '' } = {}) => {
      const params = { page, limit, search };
      if (status) params.status = status;
      const res = await http.get('/admin/sub-agent-requests', { params });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.requests || data?.data || []);
      return {
        requests: items.map(normalizeSubAgentRequest),
        pagination: res.data?.pagination || data?.pagination || null,
      };
    },

    approveSubAgentRequest: async (requestId, { groupId }) => {
      const res = await http.patch(`/admin/sub-agent-requests/${requestId}/approve`, { groupId });
      const data = unwrap(res);
      return normalizeSubAgentRequest(data?.request || data);
    },

    rejectSubAgentRequest: async (requestId, { reason }) => {
      const res = await http.patch(`/admin/sub-agent-requests/${requestId}/reject`, { reason });
      const data = unwrap(res);
      return normalizeSubAgentRequest(data?.request || data);
    },

    adminPayouts: async ({ page = 1, limit = 100, status, method, search = '' } = {}) => {
      const params = { page, limit, search };
      if (status) params.status = status;
      if (method) params.method = method;
      const res = await http.get('/admin/referral-payouts', { params });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.payouts || data?.data || []);
      const detailedItems = await Promise.all(items.map(async (item) => {
        const payoutId = item.id || item._id;
        if (!payoutId) return item;
        try {
          const detailRes = await http.get(`/admin/referral-payouts/${payoutId}`);
          const detailData = unwrap(detailRes);
          return detailData?.payout || detailData || item;
        } catch {
          return item;
        }
      }));
      return {
        payouts: detailedItems.map((item) => normalizeReferralPayout(item, { includeFullExternal: true })),
        pagination: res.data?.pagination || data?.pagination || null,
      };
    },

    rejectPayout: async (payoutId, { reason }) => {
      const res = await http.patch(`/admin/referral-payouts/${payoutId}/reject`, { reason });
      const data = unwrap(res);
      return normalizeReferralPayout(data?.payout || data, { includeFullExternal: true });
    },

    payWalletPayout: async (payoutId) => {
      const res = await http.patch(`/admin/referral-payouts/${payoutId}/pay-wallet`);
      const data = unwrap(res);
      return normalizeReferralPayout(data?.payout || data, { includeFullExternal: true });
    },

    markManualPayoutPaid: async (payoutId, { receiptFile, reference = '' } = {}) => {
      const formData = new FormData();
      if (reference) formData.append('externalTransactionReference', reference);
      if (receiptFile) formData.append('receiptImage', receiptFile);
      const res = await http.patch(`/admin/referral-payouts/${payoutId}/mark-paid`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const data = unwrap(res);
      return normalizeReferralPayout(data?.payout || data, { includeFullExternal: true });
    },

    adminPayoutMethods: async () => {
      try {
        const res = await http.get('/admin/settings/referralPayoutMethods');
        const data = unwrap(res);
        const methods = data?.setting?.value || data?.value || [];
        return (Array.isArray(methods) ? methods : []).map(normalizeReferralPayoutMethod);
      } catch {
        return [];
      }
    },

    updateAdminPayoutMethods: async (methods = []) => {
      const normalized = methods.map(normalizeReferralPayoutMethod);
      const res = await http.patch('/admin/settings/referralPayoutMethods', { value: normalized });
      const data = unwrap(res);
      const fresh = data?.setting?.value || data?.value || normalized;
      return (Array.isArray(fresh) ? fresh : normalized).map(normalizeReferralPayoutMethod);
    },
  },

  notifications: {
    unreadCount: async () => {
      // Notifications are maintained optimistically in the client. There are
      // no notification endpoints in the deployed API contract.
      return null;
    },

    list: async () => {
      return null;
    },

    markAsRead: async (id) => {
      const normalizedId = String(id || '').trim();
      if (!normalizedId) return { success: true };
      return { success: true };
    },

    markAllAsRead: async () => {
      return { success: true };
    },

    send: async (payload = {}) => {
      const res = await http.post('/admin/notifications/send', payload);
      return unwrap(res);
    },
  },

  // ── Products ─────────────────────────────────────────────────────────────
  products: {
    /**
     * GET /admin/products (admin) or GET /products (customer)
     *
     * Both return products array in `data`.
     */
    list: async () => {
      // Use the single documented endpoint for the current role. Speculative
      // fallbacks generated visible 403/404 errors even after a request had
      // already succeeded.
      const endpoint = isAdmin() ? '/admin/products' : '/products';
      const res = await http.get(endpoint, {
        params: {
          // Stopped products remain part of the storefront and are rendered as
          // unavailable. The timestamp prevents browser/proxy response reuse.
          includeUnavailable: true,
          includeInactive: true,
          includeDisabled: true,
          includeStopped: true,
          includePaused: true,
          status: 'all',
          _fresh: Date.now(),
        },
      });
      const data = unwrap(res);
      const products = Array.isArray(data) ? data : (data?.products || data?.items || []);
      return (Array.isArray(products) ? products : []).map(normaliseProduct).filter(Boolean);
    },

    /**
     * GET /products/:id — sendSuccess(res, product).
     * Product is placed directly in data (no wrapping object).
     */
    get: async (id) => {
      const requestPlan = isAdmin()
        ? [`/products/${id}`]
        : [
          `/products/${id}`,
          `/me/products/${id}`,
        ];

      let fallback = null;

      for (const endpoint of requestPlan) {
        try {
          const res = await http.get(endpoint);
          const data = unwrap(res);
          const normalised = normaliseProduct(data?.product || data);
          if (!fallback) fallback = normalised;

          if (productHasReadableCategory(normalised)) {
            return normalised;
          }
        } catch {
          // Silent fallback across endpoints.
        }
      }

      return fallback;
    },

    verifyField: async (id, fieldValue) => {
      const res = await http.post(`/products/${id}/verify-field`, { fieldValue });
      return unwrap(res);
    },

    /**
     * POST /admin/products — manual product creation.
     *
     * Maps FE field names back to BE model field names.
     * BE accepts: { name, description, basePrice, minQty, maxQty, category,
     *               image, displayOrder, isActive, executionType, orderFields, providerMapping }
     */
    create: async (productData) => {
      const body = productToBE(productData);
      const hasProvider = Boolean(body.providerProductId);
      const requestPlan = hasProvider
        ? [
          ['post', '/admin/products/from-provider', body],
          ['post', '/providers/products/publish', body],
          ['post', '/products/publish', body],
          ['post', '/admin/products', body],
          ['post', '/products', body],
        ]
        : [
          ['post', '/admin/products', body],
          ['post', '/products', body],
        ];

      return runProductMutationPlan(requestPlan, 'Unable to create product.');
    },

    /**
     * PATCH /admin/products/:id — update product.
     *
     * Maps FE field names back to BE-allowed update fields.
     */
    update: async (id, updates) => {
      const body = productToBE(updates);
      const requestPlan = [
        ['patch', `/admin/products/${id}`, body],
        ['patch', `/products/${id}`, body],
      ];

      if (String(body.providerProductId || body.externalProductId || '').trim()) {
        requestPlan.splice(1, 0, ['patch', `/providers/products/${id}`, body]);
      }

      return runProductMutationPlan(requestPlan, 'Unable to update product.');
    },

    /**
     * PATCH /products/:id/toggle-status — activate or deactivate product.
     */
    toggleStatus: async (id) => {
      return runProductMutationPlan([
        ['patch', `/products/${id}/toggle-status`],
        ['patch', `/admin/products/${id}/toggle`],
        ['patch', `/products/${id}/toggle`],
      ], 'Unable to toggle product status.');
    },

    /**
     * DELETE /admin/products/:id — soft-delete (sets deletedAt + isActive=false).
     */
    delete: async (id) => {
      await http.delete(`/admin/products/${id}`);
      return { success: true };
    },

    /**
     * GET /admin/providers — lightweight list for provider picker UI.
     */
    listProviders: async () => {
      const res = await http.get('/admin/providers');
      const data = unwrap(res);
      const providers = Array.isArray(data) ? data : (data?.providers || []);
      return providers.map((p) => ({
        id: p._id || p.id,
        name: p.name || p.supplierName || '',
      }));
    },

    /**
     * GET /admin/provider-products/:providerId — raw provider products.
     */
    listProviderProducts: async (providerId, { limit = 2000 } = {}) => {
      const res = await http.get(`/admin/provider-products/${providerId}`, {
        params: { limit },
      });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.providerProducts || []);
      return items.map((pp) => ({
        ...pp,
        id: pp._id || pp.id,
        _id: undefined,
        // Human-readable name for dropdowns — fallback chain
        name: pp.translatedName || pp.rawName || pp.rawPayload?.product_name || pp.rawPayload?.product_name_translated || pp.externalProductId,
        // Preserve provider price exactly as returned whenever possible.
        rawPrice: getProviderCatalogPriceValue(pp),
        priceCoins: getProviderCatalogPriceValue(pp),
        minQty: getProviderCatalogMinQtyValue(pp),
        minimumOrderQty: getProviderCatalogMinQtyValue(pp),
        maxQty: getProviderCatalogMaxQtyValue(pp),
        maximumOrderQty: getProviderCatalogMaxQtyValue(pp),
      }));
    },

    /**
     * GET /admin/provider-products/item/:providerProductId/price
     * Fetches stored price data for a specific provider product.
     */
    getSyncedPrice: async (providerId, providerProductId) => {
      try {
        const res = await http.get(`/admin/provider-products/item/${providerProductId}/price`);
        const data = unwrap(res);
        const rawPrice = getProviderCatalogPriceValue(data || {});
        const minQty = getProviderCatalogMinQtyValue(data || {});
        const maxQty = getProviderCatalogMaxQtyValue(data || {});
        return {
          basePriceCoins: rawPrice || 0,
          rawPrice: rawPrice || 0,
          minQty,
          minimumOrderQty: minQty,
          maxQty,
          maximumOrderQty: maxQty,
          found: data?.found ?? false,
          rawName: data?.rawName || '',
          provider: data?.provider || '',
        };
      } catch (err) {
        devLogger.warnUnlessBenign('[realApi] getSyncedPrice failed:', err);
        return { basePriceCoins: 0, rawPrice: 0, minQty: null, maxQty: null, found: false };
      }
    },
  },

  // ── Categories ───────────────────────────────────────────────────────────
  categories: {
    /**
     * GET /admin/categories → sendSuccess(res, { categories }, ...)
     */
    list: async () => {
      const requestPlan = isAdmin()
        ? ['/admin/categories']
        : [
          // Not documented in API_DOCS, but try if the backend exposes it.
          '/categories',
          '/public/categories',
          '/storefront/categories',
          '/me/categories',
          // Some deployments allow reading categories from the admin route.
          // Keep this as a late fallback (and rely on server auth).
          '/admin/categories',
        ];

      for (const endpoint of requestPlan) {
        try {
          const res = await http.get(endpoint);
          const data = unwrap(res);
          const items = Array.isArray(data) ? data : (data?.categories || []);
          return items.map(normaliseCategory);
        } catch {
          // Silent fallback across endpoints.
        }
      }
      return [];
    },

    /**
     * GET /admin/categories/:id → sendSuccess(res, { category }, ...)
     */
    get: async (id) => {
      if (!id) return null;

      const requestPlan = isAdmin()
        ? [`/admin/categories/${id}`]
        : [
          `/categories/${id}`,
          `/public/categories/${id}`,
          `/storefront/categories/${id}`,
          `/me/categories/${id}`,
          // Late fallback: some deployments allow read access here.
          `/admin/categories/${id}`,
        ];

      for (const endpoint of requestPlan) {
        try {
          const res = await http.get(endpoint);
          return normaliseCategory(unwrap(res)?.category || unwrap(res));
        } catch {
          // Silent fallback across endpoints.
        }
      }

      return null;
    },

    /**
     * POST /admin/categories → sendCreated(res, { category }, ...)
     * BE Joi: { name (req), nameAr, image, sortOrder, isActive }
     */
    create: async (categoryData, _actorContext) => {
      const body = {
        name: categoryData.name,
        nameAr: categoryData.nameAr || null,
        image: categoryData.image || null,
        sortOrder: categoryData.sortOrder ?? 0,
        isActive: categoryData.isActive !== false,
        parentCategory: categoryData.parentCategory || null,
      };
      const res = await http.post('/admin/categories', body);
      return normaliseCategory(unwrap(res)?.category || unwrap(res));
    },

    /**
     * PATCH /admin/categories/:id → sendSuccess(res, { category }, ...)
     */
    update: async (id, updates, _actorContext) => {
      const res = await http.patch(`/admin/categories/${id}`, updates);
      return normaliseCategory(unwrap(res)?.category || unwrap(res));
    },

    /**
     * PATCH /admin/categories/:id/toggle → toggle isActive
     */
    toggle: async (id, _actorContext) => {
      const res = await http.patch(`/admin/categories/${id}/toggle`);
      return normaliseCategory(unwrap(res)?.category || unwrap(res));
    },

    /**
     * DELETE /admin/categories/:id → hard delete + cascade product cleanup
     */
    delete: async (id, _actorContext) => {
      const res = await http.delete(`/admin/categories/${id}`);
      return unwrap(res);
    },
  },

  // ── Suppliers (BE calls them "providers") ────────────────────────────────
  suppliers: {
    /**
     * GET /admin/providers → sendSuccess(res, { providers }, ...)
     */
    list: async () => {
      const res = await http.get('/admin/providers');
      const data = unwrap(res);
      const providers = Array.isArray(data) ? data : (data?.providers || []);
      return providers.map(normaliseProvider);
    },

    /**
     * GET /admin/providers/:id → sendSuccess(res, { provider }, ...)
     */
    get: async (id) => {
      const res = await http.get(`/admin/providers/${id}`);
      return normaliseProvider(unwrap(res)?.provider || unwrap(res));
    },

    /**
     * POST /admin/providers → sendCreated(res, { provider }, ...)
     *
     * Uses providerToBE to translate FE supplier fields to BE schema.
     * BE Joi: { name (req), baseUrl (req), slug, apiToken, isActive, syncInterval, supportedFeatures }
     */
    create: async (payload, _actorContext) => {
      const body = providerToBE(payload);
      const res = await http.post('/admin/providers', body);
      return normaliseProvider(unwrap(res)?.provider || unwrap(res));
    },

    /**
     * PATCH /admin/providers/:id → sendSuccess(res, { provider }, ...)
     *
     * Uses providerToBE to translate FE supplier fields to BE schema.
     * BE Joi: same fields as create, all optional, .min(1)
     */
    update: async (id, payload, _actorContext) => {
      const body = providerToBE(payload);
      const res = await http.patch(`/admin/providers/${id}`, body);
      return normaliseProvider(unwrap(res)?.provider || unwrap(res));
    },

    /**
     * PATCH /admin/providers/:id/toggle → toggles isActive
     */
    deactivate: async (id, _actorContext) => {
      const res = await http.patch(`/admin/providers/${id}/toggle`);
      return normaliseProvider(unwrap(res)?.provider || unwrap(res));
    },

    /**
     * POST /admin/providers/:id/test-connection
     * Pings the provider's API to verify credentials and connectivity.
     * Returns latency, success status, and test timestamp.
     */
    testConnection: async (id, _actorContext) => {
      try {
        const res = await http.post(`/admin/providers/${id}/test-connection`);
        const data = unwrap(res);
        return {
          lastConnectionTestAt: data?.testedAt || new Date().toISOString(),
          lastConnectionTestStatus: data?.success ? 'success' : 'failed',
          lastConnectionTestMessage: data?.message || 'Unknown',
          latencyMs: data?.latencyMs ?? null,
        };
      } catch (err) {
        return {
          lastConnectionTestAt: new Date().toISOString(),
          lastConnectionTestStatus: 'error',
          lastConnectionTestMessage: err?.response?.data?.message || err.message || 'Connection test failed',
          latencyMs: null,
        };
      }
    },

    /**
     * POST /admin/catalog/sync/:providerId → triggers product sync from provider
     * Extended timeout (5 min) because sync can insert thousands of records.
     */
    syncProducts: async (id, _actorContext) => {
      const res = await http.post(`/admin/catalog/sync/${id}`, {}, { timeout: 300_000 });
      const data = unwrap(res);
      return Array.isArray(data) ? data : (data?.products || data?.synced || []);
    },

    /**
     * GET /admin/providers/:id/balance → live provider balance
     */
    getBalance: async (id) => {
      const res = await http.get(`/admin/providers/${id}/balance`);
      return unwrap(res);
    },

    /**
     * GET /admin/providers/:id/products → live provider product list
     * Extended timeout (5 min) because fetching from external APIs can be slow.
     */
    getLiveProducts: async (id) => {
      const res = await http.get(`/admin/providers/${id}/products`, { timeout: 300_000 });
      const data = unwrap(res);
      return Array.isArray(data) ? data : (data?.products || []);
    },

    /**
     * GET /admin/providers/:id/check-order?orderId=123 → check order status via provider adapter
     */
    checkOrder: async (id, orderId) => {
      const res = await http.get(`/admin/providers/${id}/check-order`, { params: { orderId } });
      return unwrap(res);
    },

    /**
     * DELETE /admin/providers/:id → safe delete (detaches linked products first)
     */
    delete: async (id, _actorContext) => {
      const res = await http.delete(`/admin/providers/${id}`);
      return normaliseProvider(unwrap(res)?.provider || unwrap(res));
    },
  },

  // ── Users (Admin) ────────────────────────────────────────────────────────
  users: {
    setQuota: async (userId, quantityLimit, reason = '') => {
      const res = await http.patch(`/admin/users/${userId}/quota`, { quantityLimit, ...(reason ? { reason } : {}) });
      return unwrap(res)?.quota || unwrap(res);
    },

    resetQuota: async (userId, reason = '') => {
      const res = await http.post(`/admin/users/${userId}/quota/reset`, reason ? { reason } : {});
      return unwrap(res)?.quota || unwrap(res);
    },
    /**
     * GET /admin/users → sendPaginated(res, users[], pagination)
     * unwrap() returns the users array directly from paginated envelope.
     * Supports server-side pagination + sorting params.
     */
    list: async ({
      page = 1,
      limit = 20,
      sortBy = 'walletBalance',
      sortOrder = 'desc',
      search = '',
      role,
      status,
      email,
    } = {}) => {
      const query = new URLSearchParams();
      query.set('page', String(page));
      query.set('limit', String(limit));
      // Sorting is performed in the store. Only send parameters documented by
      // the API because strict deployments reject unknown query fields.
      void sortBy;
      void sortOrder;
      if (String(search || '').trim()) query.set('search', String(search).trim());
      if (role) query.set('role', String(role).toUpperCase());
      if (status) query.set('status', String(status).toUpperCase());
      if (email) query.set('email', String(email).trim());
      const res = await http.get(`/admin/users?${query}`);
      const body = res.data || {};
      const data = body.data ?? body;
      // Support the documented array envelope and common paginated variants.
      const users = Array.isArray(data)
        ? data
        : (
          data?.users
          || data?.items
          || data?.results
          || data?.docs
          || body?.users
          || body?.items
          || body?.results
          || body?.docs
          || []
        );
      const pagination = body.pagination
        || data?.pagination
        || data?.meta
        || body?.meta
        || null;
      return { users: normaliseUsers(users), pagination };
    },

    listDeleted: async () => {
      const endpointCandidates = [
        ['/admin/users/deleted', {}],
        ['/admin/users', { deleted: true }],
        ['/admin/users', { status: 'deleted' }],
      ];

      for (const [endpoint, params] of endpointCandidates) {
        try {
          const res = await http.get(endpoint, { params });
          const data = unwrap(res);
          const users = Array.isArray(data) ? data : (data?.users || []);
          const deleted = normaliseUsers(users).filter((entry) => (
            Boolean(entry?.deletedAt)
            || Boolean(entry?.isDeleted)
            || String(entry?.status || '').trim().toLowerCase() === 'deleted'
          ));
          // Only accept if the dedicated endpoint returned results or if it's
          // the dedicated endpoint (which returns [] legitimately when empty).
          if (deleted.length > 0 || endpoint.endsWith('/deleted')) {
            return deleted;
          }
          // Fallback endpoints returned 200 but no deleted entries — try next.
        } catch (_error) {
          // Try next candidate endpoint/params.
        }
      }

      return [];
    },

    /**
     * GET /admin/users/:id → fetch a single user profile by ID.
     */
    getById: async (userId) => {
      const normalizedUserId = String(userId || '').trim();
      if (!normalizedUserId) return null;

      const res = await http.get(`/admin/users/${normalizedUserId}`);
      const data = unwrap(res);
      return normaliseUser(data?.user || data);
    },

    /**
     * Map FE status strings to BE approve / reject / generic-update endpoints.
     *
     * BE response shape (single user): { success, data: { user } }
     */
    updateStatus: async (userId, status, _actorContext) => {
      const normalised = (status || '').toLowerCase();
      if (normalised === 'active' || normalised === 'approved') {
        const res = await http.patch(`/admin/users/${userId}/approve`);
        return normaliseUser(unwrap(res)?.user || unwrap(res));
      }
      if (normalised === 'denied' || normalised === 'rejected') {
        const res = await http.patch(`/admin/users/${userId}/reject`);
        return normaliseUser(unwrap(res)?.user || unwrap(res));
      }
      // Generic update for other status values (BE Joi accepts status: PENDING|ACTIVE|REJECTED)
      const res = await http.patch(`/admin/users/${userId}`, { status: status.toUpperCase() });
      return normaliseUser(unwrap(res)?.user || unwrap(res));
    },

    /**
     * Wallet operations: POST /admin/wallets/:userId/add | /deduct
     *
     * API docs show { amount, description }. Some BE builds still accept { reason }.
     * BE response: { success, data: { transaction } } — NOT a user object.
     *
     * Since the BE returns a transaction (not the updated user), we just return the
     * transaction and let useAdminStore handle the optimistic local state update.
     */
    addCoins: async (userId, amount, _actorContext) => {
      if (amount >= 0) {
        const res = await http.post(`/admin/wallets/${userId}/add`, {
          amount: Math.abs(amount),
          description: 'Admin balance top-up',
          reason: 'Admin balance top-up',
        });
        return unwrap(res)?.transaction || unwrap(res);
      }
      const res = await http.post(`/admin/wallets/${userId}/deduct`, {
        amount: Math.abs(amount),
        description: 'Admin balance deduction',
        reason: 'Admin balance deduction',
      });
      return unwrap(res)?.transaction || unwrap(res);
    },

    setBalance: async (userId, balance, _actorContext) => {
      const normalizedUserId = String(userId || '').trim();
      if (!normalizedUserId) return null;

      const normalizedBalance = toFiniteNumber(balance, 0);

      // Try the dedicated set-balance endpoint first
      const requestPlan = [
        { method: 'put', url: `/admin/wallets/${normalizedUserId}/set`, payload: { targetBalance: normalizedBalance, description: 'Admin set balance' } },
        { method: 'patch', url: `/admin/wallets/${normalizedUserId}`, payload: { walletBalance: normalizedBalance } },
        { method: 'patch', url: `/admin/users/${normalizedUserId}`, payload: { walletBalance: normalizedBalance } },
      ];

      let lastError = null;
      for (const { method, url, payload } of requestPlan) {
        try {
          const res = await http[method](url, payload);
          const data = unwrap(res);
          return data?.user ? normaliseUser(data.user) : normaliseUser(data);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error('Unable to set wallet balance.');
    },

    /**
     * Update user's group.
     *
     * BE Joi accepts: { groupId: ObjectId (24-hex) }
     * FE may pass a group ID string, a group object, or empty/null.
     * We extract the raw ObjectId and only send it if it's a valid 24-hex string.
     */
    updateGroup: async (userId, group, _actorContext) => {
      // Extract ID if group is an object { id, _id, name }
      let groupId = group;
      if (typeof group === 'object' && group !== null) {
        groupId = group.id || group._id || group.groupId || '';
      }
      groupId = String(groupId || '').trim();

      // If empty or not a valid ObjectId, send null to unassign
      const payload = groupId.length === 24 ? { groupId } : { groupId: null };
      const res = await http.patch(`/admin/users/${userId}`, payload);
      return normaliseUser(unwrap(res)?.user || unwrap(res));
    },

    /**
     * PATCH /admin/users/:id/role → update user's role.
     * BE Joi: { role: 'ADMIN' | 'CUSTOMER' }
     */
    updateRole: async (userId, role, _actorContext) => {
      const res = await http.patch(`/admin/users/${userId}/role`, { role: (role || '').toUpperCase() });
      return normaliseUser(unwrap(res)?.user || unwrap(res));
    },

    updatePermissions: async (userId, permissions = [], _actorContext) => {
      const normalizedUserId = String(userId || '').trim();
      const payload = {
        permissions: Array.isArray(permissions)
          ? permissions.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
      };

      const endpointPlan = [
        { method: 'patch', url: `/admin/users/${normalizedUserId}/permissions`, payload },
        { method: 'patch', url: `/admin/users/${normalizedUserId}`, payload },
      ];

      let lastError = null;
      for (const request of endpointPlan) {
        try {
          const res = await http[request.method](request.url, request.payload);
          const data = unwrap(res);
          return normaliseUser(data?.user || data);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error('Unable to update permissions.');
    },

    delete: async (userId, _actorContext) => {
      await http.delete(`/admin/users/${userId}`);
      return { success: true };
    },

    restore: async (userId, _actorContext) => {
      const endpointCandidates = [
        [`/admin/users/${userId}/restore`, {}],
        [`/admin/users/${userId}/approve`, null],
        [`/admin/users/${userId}`, { status: 'ACTIVE', deletedAt: null }],
      ];

      let lastError = null;

      for (const [endpoint, payload] of endpointCandidates) {
        try {
          const res = payload === null
            ? await http.patch(endpoint)
            : await http.patch(endpoint, payload);
          return normaliseUser(unwrap(res)?.user || unwrap(res));
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error('Unable to restore deleted user.');
    },

    /**
     * Update user's avatar via file upload.
     * Self-service: PATCH /users/me/avatar
     * Admin:        PATCH /admin/users/:id/avatar
     * Sends multipart/form-data with 'avatar' file field.
     * Pass null/undefined avatarFile to remove avatar.
     */
    updateAvatar: async (userId, avatarFile, actorContext) => {
      const isSelf = actorContext?.id === userId;
      const url = isSelf ? '/users/me/avatar' : `/admin/users/${userId}/avatar`;

      if (avatarFile instanceof File || avatarFile instanceof Blob) {
        const formData = new FormData();
        formData.append('avatar', avatarFile);
        const res = await http.patch(url, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        return normaliseUser(unwrap(res)?.user || unwrap(res));
      }

      // No file = remove avatar
      const res = await http.patch(url, {});
      return normaliseUser(unwrap(res)?.user || unwrap(res));
    },

    /**
     * Update user profile fields.
     * Self-service: PATCH /users/me
     * Admin:        PATCH /admin/users/:id
     */
    updateProfile: async (userId, updates, actorContext) => {
      const body = {};
      if (updates.name !== undefined) body.name = updates.name;
      if (updates.email !== undefined) body.email = updates.email;
      if (updates.phone !== undefined) body.phone = updates.phone;
      if (updates.username !== undefined) body.username = updates.username;
      if (updates.password !== undefined) body.password = updates.password;
      if (updates.country !== undefined) body.country = updates.country;
      if (updates.currency !== undefined) body.currency = updates.currency;
      if (updates.referralCode !== undefined) body.referralCode = updates.referralCode;
      // Admin-only fields
      if (updates.groupId !== undefined) body.groupId = updates.groupId;
      if (updates.verified !== undefined) body.verified = updates.verified;
      if (updates.walletBalance !== undefined) body.walletBalance = Number(updates.walletBalance);
      if (updates.coins !== undefined) body.coins = Number(updates.coins);
      if (updates.balance !== undefined) body.balance = Number(updates.balance);
      if (updates.currentBalance !== undefined) body.currentBalance = Number(updates.currentBalance);
      if (updates.isApiEnabled !== undefined) body.isApiEnabled = Boolean(updates.isApiEnabled);

      const isSelf = actorContext?.id === userId;
      const url = isSelf ? '/users/me' : `/admin/users/${userId}`;
      const res = await http.patch(url, body);
      return normaliseUser(unwrap(res)?.user || unwrap(res));
    },

    updateCreditLimit: async (userId, creditLimit, _actorContext) => {
      const normalizedUserId = String(userId || '').trim();
      if (!normalizedUserId) return null;

      const normalizedCreditLimit = Math.max(0, toFiniteNumber(creditLimit, 0));
      const requestPlan = [
        [`/admin/users/${normalizedUserId}/credit-limit`, { creditLimit: normalizedCreditLimit }],
        [`/admin/users/${normalizedUserId}/credit-limit`, { limit: normalizedCreditLimit }],
        [`/admin/users/${normalizedUserId}`, { creditLimit: normalizedCreditLimit }],
        [`/admin/users/${normalizedUserId}`, { maxDebt: normalizedCreditLimit }],
      ];

      let lastError = null;
      for (const [endpoint, payload] of requestPlan) {
        try {
          const res = await http.patch(endpoint, payload);
          return normaliseUser(unwrap(res)?.user || unwrap(res));
        } catch (error) {
          // Business rule errors (4xx with code) — do NOT retry on next endpoint
          const respCode = error?.response?.data?.code;
          if (respCode && error?.response?.status >= 400 && error?.response?.status < 500) {
            const bizError = new Error(error.response.data.message || String.rawOrder.creation.failed);
            bizError.code = respCode;
            bizError.statusCode = error.response.status;
            throw bizError;
          }
          lastError = error;
        }
      }

      throw lastError || new Error('Unable to update credit limit.');
    },

    /**
     * PATCH /admin/users/:id/currency → update user's wallet currency.
     * BE Joi: { currency: 'USD' | 'SAR' | ... (3-letter ISO 4217) }
     */
    updateCurrency: async (userId, currencyCode, _actorContext) => {
      const res = await http.patch(`/admin/users/${userId}/currency`, { currency: (currencyCode || '').toUpperCase() });
      return normaliseUser(unwrap(res)?.user || unwrap(res));
    },

    /**
     * POST /admin/users/:id/reset-password → reset user's password.
     * BE Joi: { password: string (min 8 chars) }
     *
     * Generates a secure temporary password, sends to BE which bcrypt-hashes it.
     * Returns the user + temporary password for the admin to communicate to the user.
     */
    resetPassword: async (userId, _actorContext, nextPassword = '') => {
      const explicitPassword = String(nextPassword || '').trim();
      const selectedPassword = explicitPassword || Array.from(
        { length: 12 },
        () => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 54)]
      ).join('');

      const res = await http.post(`/admin/users/${userId}/reset-password`, { password: selectedPassword });
      const user = normaliseUser(unwrap(res)?.user || unwrap(res));
      return { user, temporaryPassword: selectedPassword };
    },
  },

  // ── Admin Wallets ─────────────────────────────────────────────────────────
  adminWallets: {
    /**
     * GET /admin/wallets → list all wallets for admin use.
     */
    list: async () => {
      const res = await http.get('/admin/wallets');
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.wallets || data?.items || data?.data || []);
      return normaliseWalletSummaries(items);
    },

    /**
     * GET /admin/wallets/:userId → fetch a single wallet summary.
     *
     * Backend now returns { user: {...userFields}, recentTransactions: [...populated] }.
     * We flatten the user sub-object to the top level so normaliseWalletSummary
     * correctly reads walletBalance, currency, name, email, etc., while preserving
     * the populated recentTransactions array.
     */
    getByUserId: async (userId) => {
      const normalizedUserId = String(userId || '').trim();
      if (!normalizedUserId) return null;

      const res = await http.get(`/admin/wallets/${normalizedUserId}`);
      const data = unwrap(res);
      const raw = data?.wallet || data;

      // Flatten { user: {...}, recentTransactions: [...] } → top-level wallet shape
      const flatWallet = (raw?.user && typeof raw.user === 'object')
        ? {
            ...raw.user,                          // walletBalance, currency, name, email, etc.
            user: raw.user,                       // keep sub-object for normaliser
            recentTransactions: Array.isArray(raw.recentTransactions) ? raw.recentTransactions : [],
            userId: raw.user?._id || raw.user?.id || normalizedUserId,
          }
        : raw;

      return normaliseWalletSummary(flatWallet, normalizedUserId);
    },

    /**
     * GET /admin/wallets/:userId/transactions
     * GET /wallet/users/:userId/transactions (fallback)
     */
    getTransactionsByUserId: async (userId, { page = 1, limit = 50, from, to } = {}) => {
      const normalizedUserId = String(userId || '').trim();
      if (!normalizedUserId) return [];

      const endpoints = [
        `/admin/wallets/${normalizedUserId}/transactions`,
        `/wallet/users/${normalizedUserId}/transactions`,
      ];
      const params = {
        page,
        limit,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      };

      let lastError = null;

      for (const endpoint of endpoints) {
        try {
          const res = await http.get(endpoint, { params });
          const data = unwrap(res);
          const items = Array.isArray(data) ? data : (data?.transactions || data?.items || data?.data || []);
          return items
            .map((entry) => normaliseWalletTransaction(entry, normalizedUserId))
            .filter(Boolean);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error('Unable to load wallet transactions.');
    },
  },

  // ── Groups ───────────────────────────────────────────────────────────────
  groups: {
    list: async () => {
      if (!isAdmin()) {
        try {
          const res = await http.get('/groups');
          const data = unwrap(res);
          const groups = Array.isArray(data) ? data : (data?.groups || []);
          return groups.map(normaliseGroup);
        } catch (_error) {
          return [];
        }
      }

      const res = await http.get('/admin/groups');
      const data = unwrap(res);
      const groups = Array.isArray(data) ? data : (data?.groups || []);
      return groups.map(normaliseGroup);
    },

    create: async (groupData) => {
      // Reverse-map: FE sends { name, discount }, BE Joi expects { name, percentage }
      const body = {
        name: groupData.name,
        percentage: groupData.discount ?? groupData.percentage ?? 0,
        isActive: groupData.isActive !== false,
        billingMode: groupData.billingMode || 'standard',
      };
      const res = await http.post('/admin/groups', body);
      return normaliseGroup(unwrap(res)?.group || unwrap(res));
    },

    update: async (id, updates) => {
      // Reverse-map: FE sends { name, discount }, BE Joi expects { name, percentage }
      const body = {};
      if (updates.name !== undefined) body.name = updates.name;
      if (updates.discount !== undefined || updates.percentage !== undefined) {
        body.percentage = updates.discount ?? updates.percentage;
      }
      if (updates.isActive !== undefined) body.isActive = updates.isActive;
      if (updates.billingMode !== undefined) body.billingMode = updates.billingMode;
      const res = await http.patch(`/admin/groups/${id}`, body);
      return normaliseGroup(unwrap(res)?.group || unwrap(res));
    },

    delete: async (id) => {
      await http.delete(`/admin/groups/${id}`);
      return { success: true };
    },
  },

  // ── Admin Dashboard Stats ────────────────────────────────────────────────
  dashboard: {
    /**
     * GET /admin/stats — aggregated dashboard statistics.
     * Returns: { orders, financials, users, products }
     */
    getDashboardStats: async ({ startDate, endDate } = {}) => {
      const params = {
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
      };
      const res = await http.get('/admin/dashboard/stats', { params });
      return unwrap(res);
    },
  },

  // ── Public Catalog (no auth required) ─────────────────────────────────
  publicCatalog: {
    /**
     * GET /api/public/catalog — no auth token needed.
     * Returns { categories, products } with ALL pricing fields stripped.
     */
    fetch: async () => {
      const includeUnavailableParams = {
        includeUnavailable: true,
        includeInactive: true,
        showUnavailable: true,
        includeDisabled: true,
        includeStopped: true,
        includePaused: true,
        status: 'all',
        _fresh: Date.now(),
      };
      const catalogRequests = [
        ['/public/catalog', { params: includeUnavailableParams }],
        ['/public/catalog?includeUnavailable=true&includeInactive=true&status=all', { params: { _fresh: includeUnavailableParams._fresh } }],
        ['/storefront/catalog', { params: includeUnavailableParams }],
        ['/catalog', { params: includeUnavailableParams }],
      ];
      const productRequests = [
        ['/public/products', { params: includeUnavailableParams }],
        ['/storefront/products', { params: includeUnavailableParams }],
        ['/products', { params: includeUnavailableParams }],
      ];
      const categoryRequests = [
        '/public/categories',
        '/storefront/categories',
        '/categories',
      ];
      const categoryMap = new Map();
      const productMap = new Map();
      let hasProductsPayload = false;
      let hasCategoriesPayload = false;

      const readPayload = (res) => {
        const body = res?.data || {};
        return body?.data !== undefined ? body.data : body;
      };

      const addCategories = (items) => {
        (Array.isArray(items) ? items : []).map(normaliseCategory).filter(Boolean).forEach((category) => {
          const key = String(category.id || category._id || category.name || category.nameAr || '').trim();
          if (key) categoryMap.set(key, { ...(categoryMap.get(key) || {}), ...category });
        });
      };

      const addProducts = (items) => {
        (Array.isArray(items) ? items : []).map(normaliseProduct).filter(Boolean).forEach((product) => {
          const key = String(product.id || product._id || product.slug || product.name || product.nameAr || '').trim();
          if (key) productMap.set(key, { ...(productMap.get(key) || {}), ...product });
        });
      };

      for (const entry of catalogRequests) {
        try {
          const [endpoint, config] = Array.isArray(entry) ? entry : [entry, undefined];
          const res = await http.get(endpoint, config);
          const data = readPayload(res);
          const categoryItems = Array.isArray(data?.categories) ? data.categories : null;
          const productItems = Array.isArray(data) ? data : (Array.isArray(data?.products) ? data.products : null);

          if (categoryItems) {
            addCategories(categoryItems);
            hasCategoriesPayload = true;
          }
          if (productItems) {
            addProducts(productItems);
            hasProductsPayload = true;
          }

          // The first recognized catalog response is canonical. Do not merge
          // later endpoints that may carry an older availability snapshot.
          if (categoryItems || productItems) break;
        } catch {
          // Try the next public catalog shape.
        }
      }

      if (!hasProductsPayload) {
        for (const entry of productRequests) {
          try {
            const [endpoint, config] = Array.isArray(entry) ? entry : [entry, undefined];
            const res = await http.get(endpoint, config);
            const data = readPayload(res);
            const productItems = Array.isArray(data)
              ? data
              : (Array.isArray(data?.products) ? data.products : (Array.isArray(data?.items) ? data.items : null));
            if (!productItems) continue;
            addProducts(productItems);
            hasProductsPayload = true;
            break;
          } catch {
            // Try the next public products endpoint.
          }
        }
      }

      if (!hasCategoriesPayload) {
        for (const endpoint of categoryRequests) {
          try {
            const res = await http.get(endpoint, { params: { _fresh: includeUnavailableParams._fresh } });
            const data = readPayload(res);
            const categoryItems = Array.isArray(data)
              ? data
              : (Array.isArray(data?.categories) ? data.categories : (Array.isArray(data?.items) ? data.items : null));
            if (!categoryItems) continue;
            addCategories(categoryItems);
            hasCategoriesPayload = true;
            break;
          } catch {
            // Try the next public categories endpoint.
          }
        }
      }

      if (!hasProductsPayload && !hasCategoriesPayload) {
        throw new Error('Public catalog is unavailable.');
      }

      return {
        categories: Array.from(categoryMap.values()),
        products: Array.from(productMap.values()),
      };
    },
  },

  // ── Orders ───────────────────────────────────────────────────────────────
  orders: {
    /**
     * GET /admin/orders (admin all), GET /admin/orders?userId=X (admin user scope),
     * or GET /me/orders (current account).
     * Both use sendPaginated — orders array in `data` directly.
     */
    list: async (userId) => {
      const normalizedUserId = String(userId || '').trim();
      const shouldUseAdminOrders = isAdmin();
      const endpoint = shouldUseAdminOrders ? '/admin/orders' : '/me/orders';
      const pageSize = 100;
      const readPage = async (page) => {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', String(pageSize));
        if (shouldUseAdminOrders && normalizedUserId) params.set('userId', normalizedUserId);

        const res = await http.get(`${endpoint}?${params.toString()}`);
        const raw = res.data || {};
        const data = unwrap(res);
        const orders = Array.isArray(data)
          ? data
          : (data?.orders || raw?.data?.orders || []);
        const pagination = raw?.pagination || data?.pagination || raw?.data?.pagination || null;

        return {
          orders: orders.map(normaliseOrder),
          pagination,
        };
      };

      const firstPage = await readPage(1);
      const pagination = firstPage.pagination || {};
      const explicitPages = Number(pagination.pages || pagination.totalPages || 0);
      const total = Number(pagination.total || pagination.totalItems || pagination.count || 0);
      const limit = Number(pagination.limit || pageSize);
      const computedPages = total > 0 && limit > 0 ? Math.ceil(total / limit) : 1;
      const totalPages = Math.max(1, explicitPages || computedPages);

      if (totalPages <= 1) return firstPage.orders;

      const remainingPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
      const remainingResults = await Promise.all(remainingPages.map((page) => readPage(page)));
      const ordersById = new Map();

      [...firstPage.orders, ...remainingResults.flatMap((result) => result.orders)].forEach((order) => {
        const key = String(order?.id || order?._id || `${ordersById.size}`);
        ordersById.set(key, order);
      });

      return Array.from(ordersById.values());
    },

    /**
     * GET /admin/orders?page=X&limit=Y (admin only — with pagination metadata).
     *
     * Returns { orders: NormalisedOrder[], pagination: { page, limit, total, pages } }.
     * Used by AdminOrders page for numbered pagination.
     *
     * @param {Object}  [params]
     * @param {number}  [params.page=1]
     * @param {number}  [params.limit=100]
     * @param {string}  [params.status]
     * @param {string}  [params.search]    - free-text search (orderNumber, _id, playerID)
     * @param {string}  [params.userId]    - exact site user ID filter
     * @param {string}  [params.startDate] - ISO date string (from)
     * @param {string}  [params.endDate]   - ISO date string (to)
     */
    listPaginated: async ({ page = 1, limit = 100, status, search, userId, startDate, endDate } = {}) => {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(limit));
      if (status && status !== 'all') params.set('status', status);
      if (search && String(search).trim()) params.set('search', String(search).trim());
      if (userId && String(userId).trim()) params.set('userId', String(userId).trim());
      if (startDate) params.set('from', startDate);
      if (endDate) params.set('to', endDate);

      const res = await http.get(`/admin/orders?${params.toString()}`);
      const raw = res.data;
      const ordersArr = Array.isArray(raw?.data) ? raw.data : (raw?.data?.orders || []);
      return {
        orders: ordersArr.map(normaliseOrder),
        pagination: raw?.pagination || { page, limit, total: ordersArr.length, pages: 1 },
      };
    },

    /**
     * GET /api/orders/:id (admin)
     * GET /api/admin/orders/:id (admin fallback)
     * GET /api/me/orders/:id (customer)
     * GET /api/orders/my/:id (customer fallback)
     */
    getById: async (orderId) => {
      const normalizedOrderId = String(orderId || '').trim();
      if (!normalizedOrderId) return null;

      const endpoints = isAdmin()
        ? [`/orders/${normalizedOrderId}`, `/admin/orders/${normalizedOrderId}`]
        : [`/me/orders/${normalizedOrderId}`, `/orders/my/${normalizedOrderId}`];

      let lastError = null;

      for (const endpoint of endpoints) {
        try {
          const res = await http.get(endpoint);
          const data = unwrap(res);
          return normaliseOrder(data?.order || data);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error('Unable to load order details.');
    },

    /**
     * POST /me/orders — place a new order.
     *
     * Newer BE accepts: { productId, quantity, orderFieldsValues, customInputs }.
     * Older BE used POST /orders with the full FE order payload. Keep both shapes
     * so direct "Buy now" can still trigger legacy automatic fulfillment.
     */
    create: async (orderData) => {
      const toPlainObject = (value) => (
        value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      );
      const stripUndefined = (value) => Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined)
      );
      const quantity = Number(orderData.quantity) || 1;
      const rawCustomInputs = (
        orderData.customInputs !== undefined
          ? orderData.customInputs
          : (orderData.orderFieldsValues || orderData.orderFields)
      );
      const orderFieldsValues = {
        ...toPlainObject(rawCustomInputs),
        ...toPlainObject(orderData.orderFieldsValues),
      };
      const declaredFieldKeys = new Set(
        (Array.isArray(orderData?.customerInput?.fieldsSnapshot) ? orderData.customerInput.fieldsSnapshot : [])
          .map((field) => String(field?.key || field?.name || '').trim())
          .filter(Boolean)
      );
      const isDeclaredPayload = declaredFieldKeys.size > 0;
      if (isDeclaredPayload) {
        Object.keys(orderFieldsValues).forEach((key) => {
          if (!declaredFieldKeys.has(key)) delete orderFieldsValues[key];
        });
      }
      const playerId = String(
        orderData.playerId
        || orderFieldsValues.playerId
        || orderFieldsValues.player_id
        || orderFieldsValues.uid
        || orderFieldsValues.userId
        || ''
      ).trim();

      if (playerId && !orderFieldsValues.playerId && (!isDeclaredPayload || declaredFieldKeys.has('playerId'))) {
        orderFieldsValues.playerId = playerId;
      }
      if (
        playerId
        && orderData?.preferLegacyOrderEndpoint
        && !orderFieldsValues.userId
        && (!isDeclaredPayload || declaredFieldKeys.has('userId'))
      ) {
        orderFieldsValues.userId = playerId;
      }

      const hasOrderFieldsValues = Object.keys(orderFieldsValues).length > 0;
      const body = stripUndefined({
        productId: orderData.productId,
        quantity,
        customInputs: hasOrderFieldsValues ? orderFieldsValues : undefined,
        orderFieldsValues: hasOrderFieldsValues ? orderFieldsValues : undefined,
      });

      const legacyBody = stripUndefined({
        ...body,
        id: orderData.id,
        userId: orderData.userId,
        productName: orderData.productName,
        productNameAr: orderData.productNameAr,
        total: orderData.total ?? orderData.priceCoins,
        totalPrice: orderData.totalPrice ?? orderData.priceCoins ?? orderData.total,
        chargedAmount: orderData.chargedAmount ?? orderData.priceCoins ?? orderData.total,
        priceCoins: orderData.priceCoins ?? orderData.total,
        playerId,
        orderFields: hasOrderFieldsValues ? orderFieldsValues : undefined,
        customerInput: orderData.customerInput || (hasOrderFieldsValues ? { values: orderFieldsValues } : undefined),
        quantitySnapshot: orderData.quantitySnapshot,
        unitPrice: orderData.unitPrice,
        unitPriceBase: orderData.unitPriceBase,
        currencyCode: orderData.currencyCode,
        currency: orderData.currencyCode || orderData.currency,
        exchangeRateAtExecution: orderData.exchangeRateAtExecution,
        financialSnapshot: orderData.financialSnapshot,
        status: orderData.status,
        timestamp: orderData.timestamp,
        createdAt: orderData.createdAt,
      });

      const preferLegacy = Boolean(orderData?.preferLegacyOrderEndpoint);
      const requestPlan = preferLegacy
        ? [
            { endpoint: '/orders', body: legacyBody },
            { endpoint: '/me/orders', body },
          ]
        : isAdmin()
          ? [
              { endpoint: '/orders', body: legacyBody },
              { endpoint: '/me/orders', body },
            ]
          : [
              { endpoint: '/me/orders', body },
              { endpoint: '/orders', body: legacyBody },
            ];
      const requestConfig = orderData?.idempotencyKey
        ? { headers: { 'Idempotency-Key': String(orderData.idempotencyKey) } }
        : undefined;
      let lastError = null;

      for (const request of requestPlan) {
        try {
          const res = await http.post(request.endpoint, request.body, requestConfig);
          // If we reach here, the HTTP call returned a 2xx — the order was created.
          // Parse defensively so a normalisation hiccup never masks a successful creation.
          try {
            const data = unwrap(res);
            return {
              order: normaliseOrder(data?.order || data),
              updatedBalance: (data?.updatedBalance ?? data?.order?.updatedBalance ?? res.data?.updatedBalance),
              quota: data?.quota || null,
            };
          } catch (_parseError) {
            // Normalisation failed, but the order WAS created. Return raw data.
            const raw = res.data?.data?.order || res.data?.data || res.data?.order || res.data || {};
            return {
              order: {
                id: raw._id || raw.id || `ord-${Date.now()}`,
                status: (raw.status || 'pending').toLowerCase(),
                ...raw,
              },
              updatedBalance: raw.updatedBalance,
              quota: raw.quota || res.data?.quota || null,
            };
          }
        } catch (error) {
          // HTTP-level error (4xx/5xx) — try the next endpoint.
          const status = error?.response?.status;
          if (status && status !== 404 && status < 500) throw error;
          lastError = error;
        }
      }

      throw lastError || new Error('Unable to create order.');
    },

    /**
     * Map FE status strings to the SINGLE unified backend endpoint.
     *
     * PATCH /admin/orders/:id/status   { status, rejectionReason? }
     *
     * This replaces the previous multi-endpoint fallback approach that caused
     * cascading 404/422 errors.
     */
    updateStatus: async (orderId, status, orderContext = null) => {
      const normalizedOrderId = String(orderId || '').trim();
      // Pass status through as-is — the backend service normalizes internally.
      // Preserving the original casing ensures Joi validates exactly what was sent.
      const body = { status: String(status || '').trim() };

      // Attach rejectionReason if provided via orderContext
      if (orderContext?.rejectionReason) {
        body.rejectionReason = String(orderContext.rejectionReason).trim();
      }

      const res = await http.patch(`/admin/orders/${normalizedOrderId}/status`, body);
      return normaliseOrder(unwrap(res)?.order || unwrap(res));
    },

    /**
     * POST /admin/orders/:id/sync-status
     * Fetches latest order status from the external provider and updates DB.
     */
    syncSupplierStatus: async (orderId, _actorContext) => {
      try {
        const res = await http.post(`/admin/orders/${orderId}/sync-status`);
        return normaliseOrder(unwrap(res)?.order || unwrap(res));
      } catch (err) {
        devLogger.warnUnlessBenign('[realApi] syncSupplierStatus failed:', err);
        return null;
      }
    },
  },

  // ── Topups (BE: "deposits") ──────────────────────────────────────────────
  topups: {
    /**
     * GET /admin/deposits (admin) or GET /me/deposits (customer).
     * Both use sendPaginated — deposits array in `data` directly.
     * Accepts optional query params: { page, limit, status, search }.
     */
    list: async (params = {}) => {
      const base = isAdmin() ? '/admin/deposits' : '/me/deposits';
      const query = new URLSearchParams();
      if (params.page) query.set('page', String(params.page));
      if (params.limit) query.set('limit', String(params.limit));
      if (params.status && params.status !== 'all') query.set('status', params.status);
      if (params.search) query.set('search', params.search);
      const qs = query.toString();
      const endpoint = qs ? `${base}?${qs}` : base;
      const res = await http.get(endpoint);
      // res.data = { success, message, data: [...deposits], pagination, summary }
      // unwrap(res) returns res.data.data which is just the array — we need siblings too.
      const body = res.data || {};
      const items = Array.isArray(body.data) ? body.data : (body.deposits || []);
      const pagination = body.pagination || null;
      const summary = body.summary || null;
      return { items: items.map(normaliseDeposit), pagination, summary };
    },

    /**
     * GET /api/admin/deposits/:id (admin)
     * GET /api/me/deposits/:id (customer)
     * GET /api/deposits/:id (fallback)
     */
    getById: async (topupId) => {
      const normalizedTopupId = String(topupId || '').trim();
      if (!normalizedTopupId) return null;

      const endpoints = isAdmin()
        ? [`/admin/deposits/${normalizedTopupId}`, `/deposits/${normalizedTopupId}`]
        : [`/me/deposits/${normalizedTopupId}`, `/deposits/${normalizedTopupId}`];

      let lastError = null;

      for (const endpoint of endpoints) {
        try {
          const res = await http.get(endpoint);
          const data = unwrap(res);
          return normaliseDeposit(data?.deposit || data);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error('Unable to load deposit details.');
    },

    /**
     * POST /me/deposits — create a deposit request (multi-currency).
     *
     * BE expects multipart/form-data with:
     *   - requestedAmount      (required, number)
     *   - currency             (required, string — ISO 4217)
     *   - paymentMethodId      (required, string)
     *   - receipt              (file, required — multer field name)
     *   - notes                (optional, string)
     *
     * FE sends: { requestedAmount, currency, paymentMethodId, receipt (File), notes }
     */
    create: async (topupData) => {
      const formData = new FormData();

      // ── Text fields — FormData always sends strings, which is fine;
      // express-validator's isFloat() / isString() accept stringified values.
      formData.append(
        'requestedAmount',
        String(topupData.requestedAmount ?? topupData.amount ?? '0'),
      );
      formData.append(
        'currency',
        String(topupData.currency || 'USD').toUpperCase(),
      );
      formData.append(
        'paymentMethodId',
        String(topupData.paymentMethodId || ''),
      );

      const transactionId = String(topupData.transactionId || topupData.transactionNumber || topupData.paymentReference || '').trim();
      const notes = String(topupData.notes || '').trim();
      // `notes` is a documented, persisted deposit field. Keep a machine-readable
      // copy here because some API versions discard custom multipart fields.
      const persistedNotes = transactionId && !/\[transactionNumber:/i.test(notes)
        ? [notes, `[transactionNumber:${transactionId}]`].filter(Boolean).join('\n')
        : notes;
      if (persistedNotes) formData.append('notes', persistedNotes);

      if (transactionId) {
        formData.append('transactionId', transactionId);
        formData.append('transactionNumber', transactionId);
        formData.append('paymentReference', transactionId);
        formData.append('operationNumber', transactionId);
      }

      const senderDetails = normaliseSenderDetails(topupData);
      if (senderDetails) {
        formData.append('senderDetails', JSON.stringify(senderDetails));
        formData.append('senderDetailValue', senderDetails.value);
        formData.append('senderDetailField', senderDetails.field);
        if (senderDetails.field === 'senderWalletAddress') {
          formData.append('senderWalletAddress', senderDetails.value);
        } else {
          formData.append('senderWalletNumber', senderDetails.value);
        }
        formData.append('transferredFromNumber', senderDetails.value);
      }

      // ── File — must be a File/Blob for Multer to parse it into req.file
      const file = topupData.receipt || topupData.proofImage || null;
      if (file) formData.append('receipt', file);

      // Axios auto-sets Content-Type to multipart/form-data with boundary
      // when the body is a FormData instance. Do NOT override it.
      const res = await http.post('/me/deposits', formData);
      return normaliseDeposit(unwrap(res));
    },

    /**
     * Map FE status strings to BE admin action routes.
     *
     * BE admin actions:
     *   PATCH /admin/deposits/:id/approve  — approve + credit wallet
     *     Body: { amount?, currency?, adminNotes? }
     *   PATCH /admin/deposits/:id/reject   — reject
     *     Body: { adminNotes? }
     *
     * FE calls: apiClient.topups.updateStatus(id, status, reviewData)
     *   reviewData may contain:
     *     - actualPaidAmount  → maps to body.amount
     *     - currencyCode      → maps to body.currency
     *     - adminNote         → maps to body.adminNotes
     */
    updateStatus: async (topupId, status, reviewData) => {
      const normalised = (status || '').toLowerCase();
      let res;

      if (['approved', 'completed'].includes(normalised)) {
        // Build approve body — send admin overrides using backend field names
        const body = {};
        const overrideAmount = reviewData?.actualPaidAmount
          ?? reviewData?.financialSnapshot?.originalAmount
          ?? null;
        if (overrideAmount !== null && overrideAmount !== undefined) {
          body.amount = Number(overrideAmount);
        }
        const overrideCurrency = reviewData?.currencyCode
          ?? reviewData?.currency
          ?? null;
        if (overrideCurrency) {
          body.currency = String(overrideCurrency).toUpperCase();
        }
        const notes = reviewData?.adminNote ?? reviewData?.adminNotes ?? null;
        if (notes) {
          body.adminNotes = String(notes).trim();
        }
        res = await http.patch(`/admin/deposits/${topupId}/approve`, body);
        return normaliseDeposit(unwrap(res));
      }

      if (['rejected', 'denied', 'failed'].includes(normalised)) {
        const rejectBody = {};
        const notes = reviewData?.adminNote ?? reviewData?.adminNotes ?? null;
        if (notes) {
          rejectBody.adminNotes = String(notes).trim();
        }
        res = await http.patch(`/admin/deposits/${topupId}/reject`, rejectBody);
        return normaliseDeposit(unwrap(res));
      }

      // Unknown status
      devLogger.warn(`[realApi] topups.updateStatus: Unknown status '${status}'.`);
      return null;
    },

    /**
     * PATCH /admin/deposits/:id → update a PENDING deposit request.
     * BE only allows updates when status === PENDING.
     */
    updateRequest: async (topupId, updates) => {
      try {
        const body = {};
        if (
          updates.requestedAmount !== undefined
          || updates.amountRequested !== undefined
          || updates.amount !== undefined
        ) {
          body.requestedAmount = Number(
            updates.requestedAmount ?? updates.amountRequested ?? updates.amount,
          );
        }
        const res = await http.patch(`/admin/deposits/${topupId}`, body);
        const data = unwrap(res);
        return data?.deposit || data;
      } catch (err) {
        devLogger.warnUnlessBenign('[realApi] topups.updateRequest failed:', err);
        return null;
      }
    },
  },

  targetApps: {
    listActive: async () => {
      const res = await http.get('/me/targets/apps');
      const data = unwrap(res);
      const apps = Array.isArray(data) ? data : (data?.apps || data?.items || []);
      return apps.map(normaliseTargetApp);
    },

    list: async () => {
      const res = await http.get('/admin/target-apps');
      const data = unwrap(res);
      const apps = Array.isArray(data) ? data : (data?.apps || data?.items || []);
      return apps.map(normaliseTargetApp);
    },

    create: async (payload = {}) => {
      const formData = buildTargetAppFormData(payload);
      const res = await http.post('/admin/target-apps', formData);
      const data = unwrap(res);
      return normaliseTargetApp(data?.app || data);
    },

    update: async (id, payload = {}) => {
      const formData = buildTargetAppFormData(payload, { partial: true });
      const res = await http.patch(`/admin/target-apps/${id}`, formData);
      const data = unwrap(res);
      return normaliseTargetApp(data?.app || data);
    },

    delete: async (id) => {
      const res = await http.delete(`/admin/target-apps/${id}`);
      const data = unwrap(res);
      return normaliseTargetApp(data?.app || data);
    },
  },

  targetPurchases: {
    list: async (params = {}) => {
      const res = await http.get('/admin/targets', { params });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.orders || data?.requests || data?.items || []);
      return items.map(normaliseTargetOrder);
    },

    listMine: async (params = {}) => {
      const res = await http.get('/me/targets', { params });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.orders || data?.requests || data?.items || []);
      return items.map(normaliseTargetOrder);
    },

    create: async (payload) => {
      const formData = payload instanceof FormData ? payload : buildTargetOrderFormData(payload);
      if (formData instanceof FormData && !formData.has('idempotencyKey')) {
        formData.append('idempotencyKey', createClientIdempotencyKey());
      }
      const res = await http.post('/me/targets', formData);
      const data = unwrap(res);
      return normaliseTargetOrder(data?.order || data?.request || data);
    },

    updateStatus: async (id, status, payload = {}) => {
      const normalizedStatus = String(status || '').trim().toLowerCase();
      const endpoint = normalizedStatus === 'approved' || normalizedStatus === 'done'
        ? `/admin/targets/${id}/approve`
        : normalizedStatus === 'rejected'
          ? `/admin/targets/${id}/reject`
          : null;

      if (!endpoint && normalizedStatus !== 'pending') {
        throw new Error(`Unsupported target order status: ${status}`);
      }

      const body = normalizedStatus === 'rejected'
        ? { adminNotes: payload.adminNotes ?? payload.rejectionReason ?? payload.reason ?? '' }
        : {};
      const pendingBody = { status: 'PENDING' };

      const requests = endpoint
        ? [{ url: endpoint, body }]
        : [
            { url: `/admin/targets/${id}/status`, body: pendingBody },
            { url: `/admin/targets/${id}`, body: pendingBody },
          ];

      let lastError = null;
      for (const request of requests) {
        try {
          const res = await http.patch(request.url, request.body);
          const data = unwrap(res);
          return normaliseTargetOrder(data?.order || data?.request || data);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error(`Unsupported target order status: ${status}`);
    },
  },

  // ── System (Currencies & Payment Settings) ──────────────────────────────
  system: {
    /**
     * Fetch currencies — tries public endpoint first (for registration page),
     * falls back to admin endpoint if authenticated.
     */
    currencies: async () => {
      try {
        // Try public endpoint first (no auth required — works on registration page)
        const publicRes = await http.get('/currencies/active');
        const publicData = unwrap(publicRes);
        const publicItems = Array.isArray(publicData) ? publicData : (publicData?.currencies || []);
        if (publicItems.length > 0) return publicItems.map(normaliseCurrency);
      } catch (_) {
        // Public endpoint may not exist on older BE — fall through
      }

      // Fall back to admin endpoint (requires authentication)
      try {
        const res = await http.get('/admin/currencies');
        const data = unwrap(res);
        const items = Array.isArray(data) ? data : (data?.currencies || []);
        return items.map(normaliseCurrency);
      } catch (_) {
        return [];
      }
    },

    /**
     * POST /admin/currencies → create a new currency.
     * BE Joi: { code (req), name (req), symbol (req), platformRate (req), marketRate, markupPercentage, isActive }
     */
    addCurrency: async (payload, _actorContext) => {
      const body = {
        code: payload.code,
        name: payload.name,
        symbol: payload.symbol,
        platformRate: payload.platformRate ?? payload.rate ?? 1,
        marketRate: payload.marketRate ?? null,
        markupPercentage: payload.markupPercentage ?? 0,
        isActive: payload.isActive !== false,
      };
      const res = await http.post('/admin/currencies', body);
      return normaliseCurrency(unwrap(res)?.currency || unwrap(res));
    },

    /**
     * PATCH /admin/currencies/:code → update currency fields.
     *
     * BE Joi: { platformRate (req), markupPercentage, isActive, applyDebtAdjustment }
     * FE may send: { rate, platformRate, markupPercentage, isActive, applyDebtAdjustment }
     */
    updateCurrency: async (code, updates, _actorContext) => {
      const currencyCode = String(code || '').trim().toUpperCase();
      if (!currencyCode) throw new Error('Currency code is required');

      const body = {};
      // Map FE `rate` to BE `platformRate`
      const rate = updates.platformRate ?? updates.rate;
      if (rate !== undefined) {
        const platformRate = Number(rate);
        if (!Number.isFinite(platformRate) || platformRate <= 0) {
          throw new Error('Currency rate must be a positive number');
        }
        body.platformRate = platformRate;
      }
      if (updates.markupPercentage !== undefined) body.markupPercentage = Number(updates.markupPercentage);
      if (updates.isActive !== undefined) body.isActive = updates.isActive;
      if (updates.applyDebtAdjustment) body.applyDebtAdjustment = true;

      const res = await http.patch(`/admin/currencies/${encodeURIComponent(currencyCode)}`, body);
      const data = unwrap(res);
      const currency = normaliseCurrency(data?.currency || data);
      const debtAdjustment = data?.debtAdjustment || null;
      return { ...currency, debtAdjustment };
    },

    /**
     * DELETE /admin/currencies/:code → remove an unused currency.
     */
    deleteCurrency: async (code, _actorContext) => {
      const res = await http.delete(`/admin/currencies/${code}`);
      return normaliseCurrency(unwrap(res)?.currency || unwrap(res));
    },

    /**
     * GET /admin/settings → array of { key, value } → structured FE object.
     *
     * Transforms the flat BE settings array into the FE payment settings shape:
     *   { countryAccounts, instructions, whatsappNumber, paymentGroups }
     */
    paymentSettings: async () => {
      const role = getStoredRole() || 'CUSTOMER';
      const shouldUseAdminSettings = role && role !== 'CUSTOMER';
      prepareFreshPaymentSettingsRequest();

      // Customer sessions: try the public payment settings endpoint.
      if (!shouldUseAdminSettings) {
        try {
          const res = await http.get('/settings/payment');
          const data = unwrap(res);
          return normalizePaymentSettingsResponse(data);
        } catch (_publicErr) {
          return {
            countryAccounts: [],
            instructions: '',
            whatsappNumber: '',
            paymentGroups: [],
          };
        }
      }

      try {
        const res = await http.get('/admin/settings');
        const data = unwrap(res);
        const settings = Array.isArray(data) ? data : (data?.settings || []);
        const find = (key) => settings.find((item) => item.key === key)?.value;
        const normalized = normalizePaymentSettingsResponse({
          countryAccounts: find('paymentCountryAccounts'),
          instructions: find('paymentInstructions'),
          whatsappNumber: find('whatsappNumber'),
          paymentGroups: find('paymentGroups'),
        });
        return normalized;
      } catch (error) {
        const status = Number(error?.response?.status || error?.status || 0);
        if (status === 403) {
          // Token is valid but role isn't actually admin — try the public endpoint.
          try {
            const res = await http.get('/settings/payment');
            return normalizePaymentSettingsResponse(unwrap(res));
          } catch {
            return {
              countryAccounts: [],
              instructions: '',
              whatsappNumber: '',
              paymentGroups: [],
            };
          }
        }

        if (!shouldUseAdminSettings) {
          return {
            countryAccounts: [],
            instructions: '',
            whatsappNumber: '',
            paymentGroups: [],
          };
        }

        throw error;
      }
    },

    /**
     * Update payment settings — dispatches multiple PATCH /admin/settings/:key.
     *
     * BE expects: PATCH /admin/settings/:key with body { value: <any> }
     * FE sends: { countryAccounts?, instructions?, whatsappNumber?, paymentGroups? }
     *
     * Maps each FE key to the corresponding BE setting key and dispatches
     * parallel PATCH requests for each changed value.
     */
    updatePaymentSettings: async (payload, _actorContext) => {
      prepareFreshPaymentSettingsRequest();
      const normalizedPayload = {
        ...(payload?.countryAccounts !== undefined ? {
          countryAccounts: normalizePaymentSettingsResponse({ countryAccounts: payload.countryAccounts }).countryAccounts,
        } : {}),
        ...(payload?.instructions !== undefined ? {
          instructions: String(payload.instructions || '').trim(),
        } : {}),
        ...(payload?.whatsappNumber !== undefined ? {
          whatsappNumber: String(payload.whatsappNumber || '').trim(),
        } : {}),
        ...(payload?.paymentGroups !== undefined ? {
          paymentGroups: serializePaymentGroupsForApi(payload.paymentGroups),
        } : {}),
      };
      const keyMap = {
        countryAccounts: 'paymentCountryAccounts',
        instructions: 'paymentInstructions',
        whatsappNumber: 'whatsappNumber',
        paymentGroups: 'paymentGroups',
      };
      const updates = Object.entries(keyMap)
        .filter(([feKey]) => normalizedPayload[feKey] !== undefined)
        .map(([feKey, beKey]) => http.patch(`/admin/settings/${beKey}`, { value: normalizedPayload[feKey] }));

      if (updates.length > 0) await Promise.all(updates);

      const freshRes = await http.get('/admin/settings');
      const freshData = unwrap(freshRes);
      const allSettings = freshData?.settings || (Array.isArray(freshData) ? freshData : []);
      const find = (k) => allSettings.find((s) => s.key === k)?.value;
      return normalizePaymentSettingsResponse({
        countryAccounts: find('paymentCountryAccounts'),
        instructions: find('paymentInstructions'),
        whatsappNumber: find('whatsappNumber'),
        paymentGroups: find('paymentGroups'),
      });
    },

    /**
     * GET /admin/settings → return all settings as raw array.
     * Useful for admin settings pages that show all key-value pairs.
     */
    allSettings: async () => {
      const res = await http.get('/admin/settings');
      const data = unwrap(res);
      const settings = Array.isArray(data) ? data : (data?.settings || []);
      return settings.map((s) => ({ ...s, id: s._id || s.id || s.key, _id: undefined }));
    },

    /**
     * GET /admin/settings/:key → return a single setting.
     */
    getSetting: async (key) => {
      const res = await http.get(`/admin/settings/${key}`);
      const data = unwrap(res);
      return data?.setting || data;
    },

    /**
     * PATCH /admin/settings/:key → update a single setting.
     * BE Joi: { value: <any> (required) }
     */
    updateSetting: async (key, value, _actorContext) => {
      const res = await http.patch(`/admin/settings/${key}`, { value });
      const data = unwrap(res);
      return data?.setting || data;
    },
  },

  // ── Audit ────────────────────────────────────────────────────────────────
  audit: {
    /**
     * GET /admin/audit → paginated audit logs.
     *
     * BE route handler:
     *   const { entityType, entityId, page, limit } = req.query;
     *   getEntityAuditLogs(entityId, entityType, { page, limit })
     *
     * If entityType/entityId are undefined, Mongo query matches nothing
     * specific — effectively returns an empty set.
     * To get "all" logs, omit both params (BE won't throw).
     *
     * @param {Object} [filters] - optional filters
     * @param {string} [filters.entityType] - e.g. 'USER', 'ORDER', 'PROVIDER'
     * @param {string} [filters.entityId]   - specific entity ID
     * @param {number} [filters.page]       - page number
     * @param {number} [filters.limit]      - items per page
     */
    list: async (filters = {}) => {
      const params = {};
      if (filters.entityType) params.entityType = filters.entityType;
      if (filters.entityId) params.entityId = filters.entityId;
      params.page = filters.page || 1;
      params.limit = filters.limit || 50;

      const res = await http.get('/admin/audit', { params });
      const data = unwrap(res);
      const logs = Array.isArray(data) ? data : (data?.logs || []);
      return logs.map((l) => ({
        ...l,
        id: l._id || l.id,
        _id: undefined,
        // Resolve populated actor ref
        actorName: typeof l.actorId === 'object' ? l.actorId?.name : l.actorName || '',
        actorId: typeof l.actorId === 'object' ? (l.actorId?._id || l.actorId?.id) : l.actorId,
      }));
    },

    /**
     * GET /admin/audit/actor/:actorId → paginated logs for a specific admin.
     */
    actorLogs: async (actorId, { page = 1, limit = 50 } = {}) => {
      const res = await http.get(`/admin/audit/actor/${actorId}`, { params: { page, limit } });
      const data = unwrap(res);
      const logs = Array.isArray(data) ? data : (data?.logs || []);
      return logs.map((l) => ({
        ...l,
        id: l._id || l.id,
        _id: undefined,
      }));
    },
  },

  // ── Wallet ────────────────────────────────────────────────────────────────
  wallet: {
    /**
     * GET /wallet/stats — aggregated wallet stats for authenticated user.
     * Returns: { totalDeposits, totalSpent, totalRefunds, netBalance, totalTransactions }
     */
    getStats: async () => {
      const res = await http.get('/wallet/stats');
      return unwrap(res);
    },

    /**
     * GET /wallet/transactions — paginated transaction history for authenticated user.
     * Returns array of { _id, type, amount, status, description, reference, createdAt, ... }
     */
    getTransactions: async ({ page = 1, limit = 50 } = {}) => {
      const res = await http.get('/wallet/transactions', { params: { page, limit } });
      const data = unwrap(res);
      const items = Array.isArray(data) ? data : (data?.transactions || data?.data || []);
      return items
        .map((entry) => normaliseWalletTransaction(entry))
        .filter(Boolean);
    },
  },
};

/**
 * Upload an image file to the generic upload endpoint.
 *
 * @param {'products'|'categories'|'payments'} category
 * @param {File} file - The image file to upload
 * @returns {Promise<string>} The relative path (e.g. '/uploads/products/123-abc.jpg')
 */
export const uploadImage = async (category, file) => {
  const formData = new FormData();
  formData.append('image', file);
  const res = await http.post(`/upload/${category}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  const data = unwrap(res);
  return data?.path || '';
};

export default realApi;
