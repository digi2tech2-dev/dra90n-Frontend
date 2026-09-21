import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  KeyRound,
  MailCheck,
  RotateCcw,
  Search,
  Wallet,
} from 'lucide-react';
import useAdminStore from '../../store/useAdminStore';
import useGroupStore from '../../store/useGroupStore';
import useSystemStore from '../../store/useSystemStore';
import useAuthStore from '../../store/useAuthStore';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import Modal from '../../components/ui/Modal';
import ConfirmDialog from '../../components/account/ConfirmDialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { useLanguage } from '../../context/LanguageContext';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber, getNumericLocale } from '../../utils/intl';
import { formatWalletAmount } from '../../utils/storefront';
import { PERMISSIONS, hasPermission } from '../../utils/permissions';
import {
  getAccountStatusBadgeVariant,
  getAccountStatusLabel,
  getSignupMethodLabel,
  getUserRegistrationDate,
  isApprovedAccountStatus,
  isPendingAccountStatus,
  isRejectedAccountStatus,
  normalizeAccountStatus,
} from '../../utils/accountStatus';
import { resolveUserAvatar } from '../../utils/avatar';
import apiClient from '../../services/client';
import { normalizeBillingMode, normalizeQuota } from '../../utils/billing';

const FILTER_OPTIONS = ['all', 'approved', 'rejected', 'deleted'];
const USERS_PER_PAGE = 20;

const compactButtonClassName = 'h-7 rounded-[var(--radius-sm)] px-2 text-[10px]';
const compactFieldClassName =
  'h-8 rounded-full px-2.5 text-[10px] shadow-[0_8px_20px_-20px_rgb(0_0_0/0.8)]';
const compactTableHeadClassName = 'h-9 px-2.5 text-[10px] tracking-[0.08em]';
const compactTableCellClassName = 'px-2 py-1.5 text-[10px]';
const detailsMetricClassName =
  'rounded-[var(--radius-md)] border border-[color:rgb(var(--color-border-rgb)/0.78)] bg-[color:rgb(var(--color-surface-rgb)/0.62)] p-2.5';

const balanceBadgeClassName = [
  'wallet-balance-shimmer relative isolate inline-flex items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[10px] font-semibold',
  'border-[#e6c76b] bg-[linear-gradient(135deg,rgba(255,248,220,0.96),rgba(244,210,102,0.2))]',
  'text-[#8c6500] shadow-[0_10px_22px_-20px_rgba(191,149,27,0.95)]',
].join(' ');

const negativeBalanceBadgeClassName = [
  'relative isolate inline-flex items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[10px] font-semibold',
  'border-[rgba(220,38,38,0.26)] bg-[linear-gradient(135deg,rgba(254,226,226,0.96),rgba(248,113,113,0.16))]',
  'text-[#b91c1c] shadow-[0_10px_22px_-20px_rgba(220,38,38,0.85)]',
].join(' ');

const userIdButtonClassName =
  'mt-0.5 block max-w-full truncate rounded-md text-start font-mono text-[8px] leading-3 text-[color:rgb(var(--color-text-rgb)/0.44)] transition hover:text-[var(--color-primary)]';

const resolveInitialGroupValue = (entry, groups) => {
  if (entry?.groupId) return entry.groupId;
  const matchedGroup = (groups || []).find((group) => group.name === entry?.group || group.nameAr === entry?.group);
  return matchedGroup?.id || groups?.[0]?.id || '';
};

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeUserSearchText = (value) => String(value || '')
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .trim()
  .toLowerCase();

const getSearchTokens = (value) => normalizeUserSearchText(value)
  .split(/[\s,;|/\\]+/)
  .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
  .filter(Boolean);

const buildWalletPreview = (entry, wallet = null) => {
  if (!entry && !wallet) return null;

  const recentTransactions = Array.isArray(wallet?.recentTransactions) ? wallet.recentTransactions : [];
  const balance = toFiniteNumber(wallet?.walletBalance ?? wallet?.balance ?? entry?.coins, 0);

  return {
    userId: String(wallet?.userId || entry?.id || ''),
    walletBalance: balance,
    currency: String(wallet?.currency || entry?.currency || 'USD').toUpperCase(),
    transactionsCount: toFiniteNumber(wallet?.transactionsCount ?? recentTransactions.length, recentTransactions.length),
    recentTransactions,
    lastTransactionAt: wallet?.lastTransactionAt || recentTransactions[0]?.createdAt || null,
  };
};

const getWalletBalanceValue = (entry, wallet = null) => toFiniteNumber(wallet?.walletBalance ?? wallet?.balance ?? entry?.coins, 0);

const getBalanceBadgeTone = (value) => (
  toFiniteNumber(value, 0) < 0 ? negativeBalanceBadgeClassName : balanceBadgeClassName
);

const getBalanceTextTone = (value) => (
  toFiniteNumber(value, 0) < 0 ? 'text-[#b91c1c]' : 'text-[var(--color-text)]'
);

const getDetailsMetricTone = (value) => (
  toFiniteNumber(value, 0) < 0
    ? 'border-[rgba(220,38,38,0.18)] bg-[linear-gradient(135deg,rgba(254,242,242,0.92),rgba(255,255,255,0.82))]'
    : ''
);

const AdminUsers = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const statusFromQuery = searchParams.get('status');
  const initialFilter = FILTER_OPTIONS.includes(statusFromQuery) ? statusFromQuery : 'all';

  const {
    users,
    deletedUsers,
    loadUsers,
    loadUsersPage,
    usersPagination,
    getUserById,
    wallets,
    loadWallets,
    getUserWallet,
    updateUserStatus,
    updateUserGroup,
    updateUserCoins,
    updateUserCurrency,
    updateUserCreditLimit,
    updateUserProfile,
    deleteUser,
    restoreUser,
    resetUserPassword,
    resendUserVerification,
  } = useAdminStore();
  const { groups, loadGroups } = useGroupStore();
  const { currencies, loadCurrencies } = useSystemStore();
  const { user: actor } = useAuthStore();
  const { addToast } = useToast();
  const { t } = useLanguage();
  const { i18n } = useTranslation();

  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [selectedUser, setSelectedUser] = useState(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState(null);
  const [isApproveModalOpen, setIsApproveModalOpen] = useState(false);
  const [approveGroup, setApproveGroup] = useState('');
  const [approveCurrency, setApproveCurrency] = useState('USD');
  const [approveCreditLimit, setApproveCreditLimit] = useState('0');
  const [rejectTarget, setRejectTarget] = useState(null);
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
  const [settingsTopupAmount, setSettingsTopupAmount] = useState('');
  const [settingsGroup, setSettingsGroup] = useState('');
  const [settingsCurrency, setSettingsCurrency] = useState('USD');
  const [settingsCreditLimit, setSettingsCreditLimit] = useState('0');
  const [settingsQuantityLimit, setSettingsQuantityLimit] = useState('0');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [manualPassword, setManualPassword] = useState('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDetailsLoading, setIsDetailsLoading] = useState(false);
  const [copiedUserId, setCopiedUserId] = useState('');
  const [localPage, setLocalPage] = useState(1);

  const isArabic = String(i18n.resolvedLanguage || i18n.language || 'ar').toLowerCase().startsWith('ar');
  const locale = getNumericLocale(isArabic ? 'ar-EG' : 'en-US');
  const canConfirmAccounts = hasPermission(actor, PERMISSIONS.CONFIRM_ACCOUNTS);
  const canManageUsers = hasPermission(actor, PERMISSIONS.MANAGE_USERS);
  const canManageWallet = hasPermission(actor, PERMISSIONS.MANAGE_WALLET);
  const canViewWallet = hasPermission(actor, PERMISSIONS.ADMIN_WALLET);

  useEffect(() => {
    loadGroups({ force: true });
    loadCurrencies({ force: true });
    Promise.resolve(loadWallets({ force: true })).catch(() => null);
  }, [loadCurrencies, loadGroups, loadWallets]);

  // Search and status are applied by the API, so results and counts span every
  // user page instead of only the users that happened to be loaded first.
  useEffect(() => {
    const status = filter === 'all' || filter === 'deleted' ? '' : filter;
    loadUsers({
      force: true,
      page: 1,
      search: filter === 'deleted' ? '' : deferredSearch,
      status,
      role: 'customer',
    });
  }, [deferredSearch, filter, loadUsers]);

  useEffect(() => {
    if (!FILTER_OPTIONS.includes(statusFromQuery)) return;
    setFilter(statusFromQuery);
  }, [statusFromQuery]);

  useEffect(() => {
    if (!selectedUser?.id) return;
    const nextSelected = (users || []).find((entry) => entry.id === selectedUser.id);
    if (nextSelected) {
      setSelectedUser(nextSelected);
      setSettingsGroup(resolveInitialGroupValue(nextSelected, groups));
      setSettingsCurrency(nextSelected.currency || currencies[0]?.code || 'USD');
      setSettingsCreditLimit(String(toFiniteNumber(nextSelected?.creditLimit, 0)));
    }
  }, [currencies, groups, selectedUser?.id, users]);

  const customerUsers = useMemo(
    () => (users || []).filter((entry) => String(entry?.role || '').trim().toLowerCase() === 'customer'),
    [users]
  );

  const approvedCount = useMemo(
    () => customerUsers.filter((entry) => isApprovedAccountStatus(entry?.status)).length,
    [customerUsers]
  );
  const rejectedCount = useMemo(
    () => customerUsers.filter((entry) => isRejectedAccountStatus(entry?.status)).length,
    [customerUsers]
  );
  const deletedCustomerUsers = useMemo(
    () => (deletedUsers || []).filter((entry) => String(entry?.role || '').trim().toLowerCase() === 'customer'),
    [deletedUsers]
  );
  const deletedCount = useMemo(
    () => deletedCustomerUsers.length,
    [deletedCustomerUsers]
  );

  const walletByUserId = useMemo(
    () => new Map((wallets || []).map((entry) => [String(entry?.userId || entry?.id || '').trim(), entry])),
    [wallets]
  );

  const filteredUsers = useMemo(() => {
    const searchTokens = getSearchTokens(search);
    const sourceUsers = filter === 'deleted' ? deletedCustomerUsers : customerUsers;

    return [...sourceUsers]
      .filter((entry) => {
        const walletPreview = buildWalletPreview(entry, walletByUserId.get(String(entry?.id || '').trim()) || null);
        const normalizedStatus = normalizeAccountStatus(entry?.status);
        const isDeletedEntry = Boolean(entry?.deletedAt) || Boolean(entry?.isDeleted) || normalizedStatus === 'deleted';
        const matchesFilter = filter === 'all'
          ? true
          : filter === 'deleted'
            ? isDeletedEntry
            : normalizedStatus === filter;
        const haystack = [
          entry?.id,
          entry?._id,
          entry?.userId,
          entry?.name,
          entry?.fullName,
          entry?.email,
          entry?.username,
          entry?.phone,
          entry?.phoneNumber,
          entry?.country,
          entry?.countryCode,
          entry?.currency,
          entry?.role,
          entry?.group,
          entry?.groupId,
          entry?.status,
          normalizedStatus,
          getAccountStatusLabel(entry?.status, isArabic),
          getSignupMethodLabel(entry?.signupMethod || entry?.authProvider, isArabic),
          entry?.coins,
          entry?.walletBalance,
          entry?.balance,
          entry?.creditLimit,
          walletPreview?.userId,
          walletPreview?.currency,
          walletPreview?.walletBalance,
          walletPreview?.transactionsCount,
        ].join(' ');
        const normalizedHaystack = normalizeUserSearchText(haystack);
        const matchesSearch = !searchTokens.length || searchTokens.every((token) => normalizedHaystack.includes(token));
        return matchesFilter && matchesSearch;
      })
      .sort((left, right) => {
        return Number(right?.walletBalance ?? right?.coins ?? right?.balance ?? 0)
          - Number(left?.walletBalance ?? left?.coins ?? left?.balance ?? 0);
      });
  }, [customerUsers, deletedCustomerUsers, filter, isArabic, search, walletByUserId]);

  const serverPageCount = Number(usersPagination?.pages || 0);
  const usesServerPagination = filter !== 'deleted' && serverPageCount > 1;
  const localPageCount = Math.max(1, Math.ceil(filteredUsers.length / USERS_PER_PAGE));
  const safeLocalPage = Math.min(localPage, localPageCount);
  const visibleUsers = useMemo(() => {
    if (usesServerPagination) return filteredUsers;
    const start = (safeLocalPage - 1) * USERS_PER_PAGE;
    return filteredUsers.slice(start, start + USERS_PER_PAGE);
  }, [filteredUsers, safeLocalPage, usesServerPagination]);

  useEffect(() => {
    setLocalPage(1);
  }, [filter, search]);

  const openDetails = async (entry) => {
    setSelectedUser(entry);
    setSettingsTopupAmount('');
    setSettingsGroup(resolveInitialGroupValue(entry, groups));
    setSettingsCurrency(entry?.currency || currencies[0]?.code || 'USD');
    setSettingsCreditLimit(String(toFiniteNumber(entry?.creditLimit, 0)));
    setSettingsQuantityLimit(String(toFiniteNumber(entry?.quantityLimit ?? entry?.quota?.limit, 0)));
    setTemporaryPassword('');
    setManualPassword('');
    setIsDetailsOpen(true);
    setIsDetailsLoading(true);

    if (filter === 'deleted') {
      setIsDetailsLoading(false);
      return;
    }

    try {
      const [userResult] = await Promise.allSettled([
        getUserById(entry.id, { force: true }),
        getUserWallet(entry.id, { force: true }),
      ]);

      if (userResult.status === 'fulfilled' && userResult.value) {
        setSelectedUser(userResult.value);
        setSettingsGroup(resolveInitialGroupValue(userResult.value, groups));
        setSettingsCurrency(userResult.value?.currency || currencies[0]?.code || 'USD');
        setSettingsCreditLimit(String(toFiniteNumber(userResult.value?.creditLimit, 0)));
        setSettingsQuantityLimit(String(toFiniteNumber(userResult.value?.quantityLimit ?? userResult.value?.quota?.limit, 0)));
      }
    } finally {
      setIsDetailsLoading(false);
    }
  };

  const formatDate = (value) => {
    if (!value) return isArabic ? 'غير متوفر' : 'Unavailable';
    return formatDateTime(value, locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const resolveWalletForEntry = (entry) => {
    if (!entry?.id) return null;
    return buildWalletPreview(entry, walletByUserId.get(String(entry.id).trim()) || null);
  };

  const formatBalance = (entry) => {
    const walletPreview = resolveWalletForEntry(entry);
    return formatWalletAmount(
      getWalletBalanceValue(entry, walletPreview),
      walletPreview?.currency || entry?.currency || 'USD'
    );
  };

  const handleFilterChange = (value) => {
    setFilter(value);
    if (value === 'all') {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('status');
      setSearchParams(nextParams);
      return;
    }
    setSearchParams({ status: value });
  };

  const syncSelectedUser = (updatedUser) => {
    if (selectedUser?.id && updatedUser?.id === selectedUser.id) {
      setSelectedUser(updatedUser);
    }
  };

  const askApprove = (entry) => {
    if (!entry?.id) return;

    setApproveTarget(entry);
    setApproveGroup(resolveInitialGroupValue(entry, groups));
    setApproveCurrency(String(entry?.currency || currencies?.[0]?.code || 'USD').toUpperCase());
    setApproveCreditLimit(String(toFiniteNumber(entry?.creditLimit, 0)));
    setIsApproveModalOpen(true);
  };

  const confirmApprove = async () => {
    if (!approveTarget?.id) return;

    const normalizedGroup = String(approveGroup || '').trim();
    const normalizedCurrency = String(approveCurrency || '').trim().toUpperCase();
    const parsedCreditLimit = Number(approveCreditLimit);

    if (!normalizedGroup) {
      addToast('يجب اختيار مجموعة قبل تفعيل الحساب.', 'error');
      return;
    }

    if (!normalizedCurrency) {
      addToast('يجب اختيار عملة قبل تفعيل الحساب.', 'error');
      return;
    }

    if (!Number.isFinite(parsedCreditLimit) || parsedCreditLimit < 0) {
      addToast('حد الدين يجب أن يكون رقمًا صالحًا أكبر من أو يساوي صفر.', 'error');
      return;
    }

    const normalizedCreditLimit = toFiniteNumber(parsedCreditLimit, 0);

    setIsSubmitting(true);
    try {
      // 1) Ensure required fields are set BEFORE approving.
      await updateUserGroup(approveTarget.id, normalizedGroup, actor);
      await updateUserCreditLimit(approveTarget.id, normalizedCreditLimit, actor);
      await updateUserCurrency(approveTarget.id, normalizedCurrency, actor);

      // 2) Approve the account.
      const updated = await updateUserStatus(approveTarget.id, 'approved', actor);
      syncSelectedUser(updated);
      addToast('تمت الموافقة على الحساب بنجاح.', 'success');

      setIsApproveModalOpen(false);
      setApproveTarget(null);

      await Promise.allSettled([
        loadUsers({ force: true }),
        getUserWallet(approveTarget.id, { force: true }),
      ]);
    } catch (error) {
      addToast(error?.message || 'تعذر اعتماد هذا الحساب.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const askReject = (entry) => {
    setRejectTarget(entry);
    setIsRejectModalOpen(true);
  };

  const confirmReject = async () => {
    if (!rejectTarget) return;

    setIsSubmitting(true);
    try {
      const updated = await updateUserStatus(rejectTarget.id, 'rejected', actor);
      syncSelectedUser(updated);
      addToast('تم رفض الحساب بنجاح.', 'success');
      setIsRejectModalOpen(false);
      setRejectTarget(null);
      await Promise.allSettled([
        loadUsers({ force: true }),
        getUserWallet(rejectTarget.id, { force: true }),
      ]);
    } catch (error) {
      addToast(error?.message || 'تعذر رفض هذا الحساب.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStatusToggleFromDetails = async () => {
    if (!selectedUser) return;

    if (isRejectedAccountStatus(selectedUser.status)) {
      askApprove(selectedUser);
      return;
    }

    askReject(selectedUser);
  };

  const handleSettingsGroupSave = async () => {
    if (!selectedUser || !settingsGroup) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية تعديل بيانات المستخدمين.', 'error');
      return;
    }

    try {
      await updateUserGroup(selectedUser.id, settingsGroup, actor);
      addToast('تم تحديث المجموعة بنجاح.', 'success');
      await loadUsers({ force: true });
    } catch (error) {
      addToast(error?.message || 'تعذر تحديث المجموعة.', 'error');
    }
  };

  const handleSettingsCurrencySave = async () => {
    if (!selectedUser || !settingsCurrency) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية تعديل بيانات المستخدمين.', 'error');
      return;
    }

    try {
      await updateUserCurrency(selectedUser.id, settingsCurrency, actor);
      addToast('تم تحديث العملة بنجاح.', 'success');
      await Promise.allSettled([
        loadUsers({ force: true }),
        getUserWallet(selectedUser.id, { force: true }),
      ]);
    } catch (error) {
      addToast(error?.message || 'تعذر تحديث العملة.', 'error');
    }
  };

  const handleSettingsCreditLimitSave = async () => {
    if (!selectedUser) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية تعديل بيانات المستخدمين.', 'error');
      return;
    }

    const parsedValue = Number(settingsCreditLimit);
    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
      addToast('حد الدين يجب أن يكون رقمًا صالحًا أكبر من أو يساوي صفر.', 'error');
      return;
    }

    const normalizedValue = toFiniteNumber(parsedValue, 0);

    try {
      const updated = await updateUserCreditLimit(selectedUser.id, normalizedValue, actor);
      syncSelectedUser(updated || { ...selectedUser, creditLimit: normalizedValue });
      setSettingsCreditLimit(String(normalizedValue));
      addToast('تم تحديث حد الدين بنجاح.', 'success');
      await loadUsers({ force: true });
    } catch (error) {
      addToast(error?.message || 'تعذر تحديث حد الدين.', 'error');
    }
  };

  const handleQuantityLimitSave = async () => {
    if (!selectedUser || !canManageUsers) return;
    const quantityLimit = Number(settingsQuantityLimit);
    const used = toFiniteNumber(selectedUser?.quantityUsed ?? selectedUser?.quota?.used, 0);
    if (!Number.isFinite(quantityLimit) || quantityLimit < 0) {
      addToast(isArabic ? 'حد الكمية يجب أن يكون صفرًا أو أكبر.' : 'Quantity limit must be zero or greater.', 'error');
      return;
    }
    if (quantityLimit < used) {
      addToast(isArabic ? 'لا يمكن أن يكون حد الكمية أقل من الكمية المستخدمة.' : 'Quantity limit cannot be below used quantity.', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const quota = normalizeQuota(await apiClient.users.setQuota(selectedUser.id, quantityLimit));
      setSelectedUser((current) => ({ ...current, quantityLimit: quota.limit, quantityUsed: quota.used, quota }));
      setSettingsQuantityLimit(String(quota.limit));
      addToast(isArabic ? 'تم تحديث حد الكمية.' : 'Quantity limit updated.', 'success');
      await loadUsers({ force: true });
    } catch (error) {
      addToast(error?.response?.data?.message || error?.message || (isArabic ? 'تعذر تحديث حد الكمية.' : 'Unable to update quantity limit.'), 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQuantityReset = async () => {
    if (!selectedUser || !canManageUsers) return;
    setIsSubmitting(true);
    try {
      const quota = normalizeQuota(await apiClient.users.resetQuota(selectedUser.id));
      setSelectedUser((current) => ({ ...current, quantityLimit: quota.limit, quantityUsed: quota.used, quota }));
      setSettingsQuantityLimit(String(quota.limit));
      addToast(isArabic ? 'تم تصفير الكمية المستخدمة.' : 'Used quantity reset.', 'success');
      await loadUsers({ force: true });
    } catch (error) {
      addToast(error?.response?.data?.message || error?.message || (isArabic ? 'تعذر تصفير الكمية المستخدمة.' : 'Unable to reset used quantity.'), 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApiAccessToggle = async () => {
    if (!selectedUser) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية تعديل بيانات المستخدمين.', 'error');
      return;
    }

    const nextValue = !Boolean(selectedUser.isApiEnabled);
    try {
      const updated = await updateUserProfile(selectedUser.id, { isApiEnabled: nextValue }, actor);
      syncSelectedUser(updated || { ...selectedUser, isApiEnabled: nextValue });
      addToast(nextValue ? 'تم تفعيل استخدام API لهذا الحساب.' : 'تم تعطيل استخدام API لهذا الحساب.', 'success');
      await loadUsers({ force: true });
    } catch (error) {
      addToast(error?.message || 'تعذر تحديث صلاحية استخدام API.', 'error');
    }
  };

  const handleSettingsTopup = async () => {
    if (!selectedUser || !settingsTopupAmount) return;
    if (!canManageWallet) {
      addToast('ليس لديك صلاحية تعديل أرصدة المحافظ.', 'error');
      return;
    }

    try {
      await updateUserCoins(selectedUser.id, Number(settingsTopupAmount), actor);
      addToast('تم تطبيق الرصيد الإضافي بنجاح.', 'success');
      setSettingsTopupAmount('');
      await Promise.allSettled([
        loadUsers({ force: true }),
        getUserWallet(selectedUser.id, { force: true }),
      ]);
    } catch (error) {
      addToast(error?.message || 'تعذر تطبيق الرصيد الإضافي.', 'error');
    }
  };

  const handleResendVerification = async () => {
    if (!selectedUser?.id) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية تعديل بيانات المستخدمين.', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await resendUserVerification(selectedUser.id);
      addToast(result?.message || 'تمت إعادة إرسال رابط التفعيل.', 'success');
    } catch (error) {
      addToast(error?.message || 'تعذر إعادة إرسال رابط التفعيل.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyToClipboard = async (value) => {
    const text = String(value || '').trim();
    if (!text) return false;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_error) {
      // Fall back to the textarea copy path below.
    }

    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.top = '-9999px';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textArea);
      return copied;
    } catch (_error) {
      return false;
    }
  };

  const handleCopyTemporaryPassword = async () => {
    if (!temporaryPassword) return;
    const copied = await copyToClipboard(temporaryPassword);
    addToast(copied ? 'تم نسخ كلمة المرور.' : 'تعذر نسخ كلمة المرور.', copied ? 'success' : 'error');
  };

  const handleCopyUserId = async (userId) => {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) return;

    const copied = await copyToClipboard(normalizedUserId);
    if (!copied) {
      addToast('تعذر نسخ ID المستخدم.', 'error');
      return;
    }

    setCopiedUserId(normalizedUserId);
    window.setTimeout(() => {
      setCopiedUserId((current) => (current === normalizedUserId ? '' : current));
    }, 1200);
  };

  const handleResetPassword = async () => {
    if (!selectedUser) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية تعديل بيانات المستخدمين.', 'error');
      return;
    }

    try {
      const result = await resetUserPassword(selectedUser.id, actor);
      const generatedPassword = result?.temporaryPassword || '';
      setTemporaryPassword(generatedPassword);
      const copied = await copyToClipboard(generatedPassword);
      addToast(copied ? 'تم إنشاء كلمة مرور مؤقتة ونسخها.' : 'تم إنشاء كلمة مرور مؤقتة.', 'success');
    } catch (error) {
      addToast(error?.message || 'تعذر إعادة تعيين كلمة المرور.', 'error');
    }
  };

  const handleSetPassword = async () => {
    if (!selectedUser) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية تعديل بيانات المستخدمين.', 'error');
      return;
    }
    const nextPassword = String(manualPassword || '').trim();
    if (nextPassword.length < 8) {
      addToast('كلمة المرور يجب أن تكون 8 أحرف على الأقل.', 'error');
      return;
    }

    try {
      const result = await resetUserPassword(selectedUser.id, actor, nextPassword);
      const appliedPassword = result?.temporaryPassword || nextPassword;
      setTemporaryPassword(appliedPassword);
      setManualPassword('');
      const copied = await copyToClipboard(appliedPassword);
      addToast(copied ? 'تم تغيير كلمة المرور ونسخها.' : 'تم تغيير كلمة المرور بنجاح.', 'success');
    } catch (error) {
      addToast(error?.message || 'تعذر تغيير كلمة المرور.', 'error');
    }
  };

  const handleDeleteUser = async () => {
    if (!selectedUser) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية حذف المستخدمين.', 'error');
      return;
    }
    setDeleteConfirmOpen(true);
  };

  const confirmDeleteUser = async () => {
    if (!selectedUser) return;
    try {
      await deleteUser(selectedUser.id, actor);
      addToast('تم حذف المستخدم.', 'success');
      setDeleteConfirmOpen(false);
      setIsDetailsOpen(false);
      setSelectedUser(null);
      await loadUsers({ force: true });
    } catch (error) {
      addToast(error?.message || 'تعذر حذف المستخدم.', 'error');
    }
  };

  const handleRestoreUser = async (entry = selectedUser) => {
    if (!entry?.id) return;
    if (!canManageUsers) {
      addToast('ليس لديك صلاحية استرجاع المستخدمين.', 'error');
      return;
    }

    try {
      await restoreUser(entry.id, actor);
      addToast('تم استرجاع المستخدم بنجاح.', 'success');
      if (selectedUser?.id === entry.id) {
        setIsDetailsOpen(false);
        setSelectedUser(null);
      }
      await Promise.allSettled([
        loadUsers({ force: true }),
        getUserWallet(entry.id, { force: true }),
      ]);
    } catch (error) {
      addToast(error?.message || 'تعذر استرجاع المستخدم.', 'error');
    }
  };

  const selectedWallet = useMemo(
    () => buildWalletPreview(selectedUser, walletByUserId.get(String(selectedUser?.id || '').trim()) || null),
    [selectedUser, walletByUserId]
  );
  const selectedBillingGroup = useMemo(() => (
    (groups || []).find((group) => String(group?.id || group?._id || '') === String(settingsGroup || selectedUser?.groupId || ''))
  ), [groups, selectedUser?.groupId, settingsGroup]);
  const isQuantityOnlyUser = normalizeBillingMode(selectedBillingGroup?.billingMode || selectedUser?.billingMode) === 'quantity_only';
  const selectedQuota = normalizeQuota(selectedUser);
  const canResendVerification = canManageUsers
    && Boolean(selectedUser?.email)
    && (!selectedUser?.verified || isPendingAccountStatus(selectedUser?.status));

  return (
    <div className="min-w-0 space-y-2">
      <section className="admin-premium-hero p-2">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="shrink-0 text-sm font-bold leading-none text-[var(--color-text)]">
            {t('userManagement')}
          </h1>
          <div className="hidden h-4 w-px bg-[color:rgb(var(--color-border-rgb)/0.9)] sm:block" />
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge variant="success" className="h-6 rounded-md px-2 text-[10px]">
              مفعّلة {formatNumber(approvedCount, locale)}
            </Badge>
            <Badge variant="danger" className="h-6 rounded-md px-2 text-[10px]">
              مرفوضة {formatNumber(rejectedCount, locale)}
            </Badge>
            <Badge variant="outline" className="h-6 rounded-md px-2 text-[10px]">
              محذوفة {formatNumber(deletedCount, locale)}
            </Badge>
          </div>
        </div>

        <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_96px] xl:min-w-[22rem]">
          <Input
            placeholder={t('searchUsers')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            icon={<Search className="h-3 w-3" />}
            variant="search"
            className={compactFieldClassName}
          />

          <select
            className={`border border-[color:rgb(var(--color-border-rgb)/0.95)] bg-[color:rgb(var(--color-surface-rgb)/0.88)] text-[var(--color-text)] outline-none transition focus:border-[color:rgb(var(--color-primary-rgb)/0.45)] ${compactFieldClassName}`}
            value={filter}
            onChange={(event) => handleFilterChange(event.target.value)}
          >
            <option value="all">كل الحالات</option>
            <option value="approved">مفعّل</option>
            <option value="rejected">مرفوض</option>
            <option value="deleted">محذوفة</option>
          </select>
        </div>
      </div>
      </section>

      <div className="space-y-2 md:hidden">
        {visibleUsers.map((entry) => {
          const walletPreview = resolveWalletForEntry(entry);
          const balanceValue = getWalletBalanceValue(entry, walletPreview);

          return (
          <Card key={entry.id} variant="elevated" className="overflow-hidden border-[color:rgb(var(--color-primary-rgb)/0.16)] bg-[linear-gradient(145deg,rgb(var(--color-card-rgb)/0.94),rgb(var(--color-surface-rgb)/0.66))] p-2.5 shadow-[0_18px_42px_-36px_rgb(var(--color-primary-rgb)/0.28)]">
            <div className="flex items-start gap-2.5">
              <img
                src={resolveUserAvatar(entry, entry.name || entry.email || 'Dra90n User')}
                alt={entry.name}
                className="h-9 w-9 rounded-xl border border-[color:rgb(var(--color-primary-rgb)/0.22)] object-cover shadow-[0_14px_28px_-24px_rgb(0_0_0/0.82)]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-[var(--color-text)]">{entry.name}</p>
                    <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-secondary)]">{entry.email}</p>
                    <button
                      type="button"
                      className={userIdButtonClassName}
                      title="اضغط لنسخ ID المستخدم"
                      onClick={() => handleCopyUserId(entry.id)}
                    >
                      {copiedUserId === String(entry.id || '').trim() ? 'تم النسخ' : `ID: ${entry.id}`}
                    </button>
                  </div>
                  <span className={`shrink-0 ${getBalanceBadgeTone(balanceValue)}`}>
                    <Wallet className="h-3 w-3" />
                    {formatBalance(entry)}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 border-t border-[color:rgb(var(--color-border-rgb)/0.62)] pt-2">
              <Badge variant={filter === 'deleted' ? 'secondary' : getAccountStatusBadgeVariant(entry.status)}>
                {filter === 'deleted' ? 'محذوف' : getAccountStatusLabel(entry.status, isArabic)}
              </Badge>
              <div className="flex flex-wrap justify-end gap-1.5">
              {filter === 'deleted' && canManageUsers ? (
                <Button size="sm" className={compactButtonClassName} onClick={() => handleRestoreUser(entry)} disabled={isSubmitting}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  استرجاع
                </Button>
              ) : isPendingAccountStatus(entry.status) && canConfirmAccounts && (
                <>
                  <Button size="sm" className={compactButtonClassName} onClick={() => askApprove(entry)} disabled={isSubmitting}>
                    موافقة
                  </Button>
                  <Button size="sm" className={compactButtonClassName} variant="danger" onClick={() => askReject(entry)} disabled={isSubmitting}>
                    رفض
                  </Button>
                </>
              )}
              <Button size="sm" className={compactButtonClassName} variant="outline" onClick={() => openDetails(entry)}>
                <Eye className="h-3.5 w-3.5" />
                عرض التفاصيل
              </Button>
              </div>
            </div>
          </Card>
        )})}

        {!filteredUsers.length && (
          <Card variant="elevated" className="p-6 text-center">
            <p className="text-xs font-semibold text-[var(--color-text)]">لا توجد حسابات مطابقة لهذا الفلتر.</p>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">جرّب توسيع البحث أو تغيير الحالة المحددة.</p>
          </Card>
        )}
      </div>

      <div className="admin-premium-panel hidden overflow-hidden border-[color:rgb(var(--color-primary-rgb)/0.16)] bg-[linear-gradient(180deg,rgb(var(--color-card-rgb)/0.86),rgb(var(--color-surface-rgb)/0.62))] md:block">
        <Table className="border-separate border-spacing-y-1.5 px-1.5 pb-1.5 text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className={compactTableHeadClassName}>المستخدم</TableHead>
              <TableHead className={compactTableHeadClassName}>الحالة</TableHead>
              <TableHead className={compactTableHeadClassName}>
                <span className="inline-flex items-center gap-1">
                  الرصيد
                  <span aria-hidden="true">↓</span>
                </span>
              </TableHead>
              <TableHead className={`text-end ${compactTableHeadClassName}`}>الإجراءات</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleUsers.map((entry) => {
              const walletPreview = resolveWalletForEntry(entry);
              const balanceValue = getWalletBalanceValue(entry, walletPreview);

              return (
              <TableRow key={entry.id} className="overflow-hidden rounded-xl border border-[color:rgb(var(--color-primary-rgb)/0.11)] bg-[color:rgb(var(--color-card-rgb)/0.7)] shadow-[0_12px_30px_-28px_rgb(0_0_0/0.76)] transition-all hover:-translate-y-0.5 hover:bg-[color:rgb(var(--color-card-rgb)/0.9)] hover:shadow-[0_18px_42px_-34px_rgb(var(--color-primary-rgb)/0.24)]">
                <TableCell className={`${compactTableCellClassName} rounded-s-xl py-2`}>
                  <div className="flex items-center gap-2.5">
                    <img
                src={resolveUserAvatar(entry, entry.name || entry.email || 'Dra90n User')}
                      alt={entry.name}
                      className="h-9 w-9 rounded-xl border border-[color:rgb(var(--color-primary-rgb)/0.22)] object-cover shadow-[0_14px_28px_-24px_rgb(0_0_0/0.84)]"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-[var(--color-text)]">{entry.name}</p>
                      <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-secondary)]">{entry.email}</p>
                      <button
                        type="button"
                        className={userIdButtonClassName}
                        title="اضغط لنسخ ID المستخدم"
                        onClick={() => handleCopyUserId(entry.id)}
                      >
                        {copiedUserId === String(entry.id || '').trim() ? 'تم النسخ' : `ID: ${entry.id}`}
                      </button>
                    </div>
                  </div>
                </TableCell>
                <TableCell className={`${compactTableCellClassName} py-2`}>
                  <Badge variant={filter === 'deleted' ? 'secondary' : getAccountStatusBadgeVariant(entry.status)}>
                    {filter === 'deleted' ? 'محذوف' : getAccountStatusLabel(entry.status, isArabic)}
                  </Badge>
                </TableCell>
                <TableCell className={`${compactTableCellClassName} py-2`}>
                  <span className={`min-w-[6.5rem] justify-center ${getBalanceBadgeTone(balanceValue)}`}>
                    {formatBalance(entry)}
                  </span>
                </TableCell>
                <TableCell className={`rounded-e-xl py-2 text-end ${compactTableCellClassName}`}>
                  <div className="flex justify-end gap-1.5">
                    {filter === 'deleted' && canManageUsers ? (
                      <Button size="sm" className={compactButtonClassName} onClick={() => handleRestoreUser(entry)} disabled={isSubmitting}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        استرجاع
                      </Button>
                    ) : isPendingAccountStatus(entry.status) && canConfirmAccounts && (
                      <>
                        <Button size="sm" className={compactButtonClassName} onClick={() => askApprove(entry)} disabled={isSubmitting}>
                          موافقة
                        </Button>
                        <Button size="sm" className={compactButtonClassName} variant="danger" onClick={() => askReject(entry)} disabled={isSubmitting}>
                          رفض
                        </Button>
                      </>
                    )}
                    <Button size="sm" className={`${compactButtonClassName} border-[color:rgb(var(--color-primary-rgb)/0.28)] bg-[color:rgb(var(--color-primary-rgb)/0.08)] text-[var(--color-primary)] hover:bg-[color:rgb(var(--color-primary-rgb)/0.14)]`} variant="outline" onClick={() => openDetails(entry)}>
                      <Eye className="h-3.5 w-3.5" />
                      التفاصيل
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )})}
          </TableBody>
        </Table>
      </div>

      {/* ── Pagination Controls (bottom of users list/table) ───────────────── */}
      <div className="admin-premium-panel mt-2.5 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:rgb(var(--color-border-rgb)/0.78)] bg-[color:rgb(var(--color-card-rgb)/0.84)] px-3 py-2 md:flex-row md:items-center md:justify-between">
          <p className="text-[11px] text-[var(--color-text-secondary)]">
            صفحة {usesServerPagination ? usersPagination.page : safeLocalPage} من {usesServerPagination ? serverPageCount : localPageCount} — إجمالي {usesServerPagination ? usersPagination.total : filteredUsers.length} مستخدم
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className={compactButtonClassName}
              disabled={usesServerPagination ? usersPagination.page <= 1 : safeLocalPage <= 1}
              onClick={() => (usesServerPagination ? loadUsersPage(usersPagination.page - 1) : setLocalPage((page) => Math.max(1, page - 1)))}
            >
              <ChevronRight className="h-3.5 w-3.5" />
              السابق
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={compactButtonClassName}
              disabled={usesServerPagination ? usersPagination.page >= serverPageCount : safeLocalPage >= localPageCount}
              onClick={() => (usesServerPagination ? loadUsersPage(usersPagination.page + 1) : setLocalPage((page) => Math.min(localPageCount, page + 1)))}
            >
              التالي
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
          </div>
      </div>

      <Modal
        isOpen={isDetailsOpen}
        onClose={() => setIsDetailsOpen(false)}
        title={selectedUser ? `بيانات الحساب - ${selectedUser.name}` : 'بيانات الحساب'}
        size="lg"
      >
        <div className="space-y-4">
          <div className="rounded-[var(--radius-lg)] border border-[color:rgb(var(--color-border-rgb)/0.84)] bg-[color:rgb(var(--color-card-rgb)/0.78)] p-3.5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-center gap-2.5">
                <img
                  src={resolveUserAvatar(selectedUser, selectedUser?.name || selectedUser?.email || 'Dra90n User')}
                  alt={selectedUser?.name}
                  className="h-12 w-12 rounded-full border border-[color:rgb(var(--color-border-rgb)/0.84)] object-cover"
                />
                <div>
                  <p className="text-sm font-semibold text-[var(--color-text)]">{selectedUser?.name}</p>
                  <p className="text-xs text-[var(--color-text-secondary)]">{selectedUser?.email}</p>
                  <button
                    type="button"
                    className={userIdButtonClassName}
                    title="اضغط لنسخ ID المستخدم"
                    onClick={() => handleCopyUserId(selectedUser?.id)}
                  >
                    {copiedUserId === String(selectedUser?.id || '').trim() ? 'تم النسخ' : `ID: ${selectedUser?.id}`}
                  </button>
                </div>
              </div>

              <Badge variant={filter === 'deleted' ? 'secondary' : getAccountStatusBadgeVariant(selectedUser?.status)}>
                {filter === 'deleted' ? 'محذوف' : getAccountStatusLabel(selectedUser?.status, isArabic)}
              </Badge>
            </div>

            {isDetailsLoading ? (
              <p className="mt-3 text-[11px] text-[var(--color-text-secondary)]">
                يتم الآن مزامنة الملف الشخصي والمحفظة من السجل المباشر...
              </p>
            ) : null}

            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <div className={`${detailsMetricClassName} ${getDetailsMetricTone(selectedWallet?.walletBalance ?? selectedUser?.coins)}`.trim()}>
                <p className="text-[11px] text-[var(--color-text-secondary)]">الرصيد الحالي</p>
                <p className={`mt-1 text-sm font-semibold ${getBalanceTextTone(selectedWallet?.walletBalance ?? selectedUser?.coins)}`}>
                  {formatWalletAmount(selectedWallet?.walletBalance || 0, selectedWallet?.currency || selectedUser?.currency || 'USD')}
                </p>
              </div>
              <div className={detailsMetricClassName}>
                <p className="text-[11px] text-[var(--color-text-secondary)]">حد الدين</p>
                <p className="mt-1 text-sm font-semibold text-[var(--color-text)]">
                  {formatWalletAmount(toFiniteNumber(selectedUser?.creditLimit, 0), selectedWallet?.currency || selectedUser?.currency || 'USD')}
                </p>
              </div>
              <div className={detailsMetricClassName}>
                <p className="text-[11px] text-[var(--color-text-secondary)]">حالة البريد</p>
                <p className="mt-1 text-sm font-semibold text-[var(--color-text)]">
                  {selectedUser?.verified ? 'مؤكد' : 'غير مؤكد'}
                </p>
              </div>
              <div className={detailsMetricClassName}>
                <p className="text-[11px] text-[var(--color-text-secondary)]">عمليات المحفظة</p>
                <p className="mt-1 text-sm font-semibold text-[var(--color-text)]">
                  {formatNumber(selectedWallet?.transactionsCount || 0, locale)}
                </p>
              </div>
              <div className={detailsMetricClassName}>
                <p className="text-[11px] text-[var(--color-text-secondary)]">آخر حركة</p>
                <p className="mt-1 text-xs font-semibold text-[var(--color-text)]">
                  {selectedWallet?.lastTransactionAt ? formatDate(selectedWallet.lastTransactionAt) : 'لا توجد حركة بعد'}
                </p>
              </div>
            </div>

            {selectedWallet?.recentTransactions?.[0] ? (
              <div className="mt-3 rounded-[var(--radius-md)] border border-[color:rgb(var(--color-primary-rgb)/0.16)] bg-[linear-gradient(135deg,rgba(255,248,220,0.34),rgba(255,255,255,0.04))] p-2.5">
                <p className="text-[11px] text-[var(--color-text-secondary)]">آخر عملية محفوظة بالمحفظة</p>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-[var(--color-text)]">
                      {selectedWallet.recentTransactions[0]?.description || 'Wallet activity'}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">
                      {formatDate(selectedWallet.recentTransactions[0]?.createdAt)}
                    </p>
                  </div>
                  <span className={getBalanceBadgeTone(selectedWallet.recentTransactions[0]?.signedAmount ?? selectedWallet.recentTransactions[0]?.amount ?? 0)}>
                    <Wallet className="h-3 w-3" />
                    {formatWalletAmount(
                      selectedWallet.recentTransactions[0]?.signedAmount ?? selectedWallet.recentTransactions[0]?.amount ?? 0,
                      selectedWallet.recentTransactions[0]?.currency || selectedWallet?.currency || selectedUser?.currency || 'USD',
                      { signed: true }
                    )}
                  </span>
                </div>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap justify-end gap-1.5">
              {canViewWallet && filter !== 'deleted' && selectedUser?.id ? (
                <Button
                  type="button"
                  variant="outline"
                  className={`${compactButtonClassName} border-[color:rgb(var(--color-primary-rgb)/0.28)] text-[var(--color-primary)]`}
                  onClick={() => navigate(`/admin/wallet?userId=${encodeURIComponent(selectedUser.id)}`)}
                >
                  <Eye className="h-3.5 w-3.5" />
                  المحفظة والسجل
                </Button>
              ) : null}
              {canResendVerification ? (
                <Button variant="ghost" className={compactButtonClassName} onClick={handleResendVerification} disabled={isSubmitting}>
                  <MailCheck className="h-3.5 w-3.5" />
                  إعادة إرسال التفعيل
                </Button>
              ) : null}
            </div>

            <div className="mt-3 grid gap-2.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <p className="text-[11px] text-[var(--color-text-secondary)]">طريقة التسجيل</p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--color-text)]">
                  {getSignupMethodLabel(selectedUser?.signupMethod || selectedUser?.authProvider, isArabic)}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-secondary)]">تاريخ التسجيل</p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--color-text)]">
                  {formatDate(getUserRegistrationDate(selectedUser))}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-secondary)]">المجموعة</p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--color-text)]">{selectedUser?.group || '-'}</p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-secondary)]">العملة</p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--color-text)]">{selectedUser?.currency || '-'}</p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-secondary)]">حد الدين</p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--color-text)]">
                  {formatWalletAmount(toFiniteNumber(selectedUser?.creditLimit, 0), selectedWallet?.currency || selectedUser?.currency || 'USD')}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-secondary)]">اسم المستخدم</p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--color-text)]">{selectedUser?.username || '-'}</p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-secondary)]">الهاتف</p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--color-text)]">{selectedUser?.phone || '-'}</p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-secondary)]">حالة التحقق</p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--color-text)]">{selectedUser?.verified ? 'مفعل' : 'بانتظار التأكيد'}</p>
              </div>
            </div>
          </div>

          {canConfirmAccounts && filter !== 'deleted' && (isPendingAccountStatus(selectedUser?.status) || isApprovedAccountStatus(selectedUser?.status) || isRejectedAccountStatus(selectedUser?.status)) && (
            <div className="rounded-[var(--radius-lg)] border border-[color:rgb(var(--color-border-rgb)/0.84)] p-3.5">
              <p className="text-xs font-semibold text-[var(--color-text)]">قرار التفعيل</p>
              <p className="mt-1 text-xs leading-6 text-[var(--color-text-secondary)]">
                اعتماد أو رفض الحساب مع تحديث حالته فورًا في النظام.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(isPendingAccountStatus(selectedUser?.status) || isRejectedAccountStatus(selectedUser?.status)) && (
                  <Button className={compactButtonClassName} onClick={() => askApprove(selectedUser)} disabled={isSubmitting}>
                    موافقة على الحساب
                  </Button>
                )}
                {(isPendingAccountStatus(selectedUser?.status) || isApprovedAccountStatus(selectedUser?.status)) && (
                  <Button className={compactButtonClassName} variant="danger" onClick={handleStatusToggleFromDetails} disabled={isSubmitting}>
                    رفض الحساب
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
              <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[color:rgb(var(--color-border-rgb)/0.84)] bg-[color:rgb(var(--color-elevated-rgb)/0.5)] p-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-[var(--color-text)]">السماح باستخدام الـ API</p>
                  <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-secondary)]">Enable API Access</p>
                </div>
                <button
                  type="button"
                  onClick={handleApiAccessToggle}
                  disabled={!canManageUsers}
                  aria-pressed={Boolean(selectedUser?.isApiEnabled)}
                  className={`relative h-6 w-11 shrink-0 rounded-full border transition ${
                    selectedUser?.isApiEnabled
                      ? 'border-emerald-400/35 bg-emerald-500'
                      : 'border-[color:rgb(var(--color-border-rgb)/0.9)] bg-[color:rgb(var(--color-surface-rgb)/0.75)]'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <span
                    className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow transition ${
                      selectedUser?.isApiEnabled ? 'left-6' : 'left-1'
                    }`}
                  />
                </button>
              </div>

            {isQuantityOnlyUser && (
              <div className="space-y-3 rounded-[var(--radius-lg)] border border-[color:rgb(var(--color-primary-rgb)/0.28)] bg-[color:rgb(var(--color-primary-rgb)/0.05)] p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-[var(--color-text)]">{isArabic ? 'إدارة كمية المستخدم' : 'User quota management'}</p>
                  <Badge variant="secondary">{isArabic ? 'كمية فقط' : 'Quantity only'}</Badge>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                  <div className={detailsMetricClassName}><span className="text-[var(--color-text-secondary)]">{isArabic ? 'الحد' : 'Limit'}</span><p className="font-semibold">{formatNumber(selectedQuota.limit, locale)}</p></div>
                  <div className={detailsMetricClassName}><span className="text-[var(--color-text-secondary)]">{isArabic ? 'المستخدم' : 'Used'}</span><p className="font-semibold">{formatNumber(selectedQuota.used, locale)}</p></div>
                  <div className={detailsMetricClassName}><span className="text-[var(--color-text-secondary)]">{isArabic ? 'المتبقي' : 'Remaining'}</span><p className="font-semibold">{formatNumber(selectedQuota.remaining, locale)}</p></div>
                </div>
                <Input
                  label={isArabic ? 'حد الكمية' : 'Quantity limit'}
                  type="number"
                  min="0"
                  step="1"
                  value={settingsQuantityLimit}
                  onChange={(event) => setSettingsQuantityLimit(event.target.value)}
                  className="h-10 px-3 text-xs"
                  disabled={!canManageUsers || isSubmitting}
                />
                <div className="flex gap-2">
                  <Button className={`flex-1 ${compactButtonClassName}`} onClick={handleQuantityLimitSave} disabled={!canManageUsers || isSubmitting}>
                    {isArabic ? 'حفظ حد الكمية' : 'Save quantity limit'}
                  </Button>
                  <Button variant="outline" className={`flex-1 ${compactButtonClassName}`} onClick={handleQuantityReset} disabled={!canManageUsers || isSubmitting || selectedQuota.used <= 0}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    {isArabic ? 'تصفير المستخدم' : 'Reset used'}
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-2.5 rounded-[var(--radius-lg)] border border-[color:rgb(var(--color-border-rgb)/0.84)] p-3.5">
              <p className="text-xs font-semibold text-[var(--color-text)]">المجموعة والعملة</p>

              <div className="space-y-2">
                <label className="text-[11px] text-[var(--color-text-secondary)]">المجموعة</label>
                <div className="flex gap-1.5">
                  <select
                    className="h-10 flex-1 rounded-[var(--radius-md)] border border-[color:rgb(var(--color-border-rgb)/0.92)] bg-[color:rgb(var(--color-card-rgb)/0.94)] px-3 text-xs text-[var(--color-text)] outline-none transition focus:border-[color:rgb(var(--color-primary-rgb)/0.45)]"
                    value={settingsGroup}
                    onChange={(event) => setSettingsGroup(event.target.value)}
                    disabled={!canManageUsers}
                  >
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name} ({group.discount ?? group.percentage ?? 0}%)
                      </option>
                    ))}
                  </select>
                  <Button variant="outline" className={compactButtonClassName} onClick={handleSettingsGroupSave} disabled={!canManageUsers}>
                    حفظ
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] text-[var(--color-text-secondary)]">العملة</label>
                <div className="flex gap-1.5">
                  <select
                    className="h-10 flex-1 rounded-[var(--radius-md)] border border-[color:rgb(var(--color-border-rgb)/0.92)] bg-[color:rgb(var(--color-card-rgb)/0.94)] px-3 text-xs text-[var(--color-text)] outline-none transition focus:border-[color:rgb(var(--color-primary-rgb)/0.45)]"
                    value={settingsCurrency}
                    onChange={(event) => setSettingsCurrency(event.target.value)}
                    disabled={!canManageUsers}
                  >
                    {(currencies || []).map((currencyItem) => (
                      <option key={currencyItem.code} value={currencyItem.code}>
                        {currencyItem.code} - {currencyItem.name}
                      </option>
                    ))}
                  </select>
                  <Button variant="outline" className={compactButtonClassName} onClick={handleSettingsCurrencySave} disabled={!canManageUsers}>
                    حفظ
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] text-[var(--color-text-secondary)]">حد الدين</label>
                <div className="flex gap-1.5">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={settingsCreditLimit}
                    onChange={(event) => setSettingsCreditLimit(event.target.value)}
                    placeholder="0.00"
                    className="h-10 flex-1 px-3 text-xs"
                    disabled={!canManageUsers}
                  />
                  <Button variant="outline" className={compactButtonClassName} onClick={handleSettingsCreditLimitSave} disabled={!canManageUsers}>
                    حفظ
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-2.5 rounded-[var(--radius-lg)] border border-[color:rgb(var(--color-border-rgb)/0.84)] p-3.5">
              <div className="flex items-center gap-1.5">
                <Wallet className="h-3.5 w-3.5 text-[var(--color-primary)]" />
                <p className="text-xs font-semibold text-[var(--color-text)]">الرصيد وكلمة المرور</p>
              </div>

              <Input
                label="إضافة رصيد"
                type="number"
                min="0.01"
                step="0.01"
                value={settingsTopupAmount}
                onChange={(event) => setSettingsTopupAmount(event.target.value)}
                placeholder="100.00"
                className="h-10 px-3 text-xs"
                disabled={!canManageWallet}
              />
              <Button onClick={handleSettingsTopup} className={`w-full ${compactButtonClassName}`} disabled={!canManageWallet}>
                إضافة الرصيد
              </Button>

              <Input
                label="تعيين كلمة مرور جديدة"
                type="text"
                value={manualPassword}
                onChange={(event) => setManualPassword(event.target.value)}
                placeholder="أدخل كلمة مرور جديدة (8 أحرف على الأقل)"
                className="h-10 px-3 text-xs font-mono"
              />
              <Button variant="outline" onClick={handleSetPassword} className={`w-full ${compactButtonClassName}`} disabled={!canManageUsers || !String(manualPassword || '').trim()}>
                تعيين كلمة المرور
              </Button>
              <p className="text-xs text-[var(--color-text-secondary)]">يمكنك تعيين كلمة مرور مباشرة لأي حساب من هنا.</p>

              <div className="rounded-[var(--radius-md)] bg-[color:rgb(var(--color-surface-rgb)/0.68)] p-2.5">
                <p className="text-xs leading-6 text-[var(--color-text-secondary)]">
                  إعادة تعيين كلمة المرور ستُنشئ كلمة مرور مؤقتة جديدة لهذا المستخدم.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <Button variant="outline" className={compactButtonClassName} onClick={handleResetPassword} disabled={!canManageUsers}>
                    <KeyRound className="h-3.5 w-3.5" />
                    إعادة تعيين كلمة المرور
                  </Button>
                </div>
                {temporaryPassword && (
                  <>
                    <Input
                      label="كلمة المرور المؤقتة"
                      readOnly
                      value={temporaryPassword}
                      onClick={handleCopyTemporaryPassword}
                      onFocus={(event) => event.target.select()}
                      title="اضغط لنسخ كلمة المرور"
                      className="mt-2.5 h-10 cursor-copy px-3 text-xs"
                    />
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)]">اضغط على كلمة المرور لنسخها</p>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-1.5 border-t border-[color:rgb(var(--color-border-rgb)/0.84)] pt-3">
            <Button variant="ghost" className={compactButtonClassName} onClick={() => setIsDetailsOpen(false)}>
              إغلاق
            </Button>
            {filter === 'deleted' && canManageUsers ? (
              <Button className={compactButtonClassName} onClick={() => handleRestoreUser(selectedUser)}>
                <RotateCcw className="h-3.5 w-3.5" />
                استرجاع الحساب
              </Button>
            ) : filter !== 'deleted' && canManageUsers ? (
              <Button variant="danger" className={compactButtonClassName} onClick={handleDeleteUser}>
                حذف المستخدم
              </Button>
            ) : null}
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isApproveModalOpen}
        onClose={() => {
          if (isSubmitting) return;
          setIsApproveModalOpen(false);
          setApproveTarget(null);
        }}
        title={approveTarget ? `تفعيل الحساب - ${approveTarget.name}` : 'تفعيل الحساب'}
        size="md"
      >
        <div className="space-y-3">
          <p className="text-xs leading-6 text-[var(--color-text-secondary)]">
            قبل تفعيل الحساب، يجب تحديد المجموعة وحد الدين والعملة. لن يتمكن العميل من دخول الموقع إلا بعد التفعيل.
          </p>

          <div className="space-y-2">
            <label className="text-[11px] text-[var(--color-text-secondary)]">المجموعة</label>
            <select
              className="h-10 w-full rounded-[var(--radius-md)] border border-[color:rgb(var(--color-border-rgb)/0.92)] bg-[color:rgb(var(--color-card-rgb)/0.94)] px-3 text-xs text-[var(--color-text)] outline-none transition focus:border-[color:rgb(var(--color-primary-rgb)/0.45)]"
              value={approveGroup}
              onChange={(event) => setApproveGroup(event.target.value)}
            >
              {(groups || []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} ({group.discount ?? group.percentage ?? 0}%)
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-[11px] text-[var(--color-text-secondary)]">العملة</label>
            <select
              className="h-10 w-full rounded-[var(--radius-md)] border border-[color:rgb(var(--color-border-rgb)/0.92)] bg-[color:rgb(var(--color-card-rgb)/0.94)] px-3 text-xs text-[var(--color-text)] outline-none transition focus:border-[color:rgb(var(--color-primary-rgb)/0.45)]"
              value={approveCurrency}
              onChange={(event) => setApproveCurrency(event.target.value)}
            >
              {(currencies || []).map((currencyItem) => (
                <option key={currencyItem.code} value={currencyItem.code}>
                  {currencyItem.code} - {currencyItem.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-[11px] text-[var(--color-text-secondary)]">حد الدين</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={approveCreditLimit}
              onChange={(event) => setApproveCreditLimit(event.target.value)}
              placeholder="0.00"
              className="h-10 px-3 text-xs"
            />
          </div>

          <div className="flex justify-end gap-1.5">
            <Button
              variant="outline"
              className={compactButtonClassName}
              onClick={() => {
                if (isSubmitting) return;
                setIsApproveModalOpen(false);
                setApproveTarget(null);
              }}
              disabled={isSubmitting}
            >
              إلغاء
            </Button>
            <Button
              className={compactButtonClassName}
              onClick={confirmApprove}
              disabled={isSubmitting}
            >
              تفعيل الحساب
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isRejectModalOpen}
        onClose={() => setIsRejectModalOpen(false)}
        title="تأكيد رفض الحساب"
        footer={(
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" className={compactButtonClassName} onClick={() => setIsRejectModalOpen(false)}>
              إلغاء
            </Button>
            <Button variant="danger" className={compactButtonClassName} onClick={confirmReject} disabled={isSubmitting}>
              تأكيد الرفض
            </Button>
          </div>
        )}
      >
        <p className="text-sm leading-7 text-[var(--color-text-secondary)]">
          هل أنت متأكد من رفض حساب <span className="font-semibold text-[var(--color-text)]">{rejectTarget?.name}</span>؟
          سيتم منعه من الوصول إلى الصفحات المحمية حتى تتم إعادة تفعيله يدويًا من الإدارة.
        </p>
      </Modal>

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="حذف المستخدم"
        description={selectedUser ? `هل تريد حذف ${selectedUser.name || selectedUser.email || 'هذا المستخدم'}؟` : ''}
        confirmLabel="حذف"
        cancelLabel="إلغاء"
        onConfirm={confirmDeleteUser}
        onCancel={() => setDeleteConfirmOpen(false)}
        isLoading={isSubmitting}
      />
    </div>
  );
};

export default AdminUsers;
